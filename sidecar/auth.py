# ═══════════════════════════════════════════════════════════════════════════════
# auth.py — in-memory Google session fed by the Rust shell
# ═══════════════════════════════════════════════════════════════════════════════
#
# The Rust shell runs the Google OAuth 2.0 (PKCE) flow, stores the refresh token
# in the OS keychain, and pushes the current token bundle to this sidecar via
# POST /auth/session. We build a *self-refreshing* ytmusicapi client from that
# bundle and hold it in memory — no OAuth token is ever written to disk here.
#
#   set_session(...)  ← Rust pushes {access, refresh, expires_at, client_id/secret}
#   get_ytmusic()     → authenticated YTMusic when a session exists, else anonymous
#   clear_session()   ← sign out / token revoked
#
# GUEST MODE (no session): search, home, track info and stream URLs all work with
# the anonymous client. Only personal-library endpoints need a session.
# ═══════════════════════════════════════════════════════════════════════════════

import json
import threading
import time
import urllib.parse
import urllib.request
from typing import Optional

from ytmusicapi import YTMusic, OAuthCredentials

# ytmusicapi labels the token with the YouTube scope. Our access token was granted
# a superset (openid email profile + youtube); it is still valid for YouTube, and
# this field is only metadata on the token object.
_YT_SCOPE = "https://www.googleapis.com/auth/youtube"

_LOCK = threading.Lock()
_SESSION: Optional[dict] = None      # {access_token, refresh_token, expires_at, client_id, client_secret}
_YT_AUTH: Optional[YTMusic] = None   # cached OAuth client (Data API; InnerTube rejects it)

# YouTube Music session-cookie auth — the ONLY thing the private InnerTube API accepts.
# Set by the Rust shell after the user signs into music.youtube.com in the in-app login
# window; unlocks the personalized home, library artists/albums, real liked songs and
# history. Held in memory here; the raw cookie is persisted by Rust in the OS keychain.
_COOKIE_RAW: Optional[str] = None    # raw cookie string (source of truth)
_YT_COOKIE: Optional[YTMusic] = None  # lazily-built browser-auth client
_BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def set_session(access_token: str, refresh_token: str, expires_at: int,
                client_id: str, client_secret: str) -> None:
    """Install/replace the authenticated session pushed by the Rust shell."""
    global _SESSION, _YT_AUTH
    with _LOCK:
        _SESSION = {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_at": int(expires_at or 0),
            "client_id": client_id,
            "client_secret": client_secret,
        }
        _YT_AUTH = None  # force a rebuild on next get_ytmusic()


def clear_session() -> None:
    """Drop the authenticated session — back to guest mode."""
    global _SESSION, _YT_AUTH
    with _LOCK:
        _SESSION = None
        _YT_AUTH = None


def is_authenticated() -> bool:
    """True when an authenticated session is installed."""
    return _SESSION is not None


# ── YouTube Music session-cookie (browser auth) ──────────────────────────────────

def _build_cookie_client(cookie: str) -> YTMusic:
    """Build a ytmusicapi BROWSER-auth client from a raw Google cookie string.
    ytmusicapi recognises browser auth by an `authorization: SAPISIDHASH …` header,
    which we compute from the cookie's __Secure-3PAPISID (it recomputes per request)."""
    from ytmusicapi.helpers import sapisid_from_cookie, get_authorization
    sapisid = sapisid_from_cookie(cookie)
    authorization = get_authorization(sapisid + " " + "https://music.youtube.com")
    headers = {
        "cookie": cookie,
        "authorization": authorization,
        "x-goog-authuser": "0",
        "user-agent": _BROWSER_UA,
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
        "x-origin": "https://music.youtube.com",
    }
    return YTMusic(headers)


def set_ytmusic_cookie(cookie: str) -> None:
    """Store the YT Music session cookie. The browser-auth client is built LAZILY on the
    first authenticated call (get_ytmusic) — so installing the cookie is instant and the
    /auth/ytmusic-cookie request returns fast (no slow InnerTube calls held on the wire)."""
    global _COOKIE_RAW, _YT_COOKIE
    with _LOCK:
        _COOKIE_RAW = cookie
        _YT_COOKIE = None  # rebuilt on next get_ytmusic()


def clear_ytmusic_cookie() -> None:
    global _COOKIE_RAW, _YT_COOKIE
    with _LOCK:
        _COOKIE_RAW = None
        _YT_COOKIE = None


def has_ytmusic_cookie() -> bool:
    """True when a YT Music session cookie is installed (InnerTube unlocked)."""
    return _COOKIE_RAW is not None


def get_access_token() -> Optional[str]:
    """
    Return a valid Google access token for YouTube **Data API** calls, refreshing
    it via the stored refresh token if it's expired. (The Data API accepts our
    OAuth token — unlike the private InnerTube API.) Returns None if not signed in.
    """
    with _LOCK:
        s = _SESSION
        if not s:
            return None
        # Still valid (60s safety margin)?
        if s.get("expires_at") and time.time() < s["expires_at"] - 60:
            return s["access_token"]
        rt, cid, csec = s.get("refresh_token"), s.get("client_id"), s.get("client_secret")

    if not rt:
        return None
    try:
        data = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "client_id": cid,
            "client_secret": csec,
        }).encode()
        req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
        with urllib.request.urlopen(req, timeout=10) as resp:
            tok = json.loads(resp.read().decode())
        new_access = tok.get("access_token")
        if not new_access:
            return None
        with _LOCK:
            if _SESSION:
                _SESSION["access_token"] = new_access
                _SESSION["expires_at"] = int(time.time()) + int(tok.get("expires_in", 3600))
        return new_access
    except Exception:
        with _LOCK:
            return _SESSION["access_token"] if _SESSION else None


def get_ytmusic(authenticated: bool = True) -> YTMusic:
    """
    Return a YTMusic client.

    authenticated=True → prefer the cookie/browser client (real InnerTube access:
    personalized home, library, likes, history). If no cookie, fall back to the OAuth
    client (works for non-InnerTube paths only). authenticated=False → anonymous.
    """
    global _YT_AUTH, _YT_COOKIE
    if authenticated:
        with _LOCK:
            if _COOKIE_RAW is not None:       # browser/cookie auth — full InnerTube
                if _YT_COOKIE is None:
                    _YT_COOKIE = _build_cookie_client(_COOKIE_RAW)  # built on first use
                return _YT_COOKIE
            if _SESSION is None:
                return YTMusic()
            if _YT_AUTH is None:
                _YT_AUTH = YTMusic(
                    {
                        "scope": _YT_SCOPE,
                        "token_type": "Bearer",
                        "access_token": _SESSION["access_token"],
                        "refresh_token": _SESSION["refresh_token"],
                        "expires_at": _SESSION["expires_at"],
                        "expires_in": 3600,
                    },
                    oauth_credentials=OAuthCredentials(
                        _SESSION["client_id"], _SESSION["client_secret"]
                    ),
                )
            return _YT_AUTH
    return YTMusic()
