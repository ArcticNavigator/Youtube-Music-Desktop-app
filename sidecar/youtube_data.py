# ═══════════════════════════════════════════════════════════════════════════════
# youtube_data.py — official YouTube Data API v3 (your real playlists)
# ═══════════════════════════════════════════════════════════════════════════════
#
# YouTube's PRIVATE music API (InnerTube, via ytmusicapi) rejects third-party OAuth
# tokens. The OFFICIAL Data API does NOT — so we use it for the things it supports:
# the signed-in user's playlists and their items (your "music" playlist lives here).
#
# Quota: reads cost 1 unit per 50-item page; the daily free budget is 10,000 units,
# so syncing playlists is negligible. We never use search.list (100 units).
#
# Auth: every call uses a fresh access token from auth.get_access_token().

import json
import urllib.parse
import urllib.request

import auth

_API = "https://www.googleapis.com/youtube/v3"


def _get(path: str, params: dict) -> dict:
    token = auth.get_access_token()
    if not token:
        raise RuntimeError("Not authenticated")
    url = f"{_API}/{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def _thumb(thumbnails: dict) -> list[dict]:
    t = thumbnails.get("medium") or thumbnails.get("high") or thumbnails.get("default") or {}
    url = t.get("url")
    return [{"url": url, "width": t.get("width", 320), "height": t.get("height", 180)}] if url else []


def list_playlists() -> list[dict]:
    """The signed-in user's playlists: {playlistId, title, count, thumbnails}."""
    out: list[dict] = []
    page = None
    while True:
        params = {"part": "snippet,contentDetails", "mine": "true", "maxResults": 50}
        if page:
            params["pageToken"] = page
        data = _get("playlists", params)
        for it in data.get("items", []):
            sn = it.get("snippet", {})
            out.append({
                "playlistId": it.get("id"),
                "title": sn.get("title"),
                "count": it.get("contentDetails", {}).get("itemCount"),
                "thumbnails": _thumb(sn.get("thumbnails", {})),
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def get_playlist_items(playlist_id: str) -> list[dict]:
    """Tracks in a playlist: {videoId, title, artists, thumbnails}."""
    out: list[dict] = []
    page = None
    while True:
        params = {"part": "snippet,contentDetails", "playlistId": playlist_id, "maxResults": 50}
        if page:
            params["pageToken"] = page
        data = _get("playlistItems", params)
        for it in data.get("items", []):
            sn = it.get("snippet", {})
            vid = (it.get("contentDetails", {}).get("videoId")
                   or sn.get("resourceId", {}).get("videoId"))
            if not vid:
                continue
            # videoOwnerChannelTitle is usually "Artist - Topic" for music tracks;
            # videoOwnerChannelId is that channel's id, which resolves via get_artist
            # — so we keep it as the artist id to make the name clickable.
            owner = (sn.get("videoOwnerChannelTitle") or "").replace(" - Topic", "").strip()
            owner_id = sn.get("videoOwnerChannelId")
            out.append({
                "videoId": vid,
                "playlistItemId": it.get("id"),  # needed to remove this item later
                "title": sn.get("title"),
                "artists": [{"name": owner, "id": owner_id}] if owner else [],
                "thumbnails": _thumb(sn.get("thumbnails", {})),
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def _music_video_ids(video_ids: list[str]) -> set[str]:
    """
    Of the given video ids, return the subset that are music (videoCategoryId "10").
    YouTube tags every video with a category; "10" is Music — it covers album/topic
    tracks, official music videos and lyric videos, while excluding vlogs, tutorials,
    gaming clips, etc. videos.list costs 1 unit per 50 ids (negligible).
    """
    music: set[str] = set()
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i:i + 50]
        data = _get("videos", {"part": "snippet", "id": ",".join(batch), "maxResults": 50})
        for it in data.get("items", []):
            if it.get("snippet", {}).get("categoryId") == "10":
                music.add(it.get("id"))
    return music


def get_liked_songs() -> dict:
    """
    The signed-in user's liked *songs* via the official Data API — NO cookies needed,
    just the OAuth token we already hold. Liking a song in YouTube Music adds it to
    the account's "likes" playlist, which the Data API exposes through
    channels.relatedPlaylists.likes. We read its id, page through its items with the
    same track-shaping as get_playlist_items (so artists stay clickable), then keep
    only the music ones (videoCategoryId "10") so non-music liked videos are excluded.

    Returns {"tracks": [...]} to match the shape the frontend already expects.

    Note: Google keeps the likes playlist private — readable only for the owner.
    """
    likes_id = "LL"  # the well-known alias for the current user's likes playlist
    try:
        ch = _get("channels", {"part": "contentDetails", "mine": "true"})
        items = ch.get("items") or []
        if items:
            rel = items[0].get("contentDetails", {}).get("relatedPlaylists", {})
            likes_id = rel.get("likes") or likes_id
    except Exception:
        pass  # fall back to the "LL" alias

    tracks = get_playlist_items(likes_id)
    vids = [t["videoId"] for t in tracks if t.get("videoId")]
    try:
        music_ids = _music_video_ids(vids)
    except Exception:
        # Category lookup failed — show the unfiltered likes rather than nothing.
        return {"tracks": tracks}
    return {"tracks": [t for t in tracks if t.get("videoId") in music_ids]}


def add_to_playlist(playlist_id: str, video_id: str) -> dict:
    """Add a video to one of the user's playlists (Data API playlistItems.insert)."""
    token = auth.get_access_token()
    if not token:
        raise RuntimeError("Not authenticated")
    body = json.dumps({
        "snippet": {
            "playlistId": playlist_id,
            "resourceId": {"kind": "youtube#video", "videoId": video_id},
        }
    }).encode()
    req = urllib.request.Request(
        f"{_API}/playlistItems?part=snippet",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 409:
            # Already in the playlist — treat as success (idempotent).
            return {"id": None, "alreadyExists": True}
        raise


def remove_from_playlist(item_id: str) -> bool:
    """Remove an item from a playlist by its playlistItem id (Data API delete)."""
    token = auth.get_access_token()
    if not token:
        raise RuntimeError("Not authenticated")
    req = urllib.request.Request(
        f"{_API}/playlistItems?id={urllib.parse.quote(item_id)}",
        method="DELETE",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15):
            return True
    except urllib.error.HTTPError as e:
        if e.code == 409:
            # Already removed — treat as success (idempotent).
            return True
        raise
