# ═══════════════════════════════════════════════════════════════════════════════
# storage.py — local on-disk play history (no cookies, no Google account involved)
# ═══════════════════════════════════════════════════════════════════════════════
#
# "Recently Played" is OUR history, not YouTube's. Every track the user plays in
# THIS app is appended here and survives restarts. We deliberately don't sync with
# YouTube's server-side history — that would need broad-access session cookies, and
# a personal desktop player only needs to remember what *it* played.
#
# Stored as a single JSON file in the per-user app-data dir:
#   Windows : %APPDATA%\YouTubeMusic\history.json
#   macOS   : ~/Library/Application Support/YouTubeMusic/history.json
#   Linux   : $XDG_DATA_HOME (or ~/.local/share)/YouTubeMusic/history.json
#
# Dedupe-to-top, like YT Music: replaying a song moves it to the front rather than
# adding a duplicate. Capped at _MAX entries so the file stays small.

import json
import os
import sys
import threading
import time
from pathlib import Path

_LOCK = threading.Lock()
_MAX = 200  # keep the most recent N distinct tracks


def _data_dir() -> Path:
    if sys.platform == "win32":
        base = os.getenv("APPDATA") or os.path.expanduser("~")
    elif sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    else:
        base = os.getenv("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    d = Path(base) / "YouTubeMusic"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _history_path() -> Path:
    return _data_dir() / "history.json"


def _load() -> list:
    try:
        data = json.loads(_history_path().read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception:
        # Corrupt/unreadable file — start fresh rather than crash the endpoint.
        return []


def _save(items: list) -> None:
    # Atomic write: serialise to a temp file, then replace — a crash mid-write can
    # never leave a half-written history.json.
    path = _history_path()
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def record_play(track: dict) -> None:
    """Record that `track` was just played. Moves it to the top if already present."""
    vid = (track or {}).get("videoId")
    if not vid:
        return
    entry = {
        "videoId": vid,
        "title": track.get("title"),
        "artists": track.get("artists") or [],
        "thumbnails": track.get("thumbnails") or [],
        "playedAt": int(time.time()),
    }
    with _LOCK:
        items = [it for it in _load() if it.get("videoId") != vid]
        items.insert(0, entry)
        del items[_MAX:]
        _save(items)


def get_history() -> list:
    """Most-recent-first list of previously played tracks."""
    with _LOCK:
        return _load()


def clear_history() -> None:
    with _LOCK:
        _save([])
