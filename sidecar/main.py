# ═══════════════════════════════════════════════════════════════════════════════
# main.py — Python sidecar for YouTube Music Desktop
# ═══════════════════════════════════════════════════════════════════════════════
#
# This is a small HTTP API server that runs alongside the Tauri desktop app.
# The Rust backend (lib.rs) starts this process on app launch and kills it
# when the app closes.
#
# WHY A SEPARATE PYTHON PROCESS?
#   Python has two excellent libraries for YouTube Music that don't exist in Rust:
#     - ytmusicapi: talks to YouTube Music's internal (InnerTube) API.
#       Gives us search results, playlists, liked songs, history, etc.
#     - yt-dlp: extracts the actual audio stream URL for any track.
#       This is how NewPipe works too — get the raw CDN URL, play it directly.
#
# HOW IT'S STRUCTURED:
#   Each route in this file is one "endpoint". The React frontend calls these
#   endpoints using regular fetch() — same as calling any REST API.
#
# INTERACTIVE DOCS:
#   When the sidecar is running, open http://127.0.0.1:34785/docs in your
#   browser. FastAPI generates a full interactive API explorer automatically!
#   You can test every endpoint there without writing any code.
#
# ═══════════════════════════════════════════════════════════════════════════════

import argparse
import asyncio
import hmac
import json
import os
import re
import threading
import time
import traceback
import urllib.request
import urllib.parse
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# Our own modules (in the same sidecar/ folder)
import auth
import youtube_music
import youtube_data
import storage
import data
import stream as stream_module

# ── Localhost auth token ────────────────────────────────────────────────────────
#
# The sidecar binds 127.0.0.1 only, but ANY local process (or a malicious web page
# via a localhost fetch) could still hit it. To close that hole, Rust generates a
# random per-launch bearer token and passes it via `--auth-token`. Every request
# (except /health) must then present `Authorization: Bearer <token>`.
#
# When launched WITHOUT a token (e.g. `python main.py` during dev), enforcement is
# disabled so the manual dev workflow stays friction-free. The shipped Tauri app
# always passes a token, so the distributed build is always protected.
_AUTH_TOKEN: Optional[str] = None

# Paths that never require the bearer token (readiness probe + CORS preflight).
_OPEN_PATHS = {"/health"}

# Host header must be loopback — blocks DNS-rebinding attacks where a remote page
# resolves an attacker domain to 127.0.0.1 and tries to drive the sidecar.
_ALLOWED_HOST_PREFIXES = ("127.0.0.1", "localhost")

# ── App setup ──────────────────────────────────────────────────────────────────

app = FastAPI(
    title="YouTube Music Sidecar",
    description="Internal API server for YouTube Music Desktop app.",
    version="0.1.0",
)


@app.middleware("http")
async def _localhost_guard(request: Request, call_next):
    """Reject non-loopback Host headers and unauthenticated requests.

    Order matters: this runs INSIDE the CORS middleware (added later, so CORS is
    outermost and still answers preflight). We let OPTIONS and the open paths
    through, then require a constant-time-compared bearer token for everything else.
    """
    # Anti DNS-rebind: the Host header must target loopback.
    host = (request.headers.get("host") or "").split(":")[0]
    if host and not host.startswith(_ALLOWED_HOST_PREFIXES):
        return JSONResponse({"detail": "Invalid host"}, status_code=400)

    # CORS preflight and open paths bypass the token check.
    if request.method == "OPTIONS" or request.url.path in _OPEN_PATHS:
        return await call_next(request)

    if _AUTH_TOKEN is not None:
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        # hmac.compare_digest avoids leaking the token via timing differences.
        if scheme.lower() != "bearer" or not hmac.compare_digest(token, _AUTH_TOKEN):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)

    return await call_next(request)


# CORS (Cross-Origin Resource Sharing):
# The React frontend runs at http://localhost:1420 (Vite dev server).
# By default, browsers block requests from one origin to another.
# This middleware tells the browser: "yes, requests from these origins are allowed."
# Added AFTER the guard above so it wraps it (outermost) and handles preflight first.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:1420",       # Vite dev server
        "tauri://localhost",           # Tauri production (Windows)
        "https://tauri.localhost",     # Tauri production (macOS/Linux)
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── SECTION 1: Health check ────────────────────────────────────────────────────
#
# The React app polls this endpoint every second until it gets a 200 response.
# That's how it knows the sidecar has fully started and is ready to accept requests.

@app.get("/health")
async def health():
    return {"status": "ok", "service": "youtube-music-sidecar"}


# ── SECTION 2: Authentication ──────────────────────────────────────────────────
#
# YouTube Music has two modes:
#   - Guest mode: search and play any track — no login needed.
#   - Authenticated mode: access your playlists, liked songs, history.
#
# We use Google OAuth (via ytmusicapi) — the user approves in their browser,
# and the token is saved locally. After that, all API calls are authenticated.

@app.get("/auth/status")
async def auth_status():
    """Returns whether the user is currently logged in."""
    return {"authenticated": auth.is_authenticated()}


class _SessionIn(BaseModel):
    access_token: str
    refresh_token: str
    expires_at: int
    client_id: str
    client_secret: str


@app.post("/auth/session")
async def set_session(body: _SessionIn):
    """
    Install the authenticated session. Called ONLY by the Rust shell after the
    OAuth (PKCE) flow or a token refresh — never by the browser/frontend. Builds
    an in-memory, self-refreshing ytmusicapi client; no token is written to disk.
    (Bearer-token protected by the localhost guard, like every non-/health route.)
    """
    auth.set_session(
        body.access_token, body.refresh_token, body.expires_at,
        body.client_id, body.client_secret,
    )
    return {"ok": True}


@app.delete("/auth/session")
async def clear_session():
    """Tear down the authenticated session (sign out / token revoked)."""
    auth.clear_session()
    return {"ok": True}


class _CookieIn(BaseModel):
    cookie: str


@app.post("/auth/ytmusic-cookie")
async def set_ytmusic_cookie(body: _CookieIn):
    """
    Install the YouTube Music session cookie (from the in-app login window, via Rust).
    Returns IMMEDIATELY — the ytmusicapi browser client is built lazily on first use, so
    this request never holds a slow InnerTube call on the wire (which was getting the
    localhost connection reset on Windows). Verify separately via the /test endpoint.
    """
    auth.set_ytmusic_cookie(body.cookie)
    return {"ok": True}


@app.get("/auth/ytmusic-cookie/test")
async def test_ytmusic_cookie():
    """
    Verify the installed cookie with ONE authenticated InnerTube call (builds the browser
    client on first use). Returns {ok, playlistCount} or {ok: False, error}. This is the
    spike's proof that the embedded-login cookie unlocks the private API.
    """
    if not auth.has_ytmusic_cookie():
        return {"ok": False, "error": "No YouTube Music cookie is installed."}

    def _test():
        yt = auth.get_ytmusic(authenticated=True)
        pls = yt.get_library_playlists(limit=1)
        return {"ok": True, "playlistCount": len(pls) if isinstance(pls, list) else None}
    try:
        return await asyncio.get_event_loop().run_in_executor(None, _test)
    except Exception as e:
        traceback.print_exc()
        return {"ok": False, "error": str(e)}


@app.delete("/auth/ytmusic-cookie")
async def clear_ytmusic_cookie():
    """Disconnect the YT Music session (clears the in-memory browser client and the
    personalized home cache, so no stale feed can survive into the next account)."""
    auth.clear_ytmusic_cookie()
    _clear_home_cache()
    return {"ok": True}


@app.get("/auth/ytmusic-cookie")
async def ytmusic_cookie_status():
    """Whether a working YT Music session cookie is currently installed."""
    return {"connected": auth.has_ytmusic_cookie()}


# ── SECTION 3: Search and Discovery ───────────────────────────────────────────
#
# These endpoints work without login — they use YouTube Music's public data.

@app.get("/search")
async def search(
    q: str = Query(..., min_length=1, description="Search query"),
    filter: Optional[str] = Query(
        None,
        description="Filter results: songs | albums | artists | playlists",
        pattern="^(songs|albums|artists|playlists)?$",
    ),
):
    """
    Search YouTube Music.
    Example: GET /search?q=bohemian+rhapsody&filter=songs
    Returns a list of matching tracks, albums, or artists.
    """
    try:
        results = await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_music.search(q, filter)
        )
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/search/suggestions")
async def search_suggestions(
    q: str = Query(..., min_length=1, description="Partial query to autocomplete"),
):
    """
    Return autocomplete suggestions for the given partial query.
    Called on every keystroke (debounced in the frontend).
    Example: GET /search/suggestions?q=bohemi  →  ["bohemian rhapsody", ...]
    """
    try:
        results = await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_music.get_search_suggestions(q)
        )
        return {"suggestions": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Home-page disk cache ───────────────────────────────────────────────────────
# The personalized home (InnerTube) takes 1-3 s on first fetch. Cache the last
# response to disk so re-opens return instantly; a background thread refreshes
# while the user is already reading the home feed.
_HOME_CACHE_PATH = os.path.join(
    os.getenv("APPDATA", os.path.expanduser("~")),
    "YouTubeMusic", "home_cache.json"
)
_HOME_CACHE_TTL = 300  # 5 minutes
_home_refreshing = False
_home_refresh_lock = threading.Lock()


# The cache is keyed on `authed` (whether the personalized/cookie feed was used).
# This is the crucial correctness guard: on startup the frontend fires a GUEST
# /home (before the cookie restores) AND a personalized one. Caching by auth mode
# means a guest response can NEVER be served to a personalized request — and old
# caches lacking the "authed" field are treated as a miss, so they self-heal.
def _load_home_cache(authed: bool) -> list | None:
    try:
        with open(_HOME_CACHE_PATH, "r", encoding="utf-8") as f:
            cached = json.load(f)
        if (cached.get("authed") == authed
                and time.time() - cached.get("_ts", 0) < _HOME_CACHE_TTL):
            return cached.get("shelves")
    except Exception:
        pass
    return None


def _save_home_cache(shelves: list, authed: bool) -> None:
    try:
        os.makedirs(os.path.dirname(_HOME_CACHE_PATH), exist_ok=True)
        with open(_HOME_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump({"_ts": time.time(), "authed": authed, "shelves": shelves}, f)
    except Exception:
        pass


def _clear_home_cache() -> None:
    try:
        os.remove(_HOME_CACHE_PATH)
    except Exception:
        pass


def _bg_refresh_home() -> None:
    """Refresh the personalized home cache in the background. Only ever caches the
    authenticated feed — and re-reads the cookie state itself so it can't write a
    guest response into the personalized slot."""
    global _home_refreshing
    with _home_refresh_lock:
        if _home_refreshing:
            return
        _home_refreshing = True
    try:
        if auth.has_ytmusic_cookie():
            shelves = youtube_music.get_home(authenticated=True)
            if shelves:
                _save_home_cache(shelves, authed=True)
    except Exception:
        pass
    finally:
        _home_refreshing = False


@app.get("/home")
async def home():
    """
    Fetches the YouTube Music home page — trending music, new releases, etc.
    Returns a list of "shelves", each with a title and a list of tracks.
    When a YT Music session cookie is active, checks the disk cache first (5-min
    TTL) and returns instantly while refreshing in the background.
    """
    # Snapshot the auth mode ONCE and use it for both the fetch and the cache
    # decision, so a cookie restore landing mid-request can't mislabel the result.
    authed = auth.has_ytmusic_cookie()
    if authed:
        cached = _load_home_cache(authed=True)
        if cached is not None:
            threading.Thread(target=_bg_refresh_home, daemon=True).start()
            return {"shelves": cached}
    try:
        data = await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_music.get_home(authenticated=authed)
        )
        # Only the personalized feed is cached; the guest feed never touches disk.
        if authed and data:
            threading.Thread(target=lambda: _save_home_cache(data, authed=True), daemon=True).start()
        return {"shelves": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── SECTION 4: Track and Playlist info ────────────────────────────────────────

@app.get("/playlist/{playlist_id}")
async def get_playlist(playlist_id: str):
    """
    Get all tracks in a playlist.
    Works for both your own playlists and any public playlist.
    """
    try:
        data = await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_music.get_playlist(playlist_id)
        )
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── SECTION 5: Stream URL extraction ──────────────────────────────────────────
#
# This is the core of the NewPipe approach.
# Instead of loading YouTube's web player (which serves ads), we call YouTube's
# InnerTube API directly via yt-dlp to get the raw audio CDN URL, then play it.
#
# No ads. No YouTube JS player. Just a direct HTTPS audio stream.

def _find_alternative(title: str, artist: str, exclude_id: str) -> Optional[str]:
    """When a track's original video is gone (deleted/private/region-blocked), find
    another upload of the same song by searching title + artist. Returns a different
    videoId, or None. This is what YouTube Music does internally for dead tracks."""
    query = f"{title} {artist}".strip()
    if not query:
        return None
    try:
        for r in youtube_music.search(query, "songs"):
            vid = r.get("videoId")
            if vid and vid != exclude_id:
                return vid
    except Exception:
        pass
    return None


@app.get("/stream/{video_id}")
async def get_stream(
    video_id: str,
    title: str = Query("", description="Track title — used to find an alternative if the video is gone"),
    artist: str = Query("", description="Artist name — used with title for the fallback search"),
):
    """
    Extract the best available audio stream URL for a track.

    Returns a direct HTTPS URL to YouTube's CDN — the React <audio> tag plays
    this URL without any intermediate server.

    If the original video is unavailable and a title is provided, we search for an
    alternative upload of the same song and stream that (response adds "fallback": true).
    """
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, lambda: stream_module.get_stream_url(video_id))
    except Exception as original_err:
        alt = await loop.run_in_executor(None, lambda: _find_alternative(title, artist, video_id))
        if alt:
            try:
                data = await loop.run_in_executor(None, lambda: stream_module.get_stream_url(alt))
                data["videoId"] = alt
                data["fallback"] = True
                return data
            except Exception:
                pass
        raise HTTPException(
            status_code=502,
            detail="This track is unavailable on YouTube and no alternative was found.",
        ) from original_err


# ── SECTION 6: Personal Library (requires login) ───────────────────────────────

@app.get("/library/artists")
async def library_artists():
    """The signed-in user's library artists. Requires the YT Music session cookie."""
    if not auth.has_ytmusic_cookie():
        raise HTTPException(status_code=409, detail="Connect YouTube Music to see your library artists.")
    try:
        data = await asyncio.get_event_loop().run_in_executor(
            None, youtube_music.get_library_artists
        )
        return {"artists": data}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/library/albums")
async def library_albums():
    """The signed-in user's saved albums. Requires the YT Music session cookie."""
    if not auth.has_ytmusic_cookie():
        raise HTTPException(status_code=409, detail="Connect YouTube Music to see your library albums.")
    try:
        data = await asyncio.get_event_loop().run_in_executor(
            None, youtube_music.get_library_albums
        )
        return {"albums": data}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/library/liked")
async def library_liked():
    """
    The user's liked songs. With a YT Music session cookie connected we return the REAL
    YT Music "Liked Music" via InnerTube; otherwise we fall back to the Data API likes
    playlist (music-filtered). Requires authentication.
    """
    if not auth.is_authenticated():
        raise HTTPException(status_code=401, detail="Not authenticated. Please sign in.")
    fn = youtube_music.get_liked_songs if auth.has_ytmusic_cookie() else youtube_data.get_liked_songs
    try:
        return await asyncio.get_event_loop().run_in_executor(None, fn)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/library/history")
async def library_history():
    """
    Recently played. With the YT Music cookie connected we return your account's real
    (cross-device) listening history via InnerTube; otherwise our local on-disk history.
    """
    use_innertube = auth.has_ytmusic_cookie()
    try:
        if use_innertube:
            data = await asyncio.get_event_loop().run_in_executor(None, youtube_music.get_history)
        else:
            data = await asyncio.get_event_loop().run_in_executor(None, storage.get_history)
        return {"history": data}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


class _PlayIn(BaseModel):
    videoId: str
    title: Optional[str] = None
    artists: Optional[list] = None
    thumbnails: Optional[list] = None


@app.post("/history")
async def record_history(body: _PlayIn):
    """Record a play in the local history file (dedupe-to-top). No auth needed."""
    try:
        await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: storage.record_play({
                "videoId": body.videoId, "title": body.title,
                "artists": body.artists, "thumbnails": body.thumbnails,
            }),
        )
        return {"ok": True}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/library/history")
async def clear_history():
    """Clear the local play history."""
    try:
        await asyncio.get_event_loop().run_in_executor(None, storage.clear_history)
        return {"ok": True}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ── SECTION 6f: Compliant first-login record (Supabase, via Edge Functions) ────
#
# The signed-in user's account record + data-subject rights. All privileged DB
# access is brokered by Supabase Edge Functions (data.py) that verify the Google
# token — the app never holds the service_role key. See docs/plans/phase2-auth.md.

@app.get("/signups/open")
async def signups_open():
    """{open, count} — whether a NEW account can still register under the ≤100 cap."""
    return await asyncio.get_event_loop().run_in_executor(None, data.signups_open)


@app.post("/me/first-login")
async def me_first_login():
    """
    Idempotent first-login record write. Called once after the user sees the
    pre-sign-in notice and signs in. Resolves coarse location on-device.
    """
    if not auth.is_authenticated():
        raise HTTPException(status_code=401, detail="Not authenticated.")
    token = auth.get_access_token()
    if not token:
        raise HTTPException(status_code=401, detail="No access token.")
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: data.record_first_login(token)
        )
        if result.get("error") == "signups_full":
            raise HTTPException(status_code=403, detail="Sign-ups are full.")
        return result
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/me/data")
async def me_data_export():
    """Data-subject access: the caller's own stored first-login row."""
    if not auth.is_authenticated():
        raise HTTPException(status_code=401, detail="Not authenticated.")
    token = auth.get_access_token()
    if not token:
        raise HTTPException(status_code=401, detail="No access token.")
    try:
        return await asyncio.get_event_loop().run_in_executor(
            None, lambda: data.get_my_data(token)
        )
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/me/data")
async def me_data_erase():
    """Data-subject erasure: hard-delete the caller's row. (Frontend also logs out.)"""
    if not auth.is_authenticated():
        raise HTTPException(status_code=401, detail="Not authenticated.")
    token = auth.get_access_token()
    if not token:
        raise HTTPException(status_code=401, detail="No access token.")
    try:
        return await asyncio.get_event_loop().run_in_executor(
            None, lambda: data.delete_my_data(token)
        )
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ── SECTION 6e: YouTube Data API — your real playlists (OAuth works here) ──────
#
# Unlike the private InnerTube API (ytmusicapi), the official Data API accepts our
# OAuth token. Used for the signed-in user's playlists + their tracks.

@app.get("/yt/playlists")
async def yt_playlists():
    """The signed-in user's YouTube playlists (incl. music playlists), via the Data API."""
    if not auth.is_authenticated():
        raise HTTPException(status_code=401, detail="Not authenticated. Please sign in.")
    try:
        data = await asyncio.get_event_loop().run_in_executor(
            None, youtube_data.list_playlists
        )
        return {"playlists": data}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/yt/playlist/{playlist_id}")
async def yt_playlist(playlist_id: str):
    """Tracks in one of the user's playlists, via the Data API."""
    if not auth.is_authenticated():
        raise HTTPException(status_code=401, detail="Not authenticated. Please sign in.")
    try:
        tracks = await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_data.get_playlist_items(playlist_id)
        )
        return {"tracks": tracks}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


class _AddItem(BaseModel):
    videoId: str


@app.post("/yt/playlist/{playlist_id}/items")
async def yt_playlist_add(playlist_id: str, body: _AddItem):
    """Add a video to one of the user's playlists (reflects on YouTube + YT Music)."""
    if not auth.is_authenticated():
        raise HTTPException(status_code=401, detail="Not authenticated. Please sign in.")
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_data.add_to_playlist(playlist_id, body.videoId)
        )
        return {"ok": True, "playlistItemId": result.get("id")}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/yt/playlist/items/{item_id}")
async def yt_playlist_remove(item_id: str):
    """Remove an item from a playlist by its playlistItem id."""
    if not auth.is_authenticated():
        raise HTTPException(status_code=401, detail="Not authenticated. Please sign in.")
    try:
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_data.remove_from_playlist(item_id)
        )
        return {"ok": True}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ── SECTION 6b: Explore — Charts ──────────────────────────────────────────────

@app.get("/explore/charts")
async def explore_charts(
    country: str = Query("ZZ", description="ISO country code; ZZ = Global"),
):
    """
    Returns music charts for a given country (default: Global).
    Response contains 'trending', 'videos', 'songs' sections with ranked tracks.
    """
    try:
        data = await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_music.get_charts(country)
        )
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── SECTION 6c: Artist page ───────────────────────────────────────────────────

@app.get("/artist/{channel_id}")
async def get_artist_page(channel_id: str):
    """
    Returns artist page data: top songs, albums, singles, related artists, thumbnails.
    channel_id is the YouTube Music artist browse ID (e.g. "UCxxxxxx").
    """
    try:
        data = await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_music.get_artist(channel_id)
        )
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── SECTION 6c-2: Album / single page ─────────────────────────────────────────

@app.get("/album/{browse_id}")
async def get_album_page(browse_id: str):
    """
    Returns an album (or single/EP) with its full track list.
    browse_id is the album browse ID from an artist's album/single card
    (e.g. "MPREb_xxxxx"). Works without login.
    """
    try:
        data = await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_music.get_album(browse_id)
        )
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── SECTION 6d: Related tracks ────────────────────────────────────────────────

@app.get("/related/{video_id}")
async def get_related(video_id: str):
    """
    Returns radio-style related tracks for a given video ID.
    Uses YouTube Music's watch playlist (radio=True) — same queue YouTube
    builds when you play a song. Works without login.
    """
    try:
        tracks = await asyncio.get_event_loop().run_in_executor(
            None, lambda: youtube_music.get_related(video_id)
        )
        return {"tracks": tracks}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _clean_title(t: str) -> str:
    return re.sub(
        r'\s*[\(\[](Official\s+(?:Audio|Video|Music\s+Video|Lyric(?:s)?\s+Video)|'
        r'Audio|Lyrics?|HD|4K|Visualizer|ft\.?[^\)\]]*|feat\.?[^\)\]]*)[)\]]\s*',
        '', t, flags=re.IGNORECASE
    ).strip()

def _clean_artist(a: str) -> str:
    return re.sub(r'\s*-\s*Topic\s*$', '', a, flags=re.IGNORECASE).strip()


# Tokens that don't carry identity meaning — dropped before comparing titles/artists.
_STOPWORDS = {
    "a", "an", "the", "and", "of", "in", "on", "to", "for", "with",
    "feat", "ft", "vs", "remix", "remaster", "remastered", "version",
    "live", "edit", "mix", "mono", "stereo",
}

def _tokenize(s: str) -> set[str]:
    s = re.sub(r"[^\w\s]", " ", (s or "").lower())
    return {w for w in s.split() if w and w not in _STOPWORDS and len(w) > 1}

def _match_score(a: str, b: str) -> float:
    """Token Jaccard similarity. 1.0 = same set of words; 0.0 = no overlap."""
    sa, sb = _tokenize(a), _tokenize(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _lrclib_search(track_name: str, artist_name: str, *,
                   verify_title: str = "", verify_artist: str = "") -> dict:
    """Query lrclib and pick the best result that ACTUALLY matches the song.

    lrclib's API is a fuzzy text search — when your song isn't in the database
    it will happily return a completely different song as the top hit (e.g.
    searching "Wild and Blue / John Anderson" returns "Wild Blue / John Mayer").
    We verify both title and artist tokens overlap before accepting a result;
    if nothing passes verification we return {} so the next source can try.

    verify_title/verify_artist let the caller search with one phrasing but
    compare against another (e.g. title-only retry that still checks artist).
    """
    vt = verify_title or track_name
    va = verify_artist or artist_name
    try:
        params = urllib.parse.urlencode({"track_name": track_name, "artist_name": artist_name})
        req = urllib.request.Request(
            f"https://lrclib.net/api/search?{params}",
            headers={"User-Agent": "YouTubeMusicDesktop/1.0"})
        # lrclib is sometimes slow from non-EU networks; 10s gives it a fair shot
        # before we fall through to lyrics.ovh.
        with urllib.request.urlopen(req, timeout=10) as resp:
            results = json.loads(resp.read().decode())
        if not isinstance(results, list):
            return {}
        best, best_score = None, 0.0
        for r in results:
            if not (r.get("syncedLyrics") or r.get("plainLyrics")):
                continue
            t = _match_score(vt, r.get("trackName", ""))
            a = _match_score(va, r.get("artistName", "")) if va else 1.0
            if t < 0.5 or a < 0.5:
                continue
            # Prefer synced lyrics; among synced, pick the closest match.
            score = (10 if r.get("syncedLyrics") else 0) + t + a
            if score > best_score:
                best_score, best = score, r
        return best or {}
    except Exception:
        return {}


def _lyricsovh(artist: str, title: str) -> str | None:
    try:
        url = f"https://api.lyrics.ovh/v1/{urllib.parse.quote(artist, safe='')}/{urllib.parse.quote(title, safe='')}"
        req = urllib.request.Request(url, headers={"User-Agent": "YouTubeMusicDesktop/1.0"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode())
        lyrics = (data.get("lyrics") or "").strip()
        return lyrics or None
    except Exception:
        return None


@app.get("/lyrics")
async def get_lyrics(
    title: str = Query(..., min_length=1, description="Track title"),
    artist: str = Query("", description="Artist name"),
    video_id: str = Query("", description="YouTube video ID — used for YT Music lyrics fallback"),
):
    """
    Lyrics search across three sources (in order):
      1. lrclib.net  — synced LRC lyrics, great English / K-pop / J-pop coverage.
      2. lyrics.ovh  — plain text, broader language coverage, free & no key.
      3. YouTube Music native — via ytmusicapi (limited but covers some licensed songs).
    """
    clean_t = _clean_title(title)
    clean_a = _clean_artist(artist)

    try:
        # ── Source 1: lrclib (synced LRC preferred, match-verified) ───────────
        # Every variant of the query verifies the response against (clean_t, clean_a)
        # so a fuzzy lrclib match for a different song never leaks through.
        data = _lrclib_search(clean_t, clean_a,
                              verify_title=clean_t, verify_artist=clean_a)
        if not data and clean_a:
            data = _lrclib_search(clean_t, "",
                                  verify_title=clean_t, verify_artist=clean_a)
        if not data and (clean_t != title or clean_a != artist):
            data = _lrclib_search(title, artist,
                                  verify_title=clean_t, verify_artist=clean_a)
        if data.get("syncedLyrics") or data.get("plainLyrics"):
            return {"syncedLyrics": data.get("syncedLyrics"), "plainLyrics": data.get("plainLyrics")}

        # ── Source 2: lyrics.ovh (plain text, broader coverage) ───────────────
        ovh = _lyricsovh(clean_a or artist, clean_t)
        if ovh:
            return {"syncedLyrics": None, "plainLyrics": ovh}

        # ── Source 3: YouTube Music native ────────────────────────────────────
        if video_id:
            yt_data = youtube_music.get_yt_lyrics(video_id)
            if yt_data.get("plainLyrics"):
                return yt_data

        return {"syncedLyrics": None, "plainLyrics": None}

    except Exception:
        return {"syncedLyrics": None, "plainLyrics": None}


# ── SECTION 7: Downloads ───────────────────────────────────────────────────────
#
# yt-dlp can also download tracks to disk. Same library, different mode.
# The downloaded file is M4A (AAC audio in an MP4 container) —
# preserves the original quality with no re-encoding loss.
# Album art and metadata (title, artist, album) are embedded automatically.

@app.post("/download/{video_id}")
async def download(
    video_id: str,
    output_dir: str = Query(..., description="Folder to save the file, e.g. C:/Music"),
):
    """
    Download a track to disk as an M4A file.
    Saves to: output_dir/Artist - Title.m4a
    Metadata (title, artist, album art) is embedded automatically by yt-dlp.
    """
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: stream_module.download_track(video_id, output_dir)
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Entry point ────────────────────────────────────────────────────────────────
#
# When Rust spawns this file with `python main.py --port 34785`, execution
# starts here. We parse the port argument and start the uvicorn server.
# uvicorn is a fast async HTTP server — the same one used in production by
# companies running FastAPI apps.

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="YouTube Music sidecar API server")
    parser.add_argument("--port", type=int, default=34785, help="Port to listen on")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (127.0.0.1 = localhost only)")
    parser.add_argument("--auth-token", default=None,
                        help="Bearer token required on every request (except /health). "
                             "Omit during dev to disable enforcement.")
    args = parser.parse_args()

    # Activate the localhost auth guard when Rust supplies a token.
    if args.auth_token:
        _AUTH_TOKEN = args.auth_token

    print(f"Sidecar starting on http://{args.host}:{args.port}")
    print(f"API docs: http://{args.host}:{args.port}/docs")
    print(f"Auth guard: {'ENABLED' if _AUTH_TOKEN else 'disabled (dev)'}")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
