// ═══════════════════════════════════════════════════════════════════════════════
// api.ts — Sidecar API client
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHAT THIS FILE DOES:
//   Provides typed functions for every endpoint in the Python sidecar.
//   The React components import from here instead of writing raw fetch() calls.
//
// HOW IT WORKS:
//   The sidecar runs at http://127.0.0.1:34785 (localhost only — not exposed
//   to the network). Every function here is a typed wrapper around fetch().
//
// USAGE EXAMPLE in a React component:
//   import * as api from "../api";
//
//   // Search for songs
//   const { results } = await api.search("bohemian rhapsody", "songs");
//
//   // Get a stream URL for a track
//   const stream = await api.getStream("dQw4w9WgXcQ");
//   audioElement.src = stream.url;
// ═══════════════════════════════════════════════════════════════════════════════

// The sidecar's base URL. Change the port here if you need to run multiple instances.
const BASE_URL = "http://127.0.0.1:34785";

// ── Sidecar auth token ──────────────────────────────────────────────────────────
//
// The shipped Tauri app spawns the sidecar with a random per-launch bearer token
// and exposes it via the `sidecar_token` IPC command. We fetch it once, cache the
// promise, and attach `Authorization: Bearer <token>` to every request.
//
// In the Vite dev browser there is no Tauri runtime, so `invoke` throws — we fall
// back to no header. The dev sidecar is started without a token (enforcement off),
// so unauthenticated dev requests still succeed.
let tokenPromise: Promise<string | null> | null = null;

function getSidecarToken(): Promise<string | null> {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<string>("sidecar_token");
      } catch {
        return null; // not running inside Tauri (dev) — no token needed
      }
    })();
  }
  return tokenPromise;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getSidecarToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Core HTTP helpers ──────────────────────────────────────────────────────────
//
// These two functions handle all HTTP requests. Components never call fetch()
// directly — they always go through these helpers so errors are handled uniformly.

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: await authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(await authHeaders()),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

// ── Health ─────────────────────────────────────────────────────────────────────

/** Check if the sidecar is running and ready. Called every second on app start. */
export const health = () => get<{ status: string }>("/health");

// ── Auth ───────────────────────────────────────────────────────────────────────

/** Is the user currently signed in with Google? */
export const authStatus = () => get<{ authenticated: boolean }>("/auth/status");

/**
 * Start the Google OAuth login flow.
 * This opens the user's browser — they approve and the token is saved locally.
 */
export const login = () => post<{ success: boolean; message: string }>("/auth/login");

/** Sign out — deletes the saved OAuth token. */
export const logout = () => post("/auth/logout");

/** Get the logged-in user's profile (name + avatar). Requires authentication. */
export const getProfile = () =>
  get<{ accountName: string; accountPhotoUrl: string; channelHandle: string }>("/auth/profile");

// ── Google OAuth (PKCE desktop flow, driven by the Rust shell) ──────────────────

/** Verified identity returned by the Rust `oauth_begin` / `oauth_status` commands. */
export interface OAuthIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string;
  email_verified: boolean;
}

/**
 * Begin Google sign-in. Opens the system browser to Google's consent page,
 * captures the loopback redirect, validates the id_token, and resolves with the
 * verified identity. Rejects if the user cancels or validation fails.
 */
export async function oauthBegin(): Promise<OAuthIdentity> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<OAuthIdentity>("oauth_begin");
}

/** The currently signed-in identity, or null (guest / not in Tauri). */
export async function oauthStatus(): Promise<OAuthIdentity | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<OAuthIdentity | null>("oauth_status");
  } catch {
    return null;
  }
}

/**
 * Restore a persisted session on startup. The Rust shell refreshes the access
 * token from the OS keychain and re-arms the sidecar; resolves with the identity
 * or null (no stored session / guest).
 */
export async function oauthRestore(): Promise<OAuthIdentity | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<OAuthIdentity | null>("oauth_restore");
  } catch {
    return null;
  }
}

/** Sign out — clears the in-memory session in the Rust shell. */
export async function oauthLogout(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("oauth_logout");
  } catch {
    /* not in Tauri — nothing to clear */
  }
}

// ── YouTube Music session-cookie connect (full InnerTube access) ───────────────

/** Open the in-app YouTube Music login window. */
export async function ytmConnectBegin(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ytmusic_connect_begin");
}

/** Read the cookie from the login window + verify it. Returns the test result. */
export async function ytmConnectFinish(): Promise<{ ok: boolean; accountName?: string; playlistCount?: number; error?: string }> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke("ytmusic_connect_finish");
}

/** Disconnect the YT Music session. */
export async function ytmDisconnect(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ytmusic_disconnect");
}

/** Verify the installed cookie with one authenticated InnerTube call (sidecar). */
export const ytmTest = () =>
  get<{ ok: boolean; playlistCount?: number; error?: string }>("/auth/ytmusic-cookie/test");

/** On startup, silently re-push a stored cookie. Returns whether a session restored. */
export async function ytmRestore(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("ytmusic_restore");
  } catch { return false; }
}

// ── Account record & data-subject rights (Supabase, via Edge Functions) ────────

/** Is there room under the ≤100 sign-up cap? Fails open on transient errors. */
export const getSignupsOpen = () => get<{ open: boolean; count: number | null }>("/signups/open");

/** Idempotent first-login record write. Returns {ok, created} or error 'signups_full'. */
export const recordFirstLogin = () =>
  post<{ ok: boolean; created?: boolean; error?: string }>("/me/first-login");

/** Data-subject export: the caller's own stored record (or null). */
export const getMyData = () => get<{ data: Record<string, unknown> | null }>("/me/data");

/** Data-subject erasure: hard-delete the caller's record. */
export const deleteMyData = () => del<{ ok: boolean }>("/me/data");

// ── Search & Discovery ─────────────────────────────────────────────────────────

/**
 * Get autocomplete suggestions as the user types.
 * Called debounced (300ms) — returns up to ~10 suggestion strings.
 */
export const getSearchSuggestions = (q: string) =>
  get<{ suggestions: string[] }>(
    `/search/suggestions?q=${encodeURIComponent(q)}`
  );

/**
 * Search YouTube Music.
 * filter: "songs" | "albums" | "artists" | "playlists" | undefined (all)
 */
export const search = (query: string, filter?: string) =>
  get<{ results: SearchResult[] }>(
    `/search?q=${encodeURIComponent(query)}${filter ? `&filter=${filter}` : ""}`
  );

/** Fetch the YouTube Music home page (trending, new releases, etc.). */
export const getHome = () => get<{ shelves: HomeShelf[] }>("/home");

// ── Tracks ─────────────────────────────────────────────────────────────────────

/** Get metadata for a single track by its YouTube video ID. */
export const getSong = (videoId: string) => get<SongInfo>(`/song/${videoId}`);

/**
 * Get the direct audio stream URL for a track.
 * This is the NewPipe approach: bypasses YouTube's ad-serving player,
 * returns a raw CDN URL that the <audio> element plays directly.
 * Takes 1–3 seconds (yt-dlp calls YouTube's API each time).
 */
export const getStream = (videoId: string, title = "", artist = "") =>
  get<StreamInfo>(
    `/stream/${videoId}?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`
  );

/** Get all tracks in a playlist. */
export const getPlaylist = (playlistId: string) => get<Playlist>(`/playlist/${playlistId}`);

// ── Personal Library (requires Google sign-in) ─────────────────────────────────

/** Get the signed-in user's playlists. Returns 401 if not signed in. */
export const getLibraryPlaylists = () =>
  get<{ playlists: PlaylistSummary[] }>("/library/playlists");

// ── YouTube Data API — your real playlists (OAuth works here, unlike InnerTube) ──

/** The signed-in user's YouTube playlists (incl. music playlists), via the Data API. */
export const getYtPlaylists = () =>
  get<{ playlists: PlaylistSummary[] }>("/yt/playlists");

/** Tracks in one of the user's playlists, via the Data API. */
export const getYtPlaylist = (id: string) =>
  get<{ tracks: Track[] }>(`/yt/playlist/${encodeURIComponent(id)}`);

/** Add a track to one of the user's playlists (reflects on YouTube + YT Music). */
export const addToPlaylist = (playlistId: string, videoId: string) =>
  post<{ ok: boolean; playlistItemId?: string }>(`/yt/playlist/${encodeURIComponent(playlistId)}/items`, { videoId });

/** Remove an item from a playlist by its playlistItem id. */
export const removeFromPlaylistItem = (itemId: string) =>
  del<{ ok: boolean }>(`/yt/playlist/items/${encodeURIComponent(itemId)}`);

/** Get the signed-in user's liked songs. Returns 401 if not signed in. */
export const getLikedSongs = () => get<LikedSongs>("/library/liked");

/** The signed-in user's library artists (needs the YT Music session cookie). */
export const getLibraryArtists = () => get<{ artists: SearchResult[] }>("/library/artists");

/** The signed-in user's saved albums (needs the YT Music session cookie). */
export const getLibraryAlbums = () => get<{ albums: SearchResult[] }>("/library/albums");

/** Recently played tracks from OUR local on-disk history (not YouTube's). */
export const getHistory = () => get<{ history: HistoryItem[] }>("/library/history");

/** Record a play in the local history (dedupe-to-top). Fire-and-forget. */
export const recordPlay = (track: { videoId: string; title?: string; artists?: { id?: string; name: string }[]; thumbnails?: Thumbnail[] }) =>
  post<{ ok: boolean }>("/history", {
    videoId: track.videoId, title: track.title,
    artists: track.artists, thumbnails: track.thumbnails,
  });

/** Clear the local play history. */
export const clearHistory = () => del<{ ok: boolean }>("/library/history");

// ── Downloads ──────────────────────────────────────────────────────────────────

/**
 * Download a track to disk.
 * Saves to: outputDir/Artist - Title.m4a (with embedded album art and metadata)
 */
export const downloadTrack = (videoId: string, outputDir: string) =>
  post(`/download/${videoId}?output_dir=${encodeURIComponent(outputDir)}`);

/**
 * Get radio-style related tracks for a given video ID.
 * Same as YouTube's "Up Next" queue — works without login.
 */
export const getRelated = (videoId: string) =>
  get<{ tracks: Track[] }>(`/related/${videoId}`);

// ── Explore ────────────────────────────────────────────────────────────────────

/** One mood/genre tile (e.g. "Chill", "Feel good", "Rock"). */
export interface MoodTile {
  title: string;
  params: string;
  color?: string;        // hex color if returned by the API
  thumbnails?: Thumbnail[];
}

/** A category grouping mood tiles (e.g. "Moods & moments", "Genres"). */
export interface MoodCategory {
  title: string;
  moods: MoodTile[];
}

/** A ranked chart entry — track with views + trend indicator. */
export interface ChartTrack {
  videoId?: string;
  title: string;
  artists?: { id?: string; name: string }[];
  album?: { id: string; name: string };
  thumbnails?: Thumbnail[];
  views?: string;
  rank?: number;
  trend?: string;   // "up" | "down" | "neutral" | "new"
  duration?: string;
}

/**
 * Fetch Moods & Genres categories for the Explore page.
 * Returns coloured mood tiles grouped by category.
 */
export const getMoodCategories = () =>
  get<{ categories: MoodCategory[] }>("/explore/moods");

/**
 * Fetch music charts (default: global).
 * Returns sections: trending / songs / videos, each with ranked tracks.
 */
export const getCharts = (country = "ZZ") =>
  get<{
    trending?: { playlist: string; items: ChartTrack[] };
    songs?:    { playlist: string; items: ChartTrack[] };
    videos?:   { playlist: string; items: ChartTrack[] };
  }>(`/explore/charts?country=${country}`);

/**
 * Fetch lyrics from lrclib.net (free, no API key).
 * Returns synced LRC-format lyrics and/or plain text lyrics.
 * Either field can be null if not found.
 */
export const getLyrics = (title: string, artist: string, videoId?: string) =>
  get<{ syncedLyrics: string | null; plainLyrics: string | null }>(
    `/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}${videoId ? `&video_id=${encodeURIComponent(videoId)}` : ""}`
  );

/** An album/single in an artist's discography. */
export interface ArtistRelease {
  browseId?: string;
  title: string;
  year?: string;
  type?: string;
  thumbnails?: Thumbnail[];
}

/** A related artist entry on an artist page. */
export interface RelatedArtist {
  browseId?: string;
  title: string;
  subscribers?: string;
  thumbnails?: Thumbnail[];
}

/** Full artist page data returned by /artist/{channelId}. */
export interface ArtistData {
  name: string;
  channelId?: string;
  description?: string;
  subscribers?: string;
  thumbnails?: Thumbnail[];
  songs?: {
    browseId?: string;
    results: Track[];
  };
  albums?: {
    browseId?: string;
    results: ArtistRelease[];
  };
  singles?: {
    browseId?: string;
    results: ArtistRelease[];
  };
  related?: {
    results: RelatedArtist[];
  };
}

/**
 * Fetch full artist page for a given YouTube Music channel/browse ID.
 * Returns top songs, albums, singles, related artists, thumbnails.
 */
export const getArtist = (browseId: string) =>
  get<ArtistData>(`/artist/${encodeURIComponent(browseId)}`);

/** Full album/single/EP data returned by /album/{browseId}. */
export interface AlbumData {
  title: string;
  type?: string;             // "Album" | "Single" | "EP"
  year?: string;
  artists?: { id?: string; name: string }[];
  thumbnails?: Thumbnail[];  // the album cover
  trackCount?: number;
  duration?: string;
  audioPlaylistId?: string;
  tracks: Track[];
}

/**
 * Fetch an album/single/EP and its track list by its album browse ID
 * (the `browseId` on an artist's album/single card, e.g. "MPREb_xxxxx").
 */
export const getAlbum = (browseId: string) =>
  get<AlbumData>(`/album/${encodeURIComponent(browseId)}`);

// ═══════════════════════════════════════════════════════════════════════════════
// Type definitions
// ═══════════════════════════════════════════════════════════════════════════════
//
// These types match exactly what the Python sidecar returns.
// If YouTube's API changes the shape of a response, update the type here
// and TypeScript will highlight every place in the app that needs fixing.

export interface Thumbnail {
  url: string;
  width: number;
  height: number;
}

/** A single music track (song). */
export interface Track {
  videoId: string;
  playlistItemId?: string;    // present for items read from a user playlist (Data API)
  title: string;
  artists?: { id?: string; name: string }[];
  album?: { id: string; name: string };
  duration?: string;          // e.g. "3:45"
  thumbnails?: Thumbnail[];
}

/** One result from a search query. */
export interface SearchResult {
  resultType?: string;        // "song" | "album" | "artist" | "playlist"
  videoId?: string;           // present for songs
  playlistId?: string;        // present for playlists/albums
  browseId?: string;          // present for artists
  title: string;
  artists?: { id?: string; name: string }[];
  album?: { id: string; name: string };
  duration?: string;
  thumbnails?: Thumbnail[];
}

/** One shelf on the home page (e.g. "Trending", "New releases"). */
export interface HomeShelf {
  title: string;
  contents: SearchResult[];
  browseId?: string;   // present when ytmusicapi returns a shelf-level navigation target
  params?: string;
}

/** Detailed info for a single track. */
export interface SongInfo {
  videoDetails?: {
    videoId: string;
    title: string;
    lengthSeconds: string;
    author: string;
    thumbnail?: { thumbnails: Thumbnail[] };
  };
}

/**
 * The result from /stream/{videoId}.
 * `url` is the direct CDN audio URL — play it with <audio src={url}>.
 */
export interface StreamInfo {
  url: string;
  ext: string;               // "m4a" (AAC) or "webm" (Opus)
  abr?: number;              // audio bitrate in kbps, e.g. 128.0 or 256.0
  acodec?: string;           // e.g. "mp4a.40.2" or "opus"
  duration?: number;         // in seconds
  title?: string;
  thumbnail?: string;
}

/** A short summary of a playlist (for library listing). */
export interface PlaylistSummary {
  playlistId: string;
  title: string;
  count?: number;
  thumbnails?: Thumbnail[];
}

/** Full playlist with all tracks. */
export interface Playlist {
  id: string;
  title: string;
  tracks: Track[];
  thumbnails?: Thumbnail[];
}

/** Response from /library/liked. */
export interface LikedSongs {
  tracks: Track[];
}

/** One entry from listening history. */
export interface HistoryItem {
  videoId: string;
  title: string;
  artists?: { id?: string; name: string }[];
  thumbnails?: Thumbnail[];
  playedAt?: number;   // unix seconds, set by the local history store
}
