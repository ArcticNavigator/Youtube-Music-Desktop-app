# ═══════════════════════════════════════════════════════════════════════════════
# stream.py — Audio stream extraction and downloading via yt-dlp
# ═══════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS FILE DOES:
#   Two things, both using yt-dlp:
#     1. get_stream_url() — returns a direct CDN URL so the audio can be played
#        in real-time, exactly like streaming (no downloading involved).
#     2. download_track() — saves the audio to a file on disk with full metadata.
#
# HOW yt-dlp WORKS (the NewPipe approach):
#   YouTube's InnerTube API returns an encrypted stream manifest.
#   yt-dlp decrypts it and extracts the direct HTTPS URL to the audio file
#   on YouTube's CDN (e.g. https://rr1---sn-....googlevideo.com/...).
#   We give that URL directly to the HTML5 <audio> tag — YouTube's CDN serves
#   the bytes, no YouTube player JS runs, no ads are delivered.
#
# AUDIO QUALITY:
#   yt-dlp uses "bestaudio" which picks the highest quality stream available:
#   - Free accounts / no login: ~128 kbps AAC or Opus
#   - YouTube Music Premium:    256 kbps AAC (selected automatically when available)
#
# CLIENT SPOOFING:
#   We tell yt-dlp to use the "android_music" InnerTube client first.
#   This is the same trick NewPipe uses. The Android Music client sometimes
#   returns higher quality streams than the web client.
# ═══════════════════════════════════════════════════════════════════════════════

import os
import subprocess
import time
import threading
import yt_dlp

# Null logger — yt-dlp's `quiet` + `no_warnings` flags do NOT suppress
# format-selection errors, which spam stderr every time the fast path
# misses (expected for ~5-10 % of YT Music tracks). Routing all yt-dlp
# log output through a no-op logger keeps the console clean while still
# letting the Python exception path drive retries.
class _NullLogger:
    def debug(self, msg): pass
    def info(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass

_NULL_LOGGER = _NullLogger()

# Shared base options (no client-specific settings here).
# We keep TLS certificate verification ON (yt-dlp's default): disabling it to shave a
# few ms would expose stream extraction to man-in-the-middle tampering of the CDN URL.
_BASE_YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "logger": _NULL_LOGGER,
    "socket_timeout": 8,        # tighter timeout — fail fast
    "youtube_include_dash_manifest": False,  # skip DASH manifest fetch (saves a roundtrip)
    "youtube_include_hls_manifest": False,
}

# ── ffmpeg resolution ─────────────────────────────────────────────────────────
# Only the download path uses ffmpeg (audio extraction + metadata + cover art);
# stream-URL extraction never touches it. ffmpeg ships via the `imageio-ffmpeg` pip
# package, which PyInstaller freezes into the sidecar — so packaged builds find it
# with no system install and no separate ffprobe needed.
# An explicit override (set_ffmpeg_location) wins; otherwise we use imageio-ffmpeg's
# binary, else fall back to ffmpeg on PATH.
_ffmpeg_override: "str | None" = None


def set_ffmpeg_location(path: str) -> None:
    """Override the ffmpeg binary/dir (e.g. a path the Rust shell passes in)."""
    global _ffmpeg_override
    if path:
        _ffmpeg_override = path


def _resolve_ffmpeg() -> "str | None":
    """Absolute path to an ffmpeg binary, or None to let yt-dlp search PATH."""
    if _ffmpeg_override:
        return _ffmpeg_override
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


# ── In-process stream URL cache ────────────────────────────────────────────────
# YouTube CDN URLs are signed and remain valid for ~6 hours.
# Caching them in-process eliminates the yt-dlp round-trip entirely on repeat
# plays (e.g. user clicks the same track again, or restarts mid-track).
_URL_CACHE: dict[str, tuple[dict, float]] = {}
_URL_CACHE_LOCK = threading.Lock()
_URL_TTL = 5 * 3600  # 5 hours (safe margin under the ~6h CDN signature lifetime)


def _cache_get(video_id: str) -> dict | None:
    with _URL_CACHE_LOCK:
        entry = _URL_CACHE.get(video_id)
        if not entry:
            return None
        data, expiry = entry
        if time.time() > expiry:
            _URL_CACHE.pop(video_id, None)
            return None
        return data


def _cache_set(video_id: str, data: dict) -> None:
    with _URL_CACHE_LOCK:
        _URL_CACHE[video_id] = (data, time.time() + _URL_TTL)

# Fast path: ios + android, both skip JS/webpage (~0.5-1 s per request).
# Two clients raise the hit rate — if ios fails for a YT Music-only ID,
# android often succeeds without needing the full slow-path chain.
_FAST_EXTRACTOR = {
    "youtube": {
        "player_client": ["android_music", "ios", "android"],
        "player_skip": ["js", "webpage"],
    }
}

# Slow path: music-specific clients first, then general fallbacks.
# Used when the fast path raises "Requested format is not available" —
# typically YouTube Music-only IDs (lp-XXXXX), age-gated tracks, or videos
# where the ios client returns no audio-only formats. The music clients
# (web_music, ios_music, android_music) match what the official YT Music
# app uses and reliably return AAC/Opus audio streams for music content.
_SLOW_EXTRACTOR = {
    "youtube": {
        "player_client": [
            "web_music", "ios_music", "android_music",
            "tv_embedded", "ios", "android", "web",
        ],
    }
}


def get_stream_url(video_id: str) -> dict:
    """
    Extract a direct audio stream URL for the given track.

    Returns a dict with:
      - url:      the direct HTTPS CDN URL — pass this to <audio src="">
      - ext:      file extension ("webm" for Opus, "m4a" for AAC)
      - abr:      audio bitrate in kbps (e.g. 128.0 or 256.0)
      - acodec:   codec name (e.g. "opus" or "mp4a.40.2")
      - duration: length in seconds
      - title:    track title from YouTube metadata
      - thumbnail: URL of the track thumbnail image

    This function takes 1–3 seconds because it calls YouTube's API.
    The returned URL is valid for several hours — no need to re-fetch for playback.
    """
    # Server-side cache hit: skip yt-dlp entirely (~0 ms vs 0.5-2 s)
    cached = _cache_get(video_id)
    if cached:
        return cached

    url = f"https://music.youtube.com/watch?v={video_id}"
    # Preferred-quality first, then progressively looser — the final `best`
    # catches the rare case where a client returns ONLY combined audio+video.
    # Browsers play the audio track of an mp4 fine, so this never blocks playback.
    fmt = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[ext=mp4]/best"

    def _extract(extractor_args: dict) -> dict:
        opts = {
            **_BASE_YDL_OPTS,
            "format": fmt,
            "extract_flat": False,
            "extractor_args": extractor_args,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        # Fast path: ios + skip JS/webpage (~0.5-1 s)
        info = _extract(_FAST_EXTRACTOR)
    except Exception:
        # Slow path: music-specific clients + general fallbacks.
        # Handles YT Music-only IDs (lp-XXXXX), age-gated tracks, and the
        # "Requested format is not available" case where the ios client
        # returned no audio-only formats for that specific track.
        try:
            info = _extract(_SLOW_EXTRACTOR)
        except Exception as e:
            # Surface a clean error message — no yt-dlp stack trace.
            raise RuntimeError(
                f"Could not extract audio stream for {video_id}: "
                f"YouTube blocked all clients. ({type(e).__name__})"
            ) from None

    result = {
        "url":       info["url"],
        "ext":       info.get("ext", "m4a"),
        "abr":       info.get("abr"),
        "acodec":    info.get("acodec"),
        "duration":  info.get("duration"),
        "title":     info.get("title"),
        "thumbnail": info.get("thumbnail"),
    }
    _cache_set(video_id, result)
    return result


def _embed_cover_art(m4a_path: str, thumb_path: str, ffmpeg: "str | None") -> None:
    """Best-effort: embed `thumb_path` as the m4a cover art using ffmpeg directly.

    ffmpeg muxes the image in as an `attached_pic` video stream (transcoding the
    webp that YouTube usually serves to mjpeg inline) while copying the audio
    untouched — so no ffprobe and no extra tagging library are needed. Any failure
    is swallowed: the track always keeps its tagged audio, just possibly without
    the embedded image.
    """
    if not (ffmpeg and os.path.isfile(ffmpeg)):
        return
    tmp_out = m4a_path + ".cover.m4a"
    try:
        subprocess.run(
            [ffmpeg, "-y", "-i", m4a_path, "-i", thumb_path,
             "-map", "0:a", "-map", "1:0", "-c:a", "copy",
             "-c:v", "mjpeg", "-disposition:v:0", "attached_pic", tmp_out],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
        )
        os.replace(tmp_out, m4a_path)
    except Exception:
        try:
            if os.path.exists(tmp_out):
                os.remove(tmp_out)
        except Exception:
            pass


def download_track(video_id: str, output_dir: str) -> dict:
    """
    Download a track to disk as an M4A (AAC audio) file with metadata and cover art.

    Why M4A?
      It's a container for AAC audio — the format YouTube serves for music. When the
      source is already AAC there's no re-encode, so no quality loss (~4 MB / 3-min).

    How the extras get there:
      - Title/artist/album tags  → yt-dlp's FFmpegMetadata post-processor (ffmpeg).
      - Album art (cover image)  → written by mutagen (below), which avoids needing a
        separate ffprobe binary. Cover art is best-effort: a track always saves as a
        correctly-tagged M4A even if the thumbnail can't be embedded.

    ffmpeg is bundled via imageio-ffmpeg (frozen into the sidecar), so this works
    with no system install. Output path: output_dir/Artist - Title.m4a
    """
    output_dir = os.path.expanduser(output_dir)  # expand ~/... to full path
    os.makedirs(output_dir, exist_ok=True)
    ffmpeg = _resolve_ffmpeg()

    url = f"https://music.youtube.com/watch?v={video_id}"
    ydl_opts = {
        **_BASE_YDL_OPTS,
        "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
        # %(artist)s and %(title)s are filled in by yt-dlp from YouTube metadata
        "outtmpl": f"{output_dir}/%(artist)s - %(title)s.%(ext)s",
        "writethumbnail": True,  # saved alongside; embedded via mutagen afterwards
        "postprocessors": [
            # Extract audio to M4A (remux, no re-encode when the source is AAC).
            {"key": "FFmpegExtractAudio", "preferredcodec": "m4a"},
            # Write title/artist/album tags into the file.
            {"key": "FFmpegMetadata"},
        ],
    }
    if ffmpeg:
        ydl_opts["ffmpeg_location"] = ffmpeg

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    # Embed cover art (best-effort): find the produced .m4a and its saved thumbnail.
    m4a_path = next(
        (d.get("filepath") for d in (info.get("requested_downloads") or [])
         if d.get("filepath")),
        None,
    )
    if m4a_path and m4a_path.lower().endswith(".m4a") and os.path.exists(m4a_path):
        stem = os.path.splitext(m4a_path)[0]
        for thumb_ext in (".webp", ".jpg", ".jpeg", ".png"):
            thumb = stem + thumb_ext
            if os.path.exists(thumb):
                _embed_cover_art(m4a_path, thumb, ffmpeg)
                try:  # tidy up the downloaded thumbnail
                    os.remove(thumb)
                except Exception:
                    pass
                break

    return {
        "title":    info.get("title"),
        "artist":   info.get("artist") or info.get("uploader"),
        "duration": info.get("duration"),
    }
