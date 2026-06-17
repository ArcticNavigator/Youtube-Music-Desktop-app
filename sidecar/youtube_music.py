# ═══════════════════════════════════════════════════════════════════════════════
# youtube_music.py — YouTube Music data layer (ytmusicapi)
# ═══════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS FILE DOES:
#   Wraps ytmusicapi — a Python library that talks directly to YouTube Music's
#   internal InnerTube API (the same API YouTube's own apps use).
#
# HOW IT WORKS (the NewPipe approach for desktop):
#   YouTube's InnerTube API lives at https://music.youtube.com/youtubei/v1/
#   ytmusicapi calls it with the right headers and request format — no official
#   API key needed, no rate limits, same data the official app sees.
#
# TWO MODES:
#   - Public functions (search, home, get_playlist, get_album, get_artist):
#     Work without any login. These hit YouTube's public InnerTube endpoints.
#
#   - Library functions (get_library_artists/albums, get_liked_songs, get_history):
#     Require the YouTube Music session cookie (installed via the in-app login).
#     get_ytmusic(authenticated=True) returns the cookie client when one is present.
# ═══════════════════════════════════════════════════════════════════════════════

from auth import get_ytmusic, has_ytmusic_cookie


# ── Thumbnail fallback ────────────────────────────────────────────────────────
#
# ytmusicapi's search/home/etc. responses occasionally omit the `thumbnails`
# array for some tracks. We fill that gap with YouTube's standard CDN thumbnail
# URL — `i.ytimg.com/vi/{videoId}/{quality}.jpg` works for ANY YouTube video,
# so any track with a videoId is guaranteed an image. Run this on every list
# of results before returning to the frontend.

def _yt_thumb(video_id: str, size: int = 320) -> list[dict]:
    return [
        {"url": f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg", "width": 320, "height": 180},
        {"url": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg", "width": 480, "height": 360},
    ]

def _ensure_thumbnails(items) -> object:
    """Walk a list of result dicts and fill in missing thumbnails using each
    item's videoId. Returns the input unchanged so it can be used inline.

    Some ytmusicapi endpoints return the field as `thumbnails` (search,
    get_playlist) and others as `thumbnail` (get_watch_playlist tracks).
    We normalise to `thumbnails` on every dict so the frontend has one
    consistent shape.
    """
    if not isinstance(items, list):
        return items
    for item in items:
        if not isinstance(item, dict):
            continue
        if not item.get("thumbnails"):
            # Promote a singular `thumbnail` (used by watch-playlist tracks)
            singular = item.get("thumbnail")
            if isinstance(singular, list) and singular:
                item["thumbnails"] = singular
        if not item.get("thumbnails"):
            vid = item.get("videoId")
            if vid:
                item["thumbnails"] = _yt_thumb(vid)
    return items


# ── Public endpoints (no login required) ──────────────────────────────────────

def search(query: str, filter_type: str = None) -> list[dict]:
    """
    Search YouTube Music for songs, albums, artists, or playlists.

    filter_type: "songs" | "albums" | "artists" | "playlists" | None (all)

    Returns a list of result objects. Each object has:
      - videoId (for tracks), playlistId, browseId
      - title, artists, album, duration, thumbnails
    """
    yt = get_ytmusic(authenticated=False)
    try:
        return _ensure_thumbnails(yt.search(query, filter=filter_type, limit=20))
    except Exception:
        return []


def get_home(authenticated: bool | None = None) -> list[dict]:
    """
    Fetch the YouTube Music home page.

    Returns a list of "shelves" — each shelf is a section like
    "Trending", "New releases", "Recommended for you", etc.
    Each shelf has a title and a list of track/album cards.

    `authenticated` chooses the feed explicitly (the caller snapshots the cookie
    state once, so a restore landing mid-request can't swap guest↔personalized).
    When None, falls back to the live cookie state.
    """
    # limit = minimum shelves to gather (ytmusicapi pages via continuations). 10 yields
    # ~8 rich shelves. When a YT Music session cookie is connected we use the AUTHENTICATED
    # home — the real personalized feed ("for you", "album for you", recently-played mixes,
    # heard in shorts, etc.). Without it, the public/guest feed (still rich).
    if authenticated is None:
        authenticated = has_ytmusic_cookie()
    yt = get_ytmusic(authenticated=authenticated)
    shelves = yt.get_home(limit=10)
    # Fill missing thumbnails for every track across every shelf
    for shelf in shelves or []:
        if isinstance(shelf, dict):
            _ensure_thumbnails(shelf.get("contents"))
    return shelves


def get_search_suggestions(query: str) -> list[str]:
    """
    Get autocomplete suggestions for a partial search query.
    Called as the user types — returns up to ~10 suggestion strings.
    Works without login (uses YouTube's public suggestion endpoint).
    """
    yt = get_ytmusic(authenticated=False)
    try:
        results = yt.get_search_suggestions(query)
        # ytmusicapi returns List[str] by default; normalise just in case
        return [r if isinstance(r, str) else str(r) for r in results]
    except Exception:
        return []


def get_playlist(playlist_id: str) -> dict:
    """
    Get all tracks in a playlist.
    Works for public playlists and your own playlists (when logged in).
    Returns title, description, author, and a list of tracks.
    """
    yt = get_ytmusic(authenticated=False)
    pl = yt.get_playlist(playlist_id, limit=100)
    if isinstance(pl, dict):
        _ensure_thumbnails(pl.get("tracks"))
    return pl


# ── Authenticated endpoints (require the YT Music session cookie) ──────────────
#
# These call get_ytmusic(authenticated=True), which prefers the cookie/browser
# client (full InnerTube access). If no session is installed, ytmusicapi raises —
# the caller (main.py) catches that and returns 401/409.

def get_library_artists() -> list[dict]:
    """Artists in the signed-in user's library. Needs the YT Music session cookie
    (InnerTube); the OAuth token alone can't reach this."""
    yt = get_ytmusic(authenticated=True)
    items = yt.get_library_artists(limit=100) or []
    # ytmusicapi names the field `artist`; mirror it to `title` so the frontend renders
    # library artists with the same card markup as search/related artists.
    for it in items:
        if isinstance(it, dict) and not it.get("title") and it.get("artist"):
            it["title"] = it["artist"]
    return _ensure_thumbnails(items)


def get_library_albums() -> list[dict]:
    """Albums saved to the signed-in user's library. Needs the YT Music session cookie."""
    yt = get_ytmusic(authenticated=True)
    return _ensure_thumbnails(yt.get_library_albums(limit=100))


def get_liked_songs() -> dict:
    """Returns the 'Liked Songs' playlist (up to 100 tracks)."""
    yt = get_ytmusic(authenticated=True)
    liked = yt.get_liked_songs(limit=100)
    if isinstance(liked, dict):
        _ensure_thumbnails(liked.get("tracks"))
    return liked


def get_history() -> list[dict]:
    """Returns the user's recently played tracks."""
    yt = get_ytmusic(authenticated=True)
    return _ensure_thumbnails(yt.get_history())


def get_charts(country: str = "ZZ") -> dict:
    """
    Returns music charts. country='ZZ' means Global.
    Returns dict with 'videos', 'trending' etc., each with 'items' list.
    Works without login.
    """
    yt = get_ytmusic(authenticated=False)
    try:
        return yt.get_charts(country=country)
    except Exception:
        return {}


def get_related(video_id: str) -> list[dict]:
    """
    Returns a radio-style list of tracks related to video_id.
    Uses ytmusicapi's watch playlist with radio=True — same tracks YouTube
    puts in the "Up Next" queue when you play a song.
    """
    yt = get_ytmusic(authenticated=False)
    try:
        result = yt.get_watch_playlist(videoId=video_id, radio=True)
        return _ensure_thumbnails(result.get("tracks", []))
    except Exception:
        return []


def get_yt_lyrics(video_id: str) -> dict:
    """
    Fetch lyrics from YouTube Music's own lyrics database via ytmusicapi.
    YouTube Music sources lyrics from LyricFind / other providers and has
    broad coverage including regional/non-English songs.

    Returns { "plainLyrics": str | None, "syncedLyrics": None }
    (YouTube Music returns plain text only — no LRC timestamps).
    """
    yt = get_ytmusic(authenticated=False)
    try:
        watch = yt.get_watch_playlist(videoId=video_id)
        browse_id = watch.get("lyrics")
        if not browse_id:
            return {"plainLyrics": None, "syncedLyrics": None}
        data = yt.get_lyrics(browse_id)
        return {
            "plainLyrics": data.get("lyrics"),
            "syncedLyrics": None,
        }
    except Exception:
        return {"plainLyrics": None, "syncedLyrics": None}


def get_album(browse_id: str) -> dict:
    """
    Returns an album's (or single's/EP's) metadata and full track list.
    browse_id: the album browse ID (e.g. "MPREb_xxxxx") — this is what the
    `browseId` of an artist's album/single card holds.
    Returns: { title, type, year, artists, thumbnails, trackCount, duration,
               audioPlaylistId, tracks: [ {videoId, title, artists, ...} ] }
    Album tracks share the album cover and carry no per-track thumbnail, so we
    fill each track's thumbnails from its videoId (i.ytimg fallback). The album
    cover itself is on the top-level `thumbnails`.
    Works without login.
    """
    yt = get_ytmusic(authenticated=False)
    try:
        data = yt.get_album(browseId=browse_id)
        if isinstance(data, dict):
            _ensure_thumbnails(data.get("tracks"))
        return data
    except Exception:
        return {"title": "", "tracks": []}


def get_artist(channel_id: str) -> dict:
    """
    Returns full artist page data for a YouTube Music artist.
    channel_id: the browse ID (e.g. "UCxxxxxx" or "MPLAxxxxxx")
    Returns: { name, channelId, description, subscribers, thumbnails,
               songs: { browseId, results },
               albums: { browseId, results },
               singles: { browseId, results },
               related: { results } }
    Works without login.
    """
    yt = get_ytmusic(authenticated=False)
    try:
        data = yt.get_artist(channelId=channel_id)
        # Normalise thumbnails on every nested result list so the frontend
        # always sees `thumbnails` (never just `thumbnail`) and songs with
        # a videoId get a guaranteed i.ytimg.com fallback URL. Albums,
        # singles, and related artists keep whatever the API returned —
        # they have no videoId, so missing thumbnails will be rendered as
        # a CSS placeholder on the frontend instead of a broken image.
        if isinstance(data, dict):
            for key in ("songs", "albums", "singles", "related"):
                section = data.get(key)
                if isinstance(section, dict):
                    _ensure_thumbnails(section.get("results"))
        return data
    except Exception:
        return {"name": "", "channelId": channel_id}
