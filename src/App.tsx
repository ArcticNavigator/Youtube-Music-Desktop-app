// ═══════════════════════════════════════════════════════════════════════════════
// App.tsx — 3-panel YouTube Music layout
// Left: nav + user profile + player controls
// Center: main content (home, search, playlists, etc.)
// Right: toggleable panel (queue/lyrics, library, related)
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as api from "./api";
import type { Track, SearchResult, HomeShelf, StreamInfo } from "./api";
import privacyText from "../docs/PRIVACY.md?raw";
import "./App.css";

// ── Constants ─────────────────────────────────────────────────────────────────

const DOWNLOAD_DIR = "~/Music/YouTube Music";
const SUGGEST_DELAY = 300;

// Mood tile colour palette — cycles through when the API doesn't return a colour.
// Chosen to match the vibrant palette YouTube Music uses.
const MOOD_COLORS = [
  "#4C6EF5",
  "#F59F00",
  "#E64980",
  "#12B886",
  "#7950F2",
  "#FD7E14",
  "#1C7ED6",
  "#2F9E44",
  "#AE3EC9",
  "#F03E3E",
  "#0CA678",
  "#D6336C",
  "#E67700",
  "#5C7CFA",
  "#099268",
  "#C2255C",
];

// Curated genre tiles — guaranteed to work because they just trigger a search.
// Used as the primary Explore content (YT InnerTube mood/chart endpoints are
// region-locked and frequently return empty for non-US accounts).
const GENRE_TILES: { title: string; query: string }[] = [
  { title: "Pop", query: "pop hits" },
  { title: "Hip-Hop & Rap", query: "hip hop rap" },
  { title: "Rock", query: "rock music" },
  { title: "Bollywood", query: "bollywood hits" },
  { title: "Indie", query: "indie music" },
  { title: "R&B / Soul", query: "rnb soul" },
  { title: "Electronic", query: "electronic dance music" },
  { title: "Lo-fi", query: "lofi hip hop chill" },
  { title: "Jazz", query: "jazz" },
  { title: "Classical", query: "classical music" },
  { title: "Country", query: "country music" },
  { title: "Metal", query: "metal" },
  { title: "Punjabi", query: "punjabi music" },
  { title: "K-Pop", query: "kpop" },
  { title: "Latin", query: "latin music" },
  { title: "Folk", query: "folk acoustic" },
];

const MOOD_TILES: { title: string; query: string }[] = [
  { title: "Chill", query: "chill music" },
  { title: "Workout", query: "workout music" },
  { title: "Focus", query: "focus instrumental" },
  { title: "Party", query: "party hits" },
  { title: "Romance", query: "romantic songs" },
  { title: "Sleep", query: "sleep music" },
  { title: "Sad", query: "sad songs" },
  { title: "Feel good", query: "feel good music" },
  { title: "Commute", query: "drive music" },
  { title: "Energy", query: "high energy hits" },
];

// ── Types ─────────────────────────────────────────────────────────────────────

type View =
  | "home"
  | "search"
  | "library"
  | "playlist"
  | "liked"
  | "history"
  | "artists"
  | "albums"
  | "podcasts"
  | "explore"
  | "artist"
  | "album";
type RightPanel = null | "queue" | "library" | "related";
type QueueTab = "upnext" | "lyrics";
type DlState = "loading" | "done" | "error";

interface PlayerState {
  track: Track | null;
  streamUrl: string | null;
  streamThumb?: string; // thumbnail of the actually-playing stream (fallback for dead videos)
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
}

interface ViewSnapshot {
  view: View;
  searchResults: SearchResult[];
  likedSongs: Track[];
  history: api.HistoryItem[];
  openPlaylist: api.Playlist | null;
  homeShelves: HomeShelf[];
  artistResults: SearchResult[];
  albumResults: SearchResult[];
  openArtist: api.ArtistData | null;
  openAlbum: api.AlbumData | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function thumb(thumbnails?: api.Thumbnail[], size = 60): string {
  if (!thumbnails?.length) return "";
  const url = [...thumbnails].sort(
    (a, b) => Math.abs(a.width - size) - Math.abs(b.width - size),
  )[0].url;
  // Fix protocol-relative URLs (e.g. //yt3.ggpht.com/...) — browsers need a scheme
  return url.startsWith("//") ? "https:" + url : url;
}

// Standard YouTube CDN thumbnail — works for ANY video ID, never expires.
// Used as the fallback when ytmusicapi's primary URL fails to load.
function ytFallback(videoId?: string): string {
  return videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : "";
}

// Robust image-error recovery, applied in order:
//   1) if the item has a videoId, swap to the YouTube CDN fallback once;
//   2) retry the current URL a few times with exponential backoff and a cache-busting
//      query — the usual cause of a "missing" thumbnail is transient googleusercontent
//      throttling (HTTP 429) when ~30 covers burst-load at once, and a moment-later
//      retry almost always succeeds (verified: the CDN ignores the ?r= param);
//   3) only after retries are exhausted, hide so the styled ♫ placeholder shows.
// State lives in data-attributes so reused <img> elements don't loop forever.
function thumbOnError(videoId?: string, maxRetries = 4) {
  return (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (videoId && img.dataset.fellback !== "1") {
      img.dataset.fellback = "1";
      img.dataset.base = ytFallback(videoId);
      img.src = ytFallback(videoId);
      return;
    }
    const n = Number(img.dataset.retry || "0");
    if (n < maxRetries) {
      img.dataset.retry = String(n + 1);
      const base = img.dataset.base || img.src.split("?")[0];
      img.dataset.base = base;
      window.setTimeout(
        () => {
          img.src = `${base}?r=${n + 1}`;
        },
        300 * 2 ** n,
      );
      return;
    }
    img.style.display = "none";
  };
}

function fmt(seconds?: number): string {
  if (!seconds) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function sliderFill(pct: number, color: string): string {
  return `linear-gradient(to right, ${color} ${pct}%, var(--bg4) ${pct}%)`;
}

function EqBars() {
  return (
    <div className="eq-bars">
      <span />
      <span />
      <span />
    </div>
  );
}

function SearchIcon({
  size = 15,
  color = "currentColor",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block", flexShrink: 0 }}
    >
      <circle cx="8.5" cy="8.5" r="5.75" stroke={color} strokeWidth="2" />
      <line
        x1="13"
        y1="13"
        x2="17.5"
        y2="17.5"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      width="15"
      height="17"
      viewBox="0 0 15 17"
      fill="currentColor"
      style={{ display: "block" }}
    >
      <polygon points="0,0 15,8.5 0,17" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg
      width="15"
      height="17"
      viewBox="0 0 15 17"
      fill="currentColor"
      style={{ display: "block" }}
    >
      <rect x="0" y="0" width="5.5" height="17" rx="1.5" />
      <rect x="9.5" y="0" width="5.5" height="17" rx="1.5" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ display: "block" }}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MiniPlayerIcon() {
  // Picture-in-picture style glyph: outer frame + a small inset panel.
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ display: "block" }}>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="12" y="12" width="7" height="6" rx="1" fill="currentColor" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <polyline points="16 3 21 3 21 8" />
      <line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" />
      <line x1="15" y1="15" x2="21" y2="21" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ display: "block" }}
    >
      <polygon points="19,20 9,12 19,4" />
      <rect x="5" y="4" width="2.5" height="16" rx="1" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ display: "block" }}
    >
      <polygon points="5,4 15,12 5,20" />
      <rect x="16.5" y="4" width="2.5" height="16" rx="1" />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ display: "block" }}
    >
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path
        d="M15.54 8.46a5 5 0 0 1 0 7.07"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlaylistAddIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <line x1="3" y1="6" x2="15" y2="6" />
      <line x1="3" y1="12" x2="12" y2="12" />
      <line x1="3" y1="18" x2="12" y2="18" />
      <line x1="18" y1="10" x2="18" y2="18" />
      <line x1="14" y1="14" x2="22" y2="14" />
    </svg>
  );
}

function PlaylistRemoveIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <line x1="3" y1="6" x2="15" y2="6" />
      <line x1="3" y1="12" x2="12" y2="12" />
      <line x1="3" y1="18" x2="12" y2="18" />
      <line x1="14" y1="14" x2="22" y2="14" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={{ display: "block" }}
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="3" cy="6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="3" cy="18" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function RelatedIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <circle cx="12" cy="12" r="10" />
      <polygon
        points="10 8 16 12 10 16 10 8"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

// Parse LRC-format synced lyrics into timed lines.
// Handles: [mm:ss.cs], [mm:ss.ms], multiple timestamps per line, metadata tags.
function parseLrc(lrc: string): { time: number; text: string }[] {
  const result: { time: number; text: string }[] = [];
  for (const line of lrc.split("\n")) {
    const text = line.replace(/\[\d+:\d+\.\d+\]/g, "").trim();
    if (!text) continue;
    const tagRe = /\[(\d+):(\d+\.\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(line)) !== null) {
      result.push({ time: parseInt(m[1]) * 60 + parseFloat(m[2]), text });
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Core state ─────────────────────────────────────────────────────────────
  const [sidecarReady, setSidecarReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [view, setView] = useState<View>("home");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Search ─────────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // ── Content ─────────────────────────────────────────────────────────────────
  const [homeShelves, setHomeShelves] = useState<HomeShelf[]>([]);
  const [libraryPlaylists, setLibraryPlaylists] = useState<
    api.PlaylistSummary[]
  >([]);
  const [openPlaylist, setOpenPlaylist] = useState<api.Playlist | null>(null);
  const [likedSongs, setLikedSongs] = useState<Track[]>([]);
  const [history, setHistory] = useState<api.HistoryItem[]>([]);
  const [artistResults, setArtistResults] = useState<SearchResult[]>([]);
  const [albumResults, setAlbumResults] = useState<SearchResult[]>([]);
  const [artistQuery, setArtistQuery] = useState("");
  const [albumQuery, setAlbumQuery] = useState("");

  // ── Artist / album detail pages ──────────────────────────────────────────────
  const [openArtist, setOpenArtist] = useState<api.ArtistData | null>(null);
  const [openAlbum, setOpenAlbum] = useState<api.AlbumData | null>(null);

  // ── Unified navigation history ───────────────────────────────────────────────
  // ONE back stack of restorable page snapshots — the only correct way to make
  // back navigation loop properly when artist⇄album pages are interleaved (a
  // browser/YouTube-Music style history). `navStackRef` holds the pages BEHIND
  // the current one; `rootViewRef` is the list/root view to return to once the
  // stack empties. Refs (not state) so push/pop read current values synchronously.
  type NavSnapshot =
    | { kind: "artist"; data: api.ArtistData }
    | { kind: "album"; data: api.AlbumData };
  const navStackRef = useRef<NavSnapshot[]>([]);
  const rootViewRef = useRef<View>("home");
  const openArtistRef = useRef<api.ArtistData | null>(null);
  const openAlbumRef = useRef<api.AlbumData | null>(null);
  const viewRef = useRef<View>("home");

  // ── User profile ───────────────────────────────────────────────────────────
  const [userProfile, setUserProfile] = useState<{
    name: string;
    photoUrl: string;
    email?: string;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deviceCode, setDeviceCode] = useState<{
    code: string;
    url: string;
  } | null>(null);
  // Phase-2 compliance UI: pre-sign-in transparency notice, ≤100 cap state, rights.
  const [showSignInNotice, setShowSignInNotice] = useState(false);
  const [signupsOpen, setSignupsOpen] = useState<boolean | null>(null);
  const [myData, setMyData] = useState<string | null>(null); // export modal JSON
  // Widget / mini-player mode: shrink the window to a player-only always-on-top card.
  const [miniMode, setMiniMode] = useState(false);
  // YouTube Music session-cookie connect (unlocks personalized home + library).
  const [ytmConnectOpen, setYtmConnectOpen] = useState(false);
  const [ytmBusy, setYtmBusy] = useState(false);
  const [ytmConnected, setYtmConnected] = useState(false);
  // Which playlists the user chose to sync (null = not chosen yet for this account).
  const [syncedIds, setSyncedIds] = useState<string[] | null>(null);
  const [showPlaylistChooser, setShowPlaylistChooser] = useState(false);
  const [chooserSelection, setChooserSelection] = useState<string[]>([]);
  const [manageTrack, setManageTrack] = useState<Track | null>(null); // manage-playlists modal
  const [membership, setMembership] = useState<
    Record<string, Record<string, string>>
  >({}); // playlistId → videoId → itemId
  const [openPlaylistOwned, setOpenPlaylistOwned] = useState(false); // open playlist is the user's
  const [notice, setNotice] = useState<string | null>(null); // transient toast

  // ── Player ─────────────────────────────────────────────────────────────────
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIdx, setQueueIdx] = useState(-1);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [dlStatus, setDlStatus] = useState<Record<string, DlState>>({});
  const [player, setPlayer] = useState<PlayerState>({
    track: null,
    streamUrl: null,
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
  });

  // ── Player accent colour (extracted from album art) ───────────────────────
  const [playerAccent, setPlayerAccent] = useState("");

  // ── Right panel ────────────────────────────────────────────────────────────
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [queueSubTab, setQueueSubTab] = useState<QueueTab>("upnext");
  const [lyrics, setLyrics] = useState<{
    synced: string | null;
    plain: string | null;
  } | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [relatedTracks, setRelatedTracks] = useState<Track[]>([]);

  // ── Explore ────────────────────────────────────────────────────────────────
  // Charts come from /explore/charts (region-dependent — often empty).
  // Genres/moods are now client-side tiles that trigger search (always works).
  const [chartTracks, setChartTracks] = useState<api.ChartTrack[]>([]);
  const [exploreLoaded, setExploreLoaded] = useState(false);
  const [exploreLoading, setExploreLoading] = useState(false);

  // ── Theme ──────────────────────────────────────────────────────────────────
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof localStorage !== "undefined" &&
    localStorage.getItem("yt-theme") === "light"
      ? "light"
      : "dark",
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("yt-theme", theme);
  }, [theme]);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement>(null);
  // Hidden audio element used to pre-warm audio bytes for the NEXT track.
  // Once the browser has fetched the bytes into its HTTP cache, switching
  // to that URL on the main audio element starts playback nearly instantly.
  const preloaderRef = useRef<HTMLAudioElement>(null);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<Track[]>([]);
  const queueIdxRef = useRef(-1);
  const shuffleRef = useRef(false);
  const repeatRef = useRef(false);
  // Stream URL cache — key: videoId, value: full StreamInfo.
  // Pre-fetched for the next track so playback starts instantly.
  const streamCacheRef = useRef<Map<string, StreamInfo>>(new Map());
  const prefetchingRef = useRef<Set<string>>(new Set());
  // Lyrics cache — key: videoId, value: {synced, plain}. Prefetched alongside
  // streams so when the next track starts, lyrics are already loaded.
  const lyricsCacheRef = useRef<
    Map<string, { synced: string | null; plain: string | null }>
  >(new Map());
  const lyricsPrefetchRef = useRef<Set<string>>(new Set());
  // Last videoId written to local play-history — so we record each play once.
  const lastRecordedRef = useRef<string | null>(null);
  const homePrefetchedRef = useRef(false);
  const viewDataRef = useRef<ViewSnapshot>({
    view: "home",
    searchResults: [],
    likedSongs: [],
    history: [],
    openPlaylist: null,
    homeShelves: [],
    artistResults: [],
    albumResults: [],
    openArtist: null,
    openAlbum: null,
  });

  // ── Sync refs ──────────────────────────────────────────────────────────────
  useEffect(() => {
    viewDataRef.current = {
      view,
      searchResults,
      likedSongs,
      history,
      openPlaylist,
      homeShelves,
      artistResults,
      albumResults,
      openArtist,
      openAlbum,
    };
  }, [
    view,
    searchResults,
    likedSongs,
    history,
    openPlaylist,
    homeShelves,
    artistResults,
    albumResults,
    openArtist,
    openAlbum,
  ]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    queueIdxRef.current = queueIdx;
  }, [queueIdx]);
  useEffect(() => {
    shuffleRef.current = shuffle;
  }, [shuffle]);
  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);
  useEffect(() => {
    openArtistRef.current = openArtist;
  }, [openArtist]);
  useEffect(() => {
    openAlbumRef.current = openAlbum;
  }, [openAlbum]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // ── Sidecar health poll + silent session restore ───────────────────────────
  useEffect(() => {
    let attempts = 0;
    const poll = async () => {
      try {
        await api.health();
      } catch {
        if (++attempts < 30) setTimeout(poll, 1000);
        return;
      }
      setSidecarReady(true);
      // Sidecar is up — restore any persisted Google session. The Rust shell
      // refreshes the token from the OS keychain and re-arms the sidecar; on
      // failure we simply stay in guest mode.
      try {
        const id = await api.oauthRestore();
        if (id) {
          setAuthenticated(true);
          setUserProfile({
            name: id.name || id.email,
            photoUrl: id.picture || "",
            email: id.email,
          });
          // Returning user on launch — bump last_active_at (the dormancy signal).
          api.recordFirstLogin().catch(() => {});
        }
      } catch {
        /* guest mode */
      }
    };
    poll();
  }, []);

  useEffect(() => {
    if (!sidecarReady) return;
    api
      .getHome()
      .then(({ shelves }) => setHomeShelves(shelves))
      .catch(() => {});
    // Cap state for the sign-in UI (fails open — never blocks a returning user).
    api
      .getSignupsOpen()
      .then((r) => setSignupsOpen(r.open))
      .catch(() => setSignupsOpen(true));
    // Silently re-push a stored YT Music session cookie; if it restores, reload the
    // home as the personalized feed.
    api.ytmRestore().then((connected) => {
      setYtmConnected(connected);
      if (connected) api.getHome().then(({ shelves }) => setHomeShelves(shelves)).catch(() => {});
    }).catch(() => {});
  }, [sidecarReady]);

  // Charts are loaded lazily in the background when Explore opens.
  // Failure is silent — genre/mood tiles + home shelves carry the page.
  useEffect(() => {
    if (view !== "explore" || exploreLoaded) return;
    setExploreLoading(true);
    api
      .getCharts("ZZ")
      .catch(() => api.getCharts("US"))
      .catch(() => ({}) as Awaited<ReturnType<typeof api.getCharts>>)
      .then((chartsData) => {
        const items =
          chartsData.trending?.items ??
          chartsData.songs?.items ??
          chartsData.videos?.items ??
          [];
        setChartTracks(items);
        setExploreLoaded(true);
      })
      .finally(() => setExploreLoading(false));
  }, [view, exploreLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Profile (name / email / avatar) now comes from the verified Google id_token via
  // the Rust shell (set in handleLogin and on restore) — no separate sidecar fetch,
  // which would otherwise clobber the verified email.

  // ── Lyrics prefetch (cache-first, fetch only on miss) ─────────────────────
  type LyricsData = { synced: string | null; plain: string | null };
  const fetchLyricsCached = useCallback(
    (track: Track): Promise<LyricsData | null> => {
      if (!track?.videoId) return Promise.resolve(null);
      const cache = lyricsCacheRef.current;
      const hit = cache.get(track.videoId);
      if (hit) return Promise.resolve(hit);
      if (lyricsPrefetchRef.current.has(track.videoId)) {
        // Already in flight (prefetched by N+1 logic) — poll until done.
        // Resolve on cache hit, on prefetch finishing (success or failure), or timeout.
        return new Promise<LyricsData | null>((resolve) => {
          const start = Date.now();
          const t = setInterval(() => {
            const v = cache.get(track.videoId);
            const stillRunning = lyricsPrefetchRef.current.has(track.videoId);
            if (v || !stillRunning || Date.now() - start > 6000) {
              clearInterval(t);
              resolve(v ?? null);
            }
          }, 60);
        });
      }
      lyricsPrefetchRef.current.add(track.videoId);
      return api
        .getLyrics(track.title, track.artists?.[0]?.name ?? "", track.videoId)
        .then((d): LyricsData => {
          const data = { synced: d.syncedLyrics, plain: d.plainLyrics };
          cache.set(track.videoId, data);
          return data;
        })
        .catch(() => null)
        .finally(() => {
          lyricsPrefetchRef.current.delete(track.videoId);
        });
    },
    [],
  );

  const prefetchLyrics = useCallback(
    (track?: Track) => {
      if (!track?.videoId) return;
      if (lyricsCacheRef.current.has(track.videoId)) return;
      if (lyricsPrefetchRef.current.has(track.videoId)) return;
      fetchLyricsCached(track); // fire-and-forget
    },
    [fetchLyricsCached],
  );

  // ── Fetch lyrics when track changes ───────────────────────────────────────
  useEffect(() => {
    if (!player.track) {
      setLyrics(null);
      return;
    }
    const vid = player.track.videoId;
    const cached = lyricsCacheRef.current.get(vid);
    if (cached) {
      // Cache hit — no flicker, no loading state
      setLyrics(cached);
      setLyricsLoading(false);
      return;
    }
    setLyrics(null);
    setLyricsLoading(true);
    fetchLyricsCached(player.track)
      .then((d) => {
        if (d) setLyrics(d);
        else setLyrics(null);
      })
      .finally(() => setLyricsLoading(false));
  }, [player.track?.videoId, fetchLyricsCached]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch related when panel opens or track changes ───────────────────────
  useEffect(() => {
    if (!player.track || rightPanel !== "related") return;
    api
      .getRelated(player.track.videoId)
      .then((d) => setRelatedTracks((d.tracks ?? []) as Track[]))
      .catch(() => setRelatedTracks([]));
  }, [player.track?.videoId, rightPanel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Audio src watcher ──────────────────────────────────────────────────────
  // streamUrl === null means "track switched but new URL not ready yet".
  // We MUST stop the previous audio in that gap — otherwise the old song
  // keeps playing under a UI that says we're on the new one.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!player.streamUrl) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load(); // cancels any in-flight CDN download
      return;
    }
    audio.src = player.streamUrl;
    audio.volume = player.volume;
    audio
      .play()
      .then(() => setPlayer((p) => ({ ...p, playing: true })))
      .catch(() => {});
  }, [player.streamUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Record a play in the local history once a track has a working stream URL.
  // Keying on (videoId, streamUrl) records every distinct track that actually
  // loads — manual plays AND queue auto-advance — exactly once (resume/pause keep
  // the same videoId, so they don't re-record). Fire-and-forget; never blocks UI.
  useEffect(() => {
    const t = player.track;
    if (!t?.videoId || !player.streamUrl) return;
    if (lastRecordedRef.current === t.videoId) return;
    lastRecordedRef.current = t.videoId;
    api
      .recordPlay({
        videoId: t.videoId,
        title: t.title,
        artists: t.artists,
        thumbnails: t.thumbnails,
      })
      .catch(() => {});
  }, [player.track?.videoId, player.streamUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Core playback ──────────────────────────────────────────────────────────

  const playFromQueue = useCallback(async (idx: number) => {
    const q = queueRef.current;
    if (idx < 0 || idx >= q.length) return;
    const track = q[idx];
    setQueueIdx(idx);
    queueIdxRef.current = idx;
    setError(null);

    const cached = streamCacheRef.current.get(track.videoId);
    if (cached) {
      // Fast path: skip the null intermediate state. The new src is set in
      // the same render as the new track, so the user perceives no loading.
      setPlayer((p) => ({
        ...p,
        track,
        playing: false,
        streamUrl: cached.url,
        streamThumb: cached.thumbnail,
        duration: cached.duration ?? 0,
        currentTime: 0,
      }));
      return;
    }
    // Slow path: stream not cached yet — show loading state, then fetch.
    setPlayer((p) => ({
      ...p,
      track,
      playing: false,
      streamUrl: null,
      streamThumb: undefined,
      currentTime: 0,
    }));
    try {
      const stream = await api.getStream(
        track.videoId,
        track.title,
        track.artists?.[0]?.name ?? "",
      );
      streamCacheRef.current.set(track.videoId, stream);
      // Guard: user may have switched to another track while we were fetching.
      // Only apply this URL if the current track is still the one we fetched for.
      setPlayer((p) =>
        p.track?.videoId === track.videoId
          ? {
              ...p,
              streamUrl: stream.url,
              streamThumb: stream.thumbnail,
              duration: stream.duration ?? 0,
            }
          : p,
      );
    } catch (e) {
      // Only surface error if the user is still on this track
      setPlayer((p) => {
        if (p.track?.videoId === track.videoId)
          setError("This track is unavailable on YouTube.");
        return p;
      });
    }
  }, []);

  const playTrack = useCallback(async (track: Track) => {
    const {
      view,
      searchResults,
      likedSongs,
      history,
      openPlaylist,
      homeShelves,
      artistResults,
      albumResults,
      openArtist,
      openAlbum,
    } = viewDataRef.current;

    let tracks: Track[] = [];
    if (view === "search")
      tracks = searchResults.filter((r) => r.videoId) as unknown as Track[];
    else if (view === "liked") tracks = likedSongs;
    else if (view === "history")
      tracks = history.filter((h) => h.videoId) as unknown as Track[];
    else if (view === "playlist" && openPlaylist) tracks = openPlaylist.tracks;
    else if (view === "album" && openAlbum) tracks = openAlbum.tracks;
    else if (view === "artist" && openArtist)
      tracks = (openArtist.songs?.results ?? []).filter((t) => t.videoId);
    else if (view === "home")
      tracks = homeShelves.flatMap(
        (s) =>
          (s.contents ?? []).filter((c) => c.videoId) as unknown as Track[],
      );
    else if (view === "artists")
      tracks = artistResults.filter((r) => r.videoId) as unknown as Track[];
    else if (view === "albums")
      tracks = albumResults.filter((r) => r.videoId) as unknown as Track[];

    const idx = tracks.findIndex((t) => t.videoId === track.videoId);
    const finalTracks = idx >= 0 ? tracks : [track];
    const finalIdx = idx >= 0 ? idx : 0;

    setQueue(finalTracks);
    setQueueIdx(finalIdx);
    queueRef.current = finalTracks;
    queueIdxRef.current = finalIdx;
    setError(null);

    const cached = streamCacheRef.current.get(track.videoId);
    if (cached) {
      setPlayer((p) => ({
        ...p,
        track,
        playing: false,
        streamUrl: cached.url,
        streamThumb: cached.thumbnail,
        duration: cached.duration ?? 0,
        currentTime: 0,
      }));
      return;
    }
    setPlayer((p) => ({
      ...p,
      track,
      playing: false,
      streamUrl: null,
      streamThumb: undefined,
      currentTime: 0,
    }));
    try {
      const stream = await api.getStream(
        track.videoId,
        track.title,
        track.artists?.[0]?.name ?? "",
      );
      streamCacheRef.current.set(track.videoId, stream);
      // Race guard: if the user already moved on to another track, drop this URL.
      setPlayer((p) =>
        p.track?.videoId === track.videoId
          ? {
              ...p,
              streamUrl: stream.url,
              streamThumb: stream.thumbnail,
              duration: stream.duration ?? 0,
            }
          : p,
      );
    } catch (e) {
      setPlayer((p) => {
        if (p.track?.videoId === track.videoId)
          setError("This track is unavailable on YouTube.");
        return p;
      });
    }
  }, []);

  // ── Stream pre-fetching ────────────────────────────────────────────────────
  // Two-stage prefetch:
  //   1. Stream URL  — small JSON from yt-dlp, cached in streamCacheRef
  //   2. Audio bytes — fetched into the hidden <audio preload="auto"> element
  //                    so the browser caches them at the HTTP layer. Once cached,
  //                    setting the same URL on the main audio element starts
  //                    playback in ~50 ms instead of ~1-2 s.

  const prefetchStream = useCallback(
    (videoId: string, warmAudio = false, title = "", artist = "") => {
      const cached = streamCacheRef.current.get(videoId);
      if (cached) {
        if (warmAudio && preloaderRef.current) {
          // URL already cached — warm bytes now
          if (preloaderRef.current.src !== cached.url) {
            preloaderRef.current.src = cached.url;
            preloaderRef.current.load();
          }
        }
        return;
      }
      if (prefetchingRef.current.has(videoId)) return;
      prefetchingRef.current.add(videoId);
      api
        .getStream(videoId, title, artist)
        .then((s) => {
          streamCacheRef.current.set(videoId, s);
          if (
            warmAudio &&
            preloaderRef.current &&
            preloaderRef.current.src !== s.url
          ) {
            preloaderRef.current.src = s.url;
            preloaderRef.current.load();
          }
        })
        .catch(() => {})
        .finally(() => {
          prefetchingRef.current.delete(videoId);
        });
    },
    [],
  );

  // Hover prefetch — called when the user hovers a track for 400ms.
  // Starts the yt-dlp extraction before the click so playback is instant.
  const handleHoverPrefetch = useCallback(
    (videoId: string, title = "", artist = "") => {
      prefetchStream(videoId, false, title, artist);
    },
    [prefetchStream],
  );

  // When home loads for the first time, silently prefetch the first 2 song
  // stream URLs. By the time the user clicks one, yt-dlp has already run and
  // the stream starts instantly from the in-process cache.
  useEffect(() => {
    if (!homeShelves.length || homePrefetchedRef.current) return;
    homePrefetchedRef.current = true;
    const items = homeShelves
      .flatMap((s) => s.contents ?? [])
      .filter((r) => r.videoId)
      .slice(0, 2);
    const tid = setTimeout(
      () =>
        items.forEach((it) =>
          prefetchStream(
            it.videoId!,
            false,
            it.title,
            it.artists?.[0]?.name ?? "",
          ),
        ),
      800,
    );
    return () => clearTimeout(tid);
  }, [homeShelves, prefetchStream]);

  // Whenever the playing track changes, prefetch the next two tracks.
  // Only track N+1 gets its audio bytes warmed; N+2 just gets the URL.
  // Lyrics are prefetched for both so they're cached the moment we advance.
  useEffect(() => {
    const q = queueRef.current;
    const idx = queueIdxRef.current;
    if (idx + 1 < q.length) {
      prefetchStream(
        q[idx + 1].videoId,
        true,
        q[idx + 1].title,
        q[idx + 1].artists?.[0]?.name ?? "",
      );
      prefetchLyrics(q[idx + 1]);
    }
    if (idx + 2 < q.length) {
      prefetchStream(
        q[idx + 2].videoId,
        false,
        q[idx + 2].title,
        q[idx + 2].artists?.[0]?.name ?? "",
      );
      prefetchLyrics(q[idx + 2]);
    }
  }, [player.track?.videoId, prefetchStream, prefetchLyrics]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Queue navigation ───────────────────────────────────────────────────────

  const getNextIdx = useCallback((): number => {
    const q = queueRef.current;
    const idx = queueIdxRef.current;
    if (shuffleRef.current && q.length > 1) {
      let r: number;
      do {
        r = Math.floor(Math.random() * q.length);
      } while (r === idx);
      return r;
    }
    return idx + 1;
  }, []);

  const nextTrack = useCallback(() => {
    playFromQueue(getNextIdx());
  }, [playFromQueue, getNextIdx]);

  const prevTrack = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      setPlayer((p) => ({ ...p, currentTime: 0 }));
    } else {
      playFromQueue(queueIdxRef.current - 1);
    }
  }, [playFromQueue]);

  // ── Playback controls ──────────────────────────────────────────────────────

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (player.playing) {
      audio.pause();
      setPlayer((p) => ({ ...p, playing: false }));
    } else {
      audio.play();
      setPlayer((p) => ({ ...p, playing: true }));
    }
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    if (audioRef.current) audioRef.current.currentTime = t;
    setPlayer((p) => ({ ...p, currentTime: t }));
  };

  // Toggle the player-only "widget" mode: shrink to a small always-on-top window that
  // shows only the player. The window remembers the size you last left it at (saved in
  // localStorage as physical px while in widget mode — see the resize effect below), so
  // your preferred widget size becomes the default next time you open it.
  const toggleMiniMode = async () => {
    const next = !miniMode;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { LogicalSize, PhysicalSize } = await import("@tauri-apps/api/dpi");
      const win = getCurrentWindow();
      if (next) {
        await win.setMinSize(new LogicalSize(220, 300));
        const saved = (() => {
          try { return JSON.parse(localStorage.getItem("widgetSize") || "null"); } catch { return null; }
        })();
        await win.setSize(
          saved?.w && saved?.h
            ? new PhysicalSize(saved.w, saved.h)   // your remembered widget size
            : new LogicalSize(300, 480)            // first-time default
        );
        await win.setAlwaysOnTop(true);
        await win.setDecorations(false);
      } else {
        await win.setDecorations(true);
        await win.setAlwaysOnTop(false);
        await win.setMinSize(new LogicalSize(860, 560));
        await win.setSize(new LogicalSize(1100, 720));
      }
    } catch {
      /* not in Tauri (plain browser) — just toggle the layout */
    }
    setMiniMode(next);
  };

  // While in widget mode, remember the window size the user resizes to (physical px),
  // so it becomes the default the next time they open the widget.
  useEffect(() => {
    if (!miniMode) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        unlisten = await getCurrentWindow().onResized(({ payload }) => {
          // Persist only plausible widget sizes (physical px); the < 900 guard ignores
          // the resize back to the full 1100px window when leaving widget mode.
          if (payload.width > 100 && payload.height > 100 && payload.width < 900) {
            localStorage.setItem("widgetSize", JSON.stringify({ w: payload.width, h: payload.height }));
          }
        });
      } catch { /* not in Tauri */ }
    })();
    return () => { unlisten?.(); };
  }, [miniMode]);

  const setVol = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (audioRef.current) audioRef.current.volume = v;
    setPlayer((p) => ({ ...p, volume: v }));
  };

  // ── Right panel toggle ─────────────────────────────────────────────────────

  const togglePanel = (panel: Exclude<RightPanel, null>) => {
    setRightPanel((prev) => (prev === panel ? null : panel));
  };

  // ── Search ─────────────────────────────────────────────────────────────────

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setView("search");
    setShowSuggestions(false);
    setSuggestions([]);
    setLoading(true);
    setError(null);
    try {
      const { results } = await api.search(q, "songs");
      setSearchResults(results);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearchInput = useCallback((value: string) => {
    setSearchQuery(value);
    setShowSuggestions(true);
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (value.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    suggestTimer.current = setTimeout(async () => {
      try {
        const { suggestions } = await api.getSearchSuggestions(value);
        setSuggestions(suggestions.slice(0, 8));
      } catch {
        setSuggestions([]);
      }
    }, SUGGEST_DELAY);
  }, []);

  // ── Artists / Albums search ────────────────────────────────────────────────

  const doArtistSearch = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const { results } = await api.search(q, "artists");
      setArtistResults(results);
    } catch {
      setArtistResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const doAlbumSearch = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const { results } = await api.search(q, "albums");
      setAlbumResults(results);
    } catch {
      setAlbumResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Open Artists/Albums: when YT Music is connected, show YOUR library (InnerTube);
  // otherwise these stay search-only. Search still overwrites the grid on submit.
  const openArtists = useCallback(() => {
    setView("artists");
    if (ytmConnected) {
      api.getLibraryArtists().then((r) => setArtistResults(r.artists ?? [])).catch(() => {});
    }
  }, [ytmConnected]);

  const openAlbums = useCallback(() => {
    setView("albums");
    if (ytmConnected) {
      api.getLibraryAlbums().then((r) => setAlbumResults(r.albums ?? [])).catch(() => {});
    }
  }, [ytmConnected]);

  // ── Library loaders ────────────────────────────────────────────────────────

  const loadLibrary = useCallback(async () => {
    setView("library");
    setLoading(true);
    setError(null);
    try {
      const { playlists } = await api.getYtPlaylists();
      setLibraryPlaylists(playlists);
    } catch {
      setError("Sign in to view your library.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch the user's playlists for the right-panel Library tab WITHOUT switching views.
  const fetchLibraryPlaylists = useCallback(async () => {
    try {
      const { playlists } = await api.getYtPlaylists();
      setLibraryPlaylists(playlists);
    } catch {
      /* not signed in yet / sidecar not armed — leave empty */
    }
  }, []);

  // On sign-in (fresh login or restore), load the user's playlists and open the
  // right panel to the Library tab so they're visible by default — including on Home.
  useEffect(() => {
    if (!authenticated) return;
    fetchLibraryPlaylists();
    setRightPanel("library");
  }, [authenticated, fetchLibraryPlaylists]);

  // Once playlists load for a signed-in account, apply the saved sync choice — or,
  // on first sign-in, open the chooser (pre-selecting all so nothing's hidden yet).
  useEffect(() => {
    if (
      !authenticated ||
      !userProfile?.email ||
      libraryPlaylists.length === 0 ||
      syncedIds !== null
    )
      return;
    const saved = localStorage.getItem(`synced-playlists:${userProfile.email}`);
    if (saved) {
      try {
        setSyncedIds(JSON.parse(saved));
        return;
      } catch {
        /* fall through to chooser */
      }
    }
    setChooserSelection(libraryPlaylists.map((p) => p.playlistId));
    setShowPlaylistChooser(true);
  }, [authenticated, userProfile?.email, libraryPlaylists, syncedIds]);

  // Load each synced playlist's contents so the player can tell which playlists a
  // song is already in (drives the add/remove icons). Cheap: one Data-API read each.
  useEffect(() => {
    if (!authenticated || !syncedIds) {
      setMembership({});
      return;
    }
    let cancelled = false;
    (async () => {
      const result: Record<string, Record<string, string>> = {};
      for (const pl of libraryPlaylists.filter((p) =>
        syncedIds.includes(p.playlistId),
      )) {
        try {
          const { tracks } = await api.getYtPlaylist(pl.playlistId);
          const map: Record<string, string> = {};
          tracks.forEach((t) => {
            if (t.videoId && t.playlistItemId)
              map[t.videoId] = t.playlistItemId;
          });
          result[pl.playlistId] = map;
        } catch {
          /* skip */
        }
      }
      if (!cancelled) setMembership(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, syncedIds, libraryPlaylists]);

  const loadPlaylist = useCallback(async (id: string) => {
    setView("playlist");
    setOpenPlaylist(null);
    setOpenPlaylistOwned(false);
    setLoading(true);
    setError(null);
    try {
      setOpenPlaylist(await api.getPlaylist(id));
    } catch (e) {
      setError(`Failed to load playlist: ${e}`);
      setView("library");
    } finally {
      setLoading(false);
    }
  }, []);

  // Open one of the user's OWN playlists via the YouTube Data API (works with our
  // OAuth token, unlike the InnerTube /playlist path used for public playlists).
  const loadYtPlaylist = useCallback(async (id: string, title: string) => {
    setView("playlist");
    setOpenPlaylist(null);
    setOpenPlaylistOwned(true);
    setLoading(true);
    setError(null);
    try {
      const { tracks } = await api.getYtPlaylist(id);
      setOpenPlaylist({ id, title, tracks, thumbnails: [] });
    } catch (e) {
      setError(`Failed to load playlist: ${e}`);
      setView("library");
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Synced-playlist membership + add/remove (writes back to YouTube) ─────────
  const showNotice = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2500);
  };

  const syncedPlaylists = libraryPlaylists.filter((p) =>
    (syncedIds ?? libraryPlaylists.map((x) => x.playlistId)).includes(
      p.playlistId,
    ),
  );

  // Synced playlists that currently contain a given video (+ the item id to remove it).
  const playlistsWith = (
    videoId?: string,
  ): { pl: api.PlaylistSummary; itemId: string }[] =>
    !videoId
      ? []
      : syncedPlaylists
          .map((pl) => ({
            pl,
            itemId: membership[pl.playlistId]?.[videoId] ?? "",
          }))
          .filter((x) => x.itemId);

  const isAdded = (videoId?: string) => playlistsWith(videoId).length > 0;

  const doAddToPlaylist = async (pl: api.PlaylistSummary, track: Track) => {
    try {
      const res = await api.addToPlaylist(pl.playlistId, track.videoId);
      const itemId = res.playlistItemId ?? "";
      setMembership((m) => ({
        ...m,
        [pl.playlistId]: {
          ...(m[pl.playlistId] || {}),
          [track.videoId]: itemId,
        },
      }));
      showNotice(`Added to ${pl.title}`);
      setOpenPlaylist((p) =>
        p && p.id === pl.playlistId
          ? {
              ...p,
              tracks: [...p.tracks, { ...track, playlistItemId: itemId }],
            }
          : p,
      );
    } catch {
      setError("Couldn't add the song to your playlist.");
    }
  };

  const doRemoveFromPlaylist = async (
    pl: api.PlaylistSummary,
    videoId: string,
  ) => {
    const itemId = membership[pl.playlistId]?.[videoId];
    if (!itemId) return;
    try {
      await api.removeFromPlaylistItem(itemId);
      setMembership((m) => {
        const copy = { ...(m[pl.playlistId] || {}) };
        delete copy[videoId];
        return { ...m, [pl.playlistId]: copy };
      });
      showNotice(`Removed from ${pl.title}`);
      setOpenPlaylist((p) =>
        p && p.id === pl.playlistId
          ? { ...p, tracks: p.tracks.filter((t) => t.videoId !== videoId) }
          : p,
      );
    } catch {
      setError("Couldn't remove the song.");
    }
  };

  const togglePlaylistMembership = (pl: api.PlaylistSummary, track: Track) => {
    if (membership[pl.playlistId]?.[track.videoId])
      doRemoveFromPlaylist(pl, track.videoId);
    else doAddToPlaylist(pl, track);
  };

  // Player add icon: add directly (one playlist) or open the manager (multiple / already-in).
  const handleAddIcon = (track: Track) => {
    if (syncedPlaylists.length === 0) {
      setError("No synced playlist yet — pick one in Settings.");
      return;
    }
    if (syncedPlaylists.length === 1) {
      const pl = syncedPlaylists[0];
      if (membership[pl.playlistId]?.[track.videoId])
        showNotice(`Already in ${pl.title}`);
      else doAddToPlaylist(pl, track);
    } else {
      setManageTrack(track);
    }
  };

  // Player remove icon: remove directly (in one) or open the manager (in several).
  const handleRemoveIcon = (track: Track) => {
    const inPls = playlistsWith(track.videoId);
    if (inPls.length === 0) return;
    if (inPls.length === 1) doRemoveFromPlaylist(inPls[0].pl, track.videoId);
    else setManageTrack(track);
  };

  // TrackTable ✕ on the open (owned) playlist.
  const removeTrack = async (track: Track) => {
    if (!track.playlistItemId || !openPlaylist) return;
    const pid = openPlaylist.id;
    try {
      await api.removeFromPlaylistItem(track.playlistItemId);
      setMembership((m) => {
        const c = { ...(m[pid] || {}) };
        delete c[track.videoId];
        return { ...m, [pid]: c };
      });
      showNotice("Removed from playlist");
      setOpenPlaylist((p) =>
        p
          ? {
              ...p,
              tracks: p.tracks.filter(
                (t) => t.playlistItemId !== track.playlistItemId,
              ),
            }
          : p,
      );
    } catch {
      setError("Couldn't remove the song.");
    }
  };

  const loadLiked = useCallback(async () => {
    setView("liked");
    setLoading(true);
    setError(null);
    try {
      setLikedSongs((await api.getLikedSongs()).tracks ?? []);
    } catch {
      setError("Couldn't load your liked songs. Try again, or re-sign in.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setView("history");
    setLoading(true);
    setError(null);
    try {
      setHistory((await api.getHistory()).history ?? []);
    } catch {
      setError("Couldn't load your recently played history.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Before navigating INTO a detail page, record where we are so "← Back" can
  // return. If we're already on a detail page (artist/album), push its snapshot
  // onto the stack; otherwise we're entering from a list/root view — remember
  // that as the stack's floor and start a fresh chain.
  const pushCurrentPage = useCallback(() => {
    const v = viewRef.current;
    if (v === "artist" && openArtistRef.current) {
      navStackRef.current = [
        ...navStackRef.current,
        { kind: "artist", data: openArtistRef.current },
      ];
    } else if (v === "album" && openAlbumRef.current) {
      navStackRef.current = [
        ...navStackRef.current,
        { kind: "album", data: openAlbumRef.current },
      ];
    } else {
      rootViewRef.current = v;
      navStackRef.current = [];
    }
  }, []);

  const loadArtist = useCallback(
    async (browseId: string) => {
      pushCurrentPage();
      setView("artist");
      setOpenArtist(null);
      setOpenAlbum(null);
      setLoading(true);
      setError(null);
      try {
        setOpenArtist(await api.getArtist(browseId));
      } catch {
        setError("Failed to load artist page.");
      } finally {
        setLoading(false);
      }
    },
    [pushCurrentPage],
  );

  const loadAlbum = useCallback(
    async (browseId: string) => {
      pushCurrentPage();
      setView("album");
      setOpenAlbum(null);
      setOpenArtist(null);
      setLoading(true);
      setError(null);
      try {
        setOpenAlbum(await api.getAlbum(browseId));
      } catch {
        setError("Failed to load album.");
      } finally {
        setLoading(false);
      }
    },
    [pushCurrentPage],
  );

  // Single back handler for every detail page. Pop the previous snapshot and
  // restore it (instant — no re-fetch); when the stack is empty, return to the
  // root/list view we came from. This never lands on a detail view with null
  // data, so the black-screen-after-N-backs class of bug cannot recur.
  const goBack = useCallback(() => {
    const stack = navStackRef.current;
    if (stack.length > 0) {
      const prev = stack[stack.length - 1];
      navStackRef.current = stack.slice(0, -1);
      if (prev.kind === "artist") {
        setOpenArtist(prev.data);
        setOpenAlbum(null);
        setView("artist");
      } else {
        setOpenAlbum(prev.data);
        setOpenArtist(null);
        setView("album");
      }
    } else {
      setOpenArtist(null);
      setOpenAlbum(null);
      setView(rootViewRef.current);
    }
  }, []);

  // ── Auth ───────────────────────────────────────────────────────────────────

  const handleLogin = async () => {
    setError(null);
    let unlisten: (() => void) | undefined;
    try {
      // Device flow: the Rust shell opens the Google verification page and emits
      // the user code mid-flow; we show it until sign-in resolves.
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ user_code: string; verification_url: string }>(
        "oauth-device-code",
        (e) =>
          setDeviceCode({
            code: e.payload.user_code,
            url: e.payload.verification_url,
          }),
      );
      const id = await api.oauthBegin();
      setUserProfile({
        name: id.name || id.email,
        photoUrl: id.picture || "",
        email: id.email,
      });
      setAuthenticated(true);
      // Write the compliant first-login record (idempotent). If we raced past the
      // ≤100 cap (brand-new 101st account), undo the sign-in and tell the user.
      try {
        const rec = await api.recordFirstLogin();
        if (rec.error === "signups_full") {
          setSignupsOpen(false);
          await handleSignOut();
          setError("Sign-ups are full (100 accounts). Using guest mode.");
        }
      } catch {
        /* record is best-effort; never block the session on it */
      }
    } catch (e) {
      setError(`Sign-in failed: ${e}`);
    } finally {
      unlisten?.();
      setDeviceCode(null);
    }
  };

  // Clicking "Sign in" shows the transparency notice first (GDPR Art. 13); the user
  // chooses to continue, which is the informed agreement, then the OAuth flow runs.
  const beginSignIn = () => {
    setError(null);
    setShowSignInNotice(true);
  };
  const confirmSignIn = () => {
    setShowSignInNotice(false);
    handleLogin();
  };

  const handleSignOut = async () => {
    setSettingsOpen(false);
    await api.oauthLogout();
    setAuthenticated(false);
    setUserProfile(null);
    setSyncedIds(null);
    setShowPlaylistChooser(false);
    setLibraryPlaylists([]);
  };

  const handleExportData = async () => {
    setSettingsOpen(false);
    try {
      const r = await api.getMyData();
      setMyData(
        JSON.stringify(r.data ?? { note: "No record found." }, null, 2),
      );
    } catch (e) {
      setError(`Couldn't export your data: ${e}`);
    }
  };

  const handleDeleteData = async () => {
    setSettingsOpen(false);
    if (
      !window.confirm(
        "Permanently delete your account record (name, email, sign-in time, location)?\n\n" +
          "This also signs you out and revokes the app's Google access. You can sign in again anytime.",
      )
    )
      return;
    try {
      await api.deleteMyData(); // erase the Supabase row
      await handleSignOut(); // revoke Google token + clear keychain/session
      setError("Your account record was deleted. You're now in guest mode.");
    } catch (e) {
      setError(`Couldn't delete your data: ${e}`);
    }
  };

  // ── YouTube Music session-cookie connect ─────────────────────────────────────
  const connectYtMusic = async () => {
    setSettingsOpen(false);
    setError(null);
    try {
      await api.ytmConnectBegin();   // opens the in-app login window
      setYtmConnectOpen(true);       // show the "I've signed in" prompt
    } catch (e) {
      setError(`Couldn't open the YouTube Music login: ${e}`);
    }
  };

  const finishYtMusic = async () => {
    setYtmBusy(true);
    setError(null);
    try {
      // Step 1: read the cookie + install it in the sidecar (fast — returns immediately).
      const r = await api.ytmConnectFinish();
      if (!r.ok) {
        setError(`Couldn't read your session: ${r.error ?? "no session found"}`);
        return;
      }
      // Step 2: verify it actually unlocks InnerTube (one authenticated call).
      const t = await api.ytmTest();
      if (t.ok) {
        setYtmConnected(true);
        setYtmConnectOpen(false);
        showNotice(`Connected to YouTube Music ✓${t.playlistCount != null ? ` — ${t.playlistCount} library playlist(s)` : ""}`);
        // Refresh the home to your personalized feed now that InnerTube is unlocked.
        api.getHome().then(({ shelves }) => setHomeShelves(shelves)).catch(() => {});
      } else {
        setError(`Session installed but YouTube rejected it: ${t.error ?? "unknown error"}`);
      }
    } catch (e) {
      setError(`Connect failed: ${e}`);
    } finally {
      setYtmBusy(false);
    }
  };

  const disconnectYtMusic = async () => {
    setSettingsOpen(false);
    try {
      await api.ytmDisconnect();
      setYtmConnected(false);
      showNotice("Disconnected from YouTube Music.");
    } catch (e) {
      setError(`Couldn't disconnect: ${e}`);
    }
  };

  // ── Playlist sync selection ──────────────────────────────────────────────────
  const toggleChooser = (id: string) =>
    setChooserSelection((sel) =>
      sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id],
    );

  const openPlaylistChooser = () => {
    setSettingsOpen(false);
    setChooserSelection(syncedIds ?? libraryPlaylists.map((p) => p.playlistId));
    setShowPlaylistChooser(true);
  };

  const savePlaylistSelection = () => {
    setSyncedIds(chooserSelection);
    if (userProfile?.email) {
      localStorage.setItem(
        `synced-playlists:${userProfile.email}`,
        JSON.stringify(chooserSelection),
      );
    }
    setShowPlaylistChooser(false);
  };

  // ── Downloads ──────────────────────────────────────────────────────────────

  const handleDownload = useCallback(async (track: Track) => {
    const { videoId } = track;
    setDlStatus((s) => ({ ...s, [videoId]: "loading" }));
    const finish = (state: DlState) => {
      setDlStatus((s) => ({ ...s, [videoId]: state }));
      setTimeout(
        () =>
          setDlStatus((s) => {
            const n = { ...s };
            delete n[videoId];
            return n;
          }),
        4000,
      );
    };
    try {
      await api.downloadTrack(videoId, DOWNLOAD_DIR);
      finish("done");
    } catch {
      finish("error");
    }
  }, []);

  // ── Album art colour extraction ────────────────────────────────────────────
  // Draws the loaded image to a tiny offscreen canvas and averages the
  // mid-range pixels to get a saturated accent colour. Falls back silently
  // if the browser blocks canvas read (CORS taint).
  const extractColor = useCallback((img: HTMLImageElement) => {
    try {
      const canvas = document.createElement("canvas");
      const S = 16;
      canvas.width = S;
      canvas.height = S;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, S, S);
      const data = ctx.getImageData(0, 0, S, S).data;
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (lum < 20 || lum > 220) continue; // skip near-black / near-white
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
      if (!n) return;
      // Boost the dominant channel to get a vivid accent
      const ar = r / n,
        ag = g / n,
        ab = b / n;
      const peak = Math.max(ar, ag, ab);
      const scale = peak > 0 ? 255 / peak : 1;
      setPlayerAccent(
        `rgb(${Math.round(ar * scale * 0.9)},${Math.round(ag * scale * 0.9)},${Math.round(ab * scale * 0.9)})`,
      );
    } catch {
      /* CORS blocked — keep previous accent */
    }
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────────

  const progressPct =
    player.duration > 0 ? (player.currentTime / player.duration) * 100 : 0;
  const volumePct = player.volume * 100;
  const showStrip = view !== "home" || !!player.track || authenticated;
  const panelOpen = rightPanel !== null && showStrip;
  // Playlists the user chose to sync (all of them until a choice is made).
  const visiblePlaylists = syncedIds
    ? libraryPlaylists.filter((p) => syncedIds.includes(p.playlistId))
    : libraryPlaylists;
  const appClass = [
    "app",
    panelOpen ? "panel-open" : showStrip ? "has-strip" : "",
    miniMode ? "mini-mode" : "",
  ].filter(Boolean).join(" ");

  // Parsed once per lyrics change — not on every render. Avoids the regex
  // scan running 60×/sec during karaoke playback.
  const syncedLines = useMemo(
    () => (lyrics?.synced ? parseLrc(lyrics.synced) : []),
    [lyrics?.synced],
  );

  // ── Loading screen ─────────────────────────────────────────────────────────

  if (!sidecarReady) {
    return (
      <div className="loading-screen">
        <div className="loading-logo">♫</div>
        <p>Starting YouTube Music…</p>
        <div className="spinner" />
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={appClass}>
      <audio
        ref={audioRef}
        preload="auto"
        onTimeUpdate={() =>
          setPlayer((p) => ({
            ...p,
            currentTime: audioRef.current?.currentTime ?? 0,
          }))
        }
        onEnded={() => {
          if (repeatRef.current) {
            if (audioRef.current) {
              audioRef.current.currentTime = 0;
              audioRef.current.play();
            }
            return;
          }
          const next = getNextIdx();
          if (next < queueRef.current.length) playFromQueue(next);
          else setPlayer((p) => ({ ...p, playing: false }));
        }}
      />
      {/* Hidden preloader — pre-warms HTTP cache for the next track's audio bytes
          so playback starts in ~50 ms instead of waiting for the CDN handshake. */}
      <audio
        ref={preloaderRef}
        preload="auto"
        muted
        style={{ display: "none" }}
      />

      {/* (Removed) old overlay-based widget. Widget mode now styles the REAL player
          in place via the `.mini-mode` class on .app — see the mini-winbar rendered
          inside .left-player and the .app.mini-mode rules in App.css. */}

      {/* Pre-sign-in transparency notice (GDPR Art. 13). Choosing to continue is the
          informed agreement; staying in guest mode keeps full search/play, no record. */}
      {showSignInNotice && (
        <div
          className="chooser-overlay"
          onClick={() => setShowSignInNotice(false)}
        >
          <div className="chooser-card" onClick={(e) => e.stopPropagation()}>
            <div className="chooser-title">Before you sign in</div>
            <p className="notice-body">
              Signing in with Google creates an account record on our server
              your
              <strong> name</strong>, <strong>email</strong>,{" "}
              <strong>sign-in time</strong>, and
              <strong> approximate city</strong> used only to operate and secure
              your account (sync your playlists, liked songs and settings).
            </p>
            <ul className="notice-points">
              <li>We never sell your data or use your email for marketing.</li>
              <li>Export or delete it anytime from Settings.</li>
              <li>
                Inactive accounts are automatically removed after 6 months.
              </li>
              <li>
                Prefer no record? <strong>Stay in guest mode</strong> full
                search & playback, nothing stored.
              </li>
            </ul>
            <p className="notice-policy">
              See the{" "}
              <span
                className="link-like"
                onClick={() => setMyData("__privacy__")}
              >
                Privacy Policy
              </span>
              .
            </p>
            <div className="chooser-actions">
              <button
                className="btn-ghost"
                onClick={() => setShowSignInNotice(false)}
              >
                Cancel
              </button>
              <button className="btn-primary" onClick={confirmSignIn}>
                Continue with Google
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Data-subject export: show the stored record as JSON. */}
      {myData !== null && (
        <div className="chooser-overlay" onClick={() => setMyData(null)}>
          <div
            className={`chooser-card ${myData === "__privacy__" ? "chooser-card-wide" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="chooser-title">
              {myData === "__privacy__" ? "Privacy Policy" : "Your data"}
            </div>
            {myData === "__privacy__" ? (
              <div className="privacy-md">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    // Open links in the system browser, never inside the app webview.
                    a: ({ href, children }) => (
                      <span
                        className="link-like"
                        onClick={async () => {
                          if (!href) return;
                          try {
                            const { openUrl } =
                              await import("@tauri-apps/plugin-opener");
                            await openUrl(href);
                          } catch {
                            /* not in Tauri / opener unavailable */
                          }
                        }}
                      >
                        {children}
                      </span>
                    ),
                  }}
                >
                  {privacyText}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="data-export">{myData}</pre>
            )}
            <div className="chooser-actions">
              <button className="btn-primary" onClick={() => setMyData(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* YouTube Music connect: prompt to finish after the user signs into the login window */}
      {ytmConnectOpen && (
        <div className="chooser-overlay" onClick={() => !ytmBusy && setYtmConnectOpen(false)}>
          <div className="chooser-card" onClick={(e) => e.stopPropagation()}>
            <div className="chooser-title">Connect YouTube Music</div>
            <p className="notice-body">
              A YouTube Music window opened — <strong>sign in there</strong>. Once you're
              signed in and see your YT Music home, click below and we'll connect your
              session to unlock your personalized home, library artists/albums, real liked
              songs and history.
            </p>
            <p className="notice-policy">
              Your session cookie stays on this device (OS keychain) — never sent to our server.
            </p>
            <div className="chooser-actions">
              <button className="btn-ghost" disabled={ytmBusy} onClick={() => setYtmConnectOpen(false)}>Cancel</button>
              <button className="btn-primary" disabled={ytmBusy} onClick={finishYtMusic}>
                {ytmBusy ? "Connecting…" : "I've signed in"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Device-flow sign-in: show the code while the user authorizes in the browser */}
      {deviceCode && (
        <div className="device-code-overlay">
          <div className="device-code-card">
            <div className="device-code-title">
              Finish signing in with Google
            </div>
            <p className="device-code-sub">
              A browser window opened. Enter this code to authorize:
            </p>
            <div className="device-code-value">{deviceCode.code}</div>
            <p className="device-code-url">at {deviceCode.url}</p>
          </div>
        </div>
      )}

      {/* Choose which playlists to sync into the app */}
      {showPlaylistChooser && (
        <div className="chooser-overlay">
          <div className="chooser-card">
            <div className="chooser-title">Choose playlists to sync</div>
            <p className="chooser-sub">
              Only the playlists you pick will appear in your library.
            </p>
            <div className="chooser-list">
              {libraryPlaylists.length === 0 ? (
                <div className="lyrics-none">
                  No playlists found on your account.
                </div>
              ) : (
                libraryPlaylists.map((pl) => (
                  <label key={pl.playlistId} className="chooser-item">
                    <input
                      type="checkbox"
                      checked={chooserSelection.includes(pl.playlistId)}
                      onChange={() => toggleChooser(pl.playlistId)}
                    />
                    <div className="chooser-thumb">
                      {pl.thumbnails?.[0] ? (
                        <img src={thumb(pl.thumbnails, 80)} alt="" />
                      ) : (
                        <span>♫</span>
                      )}
                    </div>
                    <div className="chooser-info">
                      <div className="chooser-name">{pl.title}</div>
                      <div className="chooser-count">
                        {pl.count ?? ""} songs
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
            <div className="chooser-actions">
              <span className="chooser-counter">
                {chooserSelection.length} selected
              </span>
              <div style={{ flex: 1 }} />
              <button
                className="btn-secondary"
                onClick={() => setShowPlaylistChooser(false)}
              >
                Cancel
              </button>
              <button
                className="btn-primary small"
                onClick={savePlaylistSelection}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manage which synced playlists this song is in (add/remove via checkbox) */}
      {manageTrack && (
        <div className="chooser-overlay" onClick={() => setManageTrack(null)}>
          <div className="chooser-card" onClick={(e) => e.stopPropagation()}>
            <div className="chooser-title">Add to playlist</div>
            <p className="chooser-sub">{manageTrack.title}</p>
            <div className="chooser-list">
              {syncedPlaylists.map((pl) => {
                const inIt = !!membership[pl.playlistId]?.[manageTrack.videoId];
                return (
                  <label key={pl.playlistId} className="chooser-item">
                    <input
                      type="checkbox"
                      checked={inIt}
                      onChange={() => togglePlaylistMembership(pl, manageTrack)}
                    />
                    <div className="chooser-thumb">
                      {pl.thumbnails?.[0] ? (
                        <img src={thumb(pl.thumbnails, 80)} alt="" />
                      ) : (
                        <span>♫</span>
                      )}
                    </div>
                    <div className="chooser-info">
                      <div className="chooser-name">{pl.title}</div>
                      <div className="chooser-count">
                        {inIt ? "Added ✓" : `${pl.count ?? ""} songs`}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="chooser-actions">
              <div style={{ flex: 1 }} />
              <button
                className="btn-primary small"
                onClick={() => setManageTrack(null)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && <div className="notice-toast">{notice}</div>}

      {/* ══════════════════════════════════════════════════════════════════
          LEFT PANEL
          ══════════════════════════════════════════════════════════════════ */}
      <aside className="sidebar">
        {/*
          .sidebar-top scrolls internally when the window is short.
          The player and footer live OUTSIDE it — always pinned to the bottom.
        */}
        <div className="sidebar-top">
          {/* User section */}
          <div className="user-section">
            {authenticated && userProfile ? (
              <div className="user-card">
                <div className="user-avatar-lg">
                  <span className="user-avatar-fallback">
                    {(userProfile.name || userProfile.email || "?")
                      .charAt(0)
                      .toUpperCase()}
                  </span>
                  {userProfile.photoUrl && (
                    <img
                      src={userProfile.photoUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  )}
                </div>
                <div className="user-name-lg">{userProfile.name}</div>
                {userProfile.email && (
                  <div className="user-email-lg">{userProfile.email}</div>
                )}
                <div className="user-actions-row">
                  <div className="settings-wrap">
                    <button
                      className="user-icon-btn"
                      title="Settings"
                      onClick={() => setSettingsOpen((o) => !o)}
                    >
                      <SettingsIcon />
                    </button>
                    {settingsOpen && (
                      <>
                        <div
                          className="menu-overlay"
                          onClick={() => setSettingsOpen(false)}
                        />
                        <div className="settings-menu">
                          <button
                            className="settings-item"
                            onClick={ytmConnected ? disconnectYtMusic : connectYtMusic}
                          >
                            {ytmConnected ? "Disconnect YouTube Music" : "Connect YouTube Music"}
                          </button>
                          <button
                            className="settings-item"
                            onClick={openPlaylistChooser}
                          >
                            Manage synced playlists
                          </button>
                          <button
                            className="settings-item"
                            onClick={handleExportData}
                          >
                            Export my data
                          </button>
                          <button
                            className="settings-item"
                            onClick={() => {
                              setSettingsOpen(false);
                              setMyData("__privacy__");
                            }}
                          >
                            Privacy Policy
                          </button>
                          <button
                            className="settings-item settings-item-danger"
                            onClick={handleDeleteData}
                          >
                            Delete my data
                          </button>
                          <button
                            className="settings-item"
                            onClick={handleSignOut}
                          >
                            Sign out
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <button className="user-icon-btn" title="Notifications">
                    <BellIcon />
                  </button>
                  <span className="badge-free">Free</span>
                </div>
              </div>
            ) : authenticated ? (
              <div className="user-row">
                <div className="avatar-placeholder">👤</div>
                <span className="user-name">Loading…</span>
              </div>
            ) : (
              <div className="signin-placeholder">
                <div className="avatar-placeholder">👤</div>
                <button className="btn-primary small" onClick={beginSignIn}>
                  Sign in with Google
                </button>
                {signupsOpen === false && (
                  <div className="signups-full-note">
                    Sign-ups are full — using guest mode. Existing users can
                    still sign in.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Nav */}
          <nav className="sidebar-nav">
            <button
              className={`nav-item ${view === "home" ? "active" : ""}`}
              onClick={() => setView("home")}
            >
              <span className="nav-icon">🏠</span> Home
            </button>
            <button
              className={`nav-item ${view === "explore" ? "active" : ""}`}
              onClick={() => setView("explore")}
            >
              <span className="nav-icon">🧭</span> Explore
            </button>
            <button
              className={`nav-item ${view === "history" ? "active" : ""}`}
              onClick={loadHistory}
            >
              <span className="nav-icon">🕐</span> Recently Played
            </button>
            <button
              className={`nav-item ${view === "liked" ? "active" : ""}`}
              onClick={loadLiked}
            >
              <span className="nav-icon">❤️</span> Liked Songs
            </button>
            <button
              className={`nav-item ${view === "artists" ? "active" : ""}`}
              onClick={openArtists}
            >
              <span className="nav-icon">👤</span> Artists
            </button>
            <button
              className={`nav-item ${view === "albums" ? "active" : ""}`}
              onClick={openAlbums}
            >
              <span className="nav-icon">💿</span> Albums
            </button>
            <button className="nav-item disabled">
              <span className="nav-icon">🎙️</span> Podcasts
            </button>
          </nav>
        </div>
        {/* end .sidebar-top */}

        {/* Player — outside sidebar-top, always pinned to bottom */}
        {player.track && (
          <div
            className="left-player"
            style={
              playerAccent
                ? ({ "--player-accent": playerAccent } as React.CSSProperties)
                : undefined
            }
          >
            {/* Layer 1: blurred album art fills the background */}
            <div
              className="left-player-bg"
              style={{
                backgroundImage: `url(${thumb(player.track.thumbnails, 80) || player.streamThumb || ytFallback(player.track.videoId)})`,
              }}
            />

            {/* Layer 2: dark glass sheet */}
            <div className="left-player-glass" />

            {/* Layer 3: accent radial glow from bottom-left corner */}
            <div className="left-player-accent" />

            {/* Layer 4: actual player content */}
            <div className="left-player-content">
              {/* Widget-mode title bar: drag handle + window buttons (only shown when
                  the window is shrunk to the player-only widget). */}
              {miniMode && (
                <div className="mini-winbar" data-tauri-drag-region>
                  <button
                    className="mini-win-btn"
                    title="Minimize"
                    onClick={async () => {
                      try {
                        const { getCurrentWindow } = await import("@tauri-apps/api/window");
                        await getCurrentWindow().minimize();
                      } catch { /* not in Tauri */ }
                    }}
                  >‒</button>
                  <button className="mini-win-btn" title="Back to full app" onClick={toggleMiniMode}>⤢</button>
                </div>
              )}
              <div className="left-player-art" data-tauri-drag-region={miniMode ? "" : undefined}>
                <img
                  key={
                    thumb(player.track.thumbnails, 160) ||
                    player.streamThumb ||
                    ytFallback(player.track.videoId)
                  }
                  src={
                    thumb(player.track.thumbnails, 160) ||
                    player.streamThumb ||
                    ytFallback(player.track.videoId)
                  }
                  alt=""
                  onLoad={(e) => extractColor(e.currentTarget)}
                  onError={thumbOnError(player.track.videoId)}
                />
              </div>
              <div className="left-player-info" data-tauri-drag-region={miniMode ? "" : undefined}>
                <span className="left-player-title">{player.track.title}</span>
                <span className="left-player-artist">
                  {player.track.artists?.map((a, i) => (
                    <span key={i}>
                      {i > 0 && ", "}
                      {a.id ? (
                        <span
                          className="artist-link"
                          onClick={() => loadArtist(a.id!)}
                        >
                          {a.name}
                        </span>
                      ) : (
                        a.name
                      )}
                    </span>
                  )) ?? ""}
                </span>
              </div>
              <div className="progress-row">
                <span className="time-label">{fmt(player.currentTime)}</span>
                <input
                  type="range"
                  className="progress-slider"
                  style={{
                    background: sliderFill(progressPct, "var(--accent)"),
                  }}
                  min={0}
                  max={player.duration || 100}
                  value={player.currentTime}
                  onChange={seek}
                />
                <span className="time-label">{fmt(player.duration)}</span>
              </div>
              <div className="transport">
                <button
                  className={`ctrl-btn ctrl-side ${shuffle ? "active" : ""}`}
                  onClick={() => setShuffle((s) => !s)}
                  title="Shuffle"
                >
                  <ShuffleIcon />
                </button>
                <button className="ctrl-btn ctrl-skip" onClick={prevTrack}>
                  <PrevIcon />
                </button>
                <button
                  className={`ctrl-btn ctrl-play ${!player.streamUrl ? "loading" : ""}`}
                  onClick={togglePlay}
                  disabled={!player.streamUrl}
                >
                  {!player.streamUrl ? (
                    <span className="ctrl-spin">⟳</span>
                  ) : player.playing ? (
                    <PauseIcon />
                  ) : (
                    <PlayIcon />
                  )}
                </button>
                <button
                  className="ctrl-btn ctrl-skip"
                  onClick={nextTrack}
                  disabled={!shuffle && queueIdx >= queue.length - 1}
                >
                  <NextIcon />
                </button>
                <button
                  className={`ctrl-btn ctrl-side ${repeat ? "active" : ""}`}
                  onClick={() => setRepeat((r) => !r)}
                  title="Repeat"
                >
                  <RepeatIcon />
                </button>
              </div>
              <div className="volume-row">
                {/* Left: action buttons, aligned with the title's left edge */}
                <div className="volume-btns">
                  {/* Enter-widget button — hidden in widget mode (the top-right ⤢ exits there). */}
                  {!miniMode && (
                    <button
                      className="player-pl-btn"
                      title="Mini player (widget mode)"
                      onClick={toggleMiniMode}
                    >
                      <MiniPlayerIcon />
                    </button>
                  )}
                  {authenticated && (
                    <button
                      className={`player-pl-btn ${isAdded(player.track.videoId) ? "active" : ""}`}
                      title={
                        isAdded(player.track.videoId)
                          ? "In your playlist — manage"
                          : "Add to playlist"
                      }
                      onClick={() => handleAddIcon(player.track!)}
                    >
                      <PlaylistAddIcon />
                    </button>
                  )}
                  {authenticated && (
                    <button
                      className="player-pl-remove"
                      title="Remove from playlist"
                      onClick={() => handleRemoveIcon(player.track!)}
                    >
                      <PlaylistRemoveIcon />
                    </button>
                  )}
                </div>
                {/* Right: volume control, aligned with the title's right edge */}
                <div className="volume-control">
                  <span className="vol-icon">
                    <VolumeIcon />
                  </span>
                  <input
                    type="range"
                    className="volume-slider"
                    style={{ background: sliderFill(volumePct, "var(--text2)") }}
                    min={0}
                    max={1}
                    step={0.01}
                    value={player.volume}
                    onChange={setVol}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </aside>

      {/* ══════════════════════════════════════════════════════════════════
          MAIN CONTENT
          ══════════════════════════════════════════════════════════════════ */}
      <main className="main-content">
        {/* Topbar: search + optional auth banner */}
        <div className="topbar">
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              doSearch(searchQuery);
            }}
          >
            <span className="search-icon">
              <SearchIcon size={15} color="#000" />
            </span>
            <input
              className="search-input"
              type="text"
              placeholder="What do you want to play?"
              value={searchQuery}
              autoComplete="off"
              onChange={(e) => handleSearchInput(e.target.value)}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              onBlur={() => setShowSuggestions(false)}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div className="suggestions-dropdown">
                {suggestions.map((s, i) => (
                  <div
                    key={i}
                    className="suggestion-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSearchQuery(s);
                      doSearch(s);
                    }}
                  >
                    <span className="suggest-icon">
                      <SearchIcon size={13} color="var(--text3)" />
                    </span>
                    {s}
                  </div>
                ))}
              </div>
            )}
          </form>

          <div className="topbar-actions">
            <button
              className="theme-toggle"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              title={
                theme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
            {!authenticated && (
              <button className="btn-primary small" onClick={beginSignIn}>
                Sign in
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="error-bar" onClick={() => setError(null)}>
            ⚠ {error}
          </div>
        )}
        {loading && <div className="page-spinner" />}

        {/* ── Home ──────────────────────────────────────────────────────── */}
        {view === "home" && !loading && (
          <div className="page">
            {homeShelves.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">♫</div>
                <p>Loading…</p>
              </div>
            ) : (
              homeShelves.map((shelf, i) => (
                <section key={i} className="shelf">
                  <div className="shelf-header">
                    <h2 className="shelf-title">{shelf.title}</h2>
                    {shelf.browseId && (
                      <button
                        className="shelf-more-btn"
                        onClick={() => loadPlaylist(shelf.browseId!)}
                      >
                        See all →
                      </button>
                    )}
                  </div>
                  <div className="shelf-grid">
                    {shelf.contents?.slice(0, 8).map((item, j) => (
                      <TrackCard
                        key={
                          item.videoId ?? item.playlistId ?? item.browseId ?? j
                        }
                        item={item}
                        onPlay={playTrack}
                        currentId={player.track?.videoId}
                        playing={player.playing}
                        onArtistClick={loadArtist}
                        onPlaylistOpen={loadPlaylist}
                        onHover={handleHoverPrefetch}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        )}

        {/* ── Search results ──────────────────────────────────────────────── */}
        {view === "search" && !loading && (
          <div className="page">
            <h2 className="page-title">
              {searchResults.length > 0
                ? `Results for "${searchQuery}"`
                : "Search"}
            </h2>
            {searchResults.length === 0 ? (
              <div className="empty-state">
                <p>Type something and press Enter.</p>
              </div>
            ) : (
              <TrackTable
                tracks={searchResults as unknown as Track[]}
                currentId={player.track?.videoId}
                playing={player.playing}
                onPlay={playTrack}
                onDownload={handleDownload}
                dlStatus={dlStatus}
                showAlbum
                onArtistClick={loadArtist}
                onToggle={togglePlay}
                onHover={handleHoverPrefetch}
              />
            )}
          </div>
        )}

        {/* ── Library ─────────────────────────────────────────────────────── */}
        {view === "library" && !loading && (
          <div className="page">
            <div className="library-header">
              <h2 className="page-title">Library</h2>
              {authenticated && libraryPlaylists.length > 0 && (
                <button
                  className="btn-secondary tiny"
                  onClick={openPlaylistChooser}
                >
                  Manage synced playlists
                </button>
              )}
            </div>
            {visiblePlaylists.length === 0 ? (
              <div className="empty-state">
                <p>
                  {!authenticated
                    ? "Sign in to see your library."
                    : libraryPlaylists.length === 0
                      ? "No playlists found."
                      : "No synced playlists yet — click “Manage synced playlists” to pick some."}
                </p>
              </div>
            ) : (
              <div className="shelf-grid">
                {visiblePlaylists.map((pl) => (
                  <div
                    key={pl.playlistId}
                    className="card"
                    onClick={() => loadYtPlaylist(pl.playlistId, pl.title)}
                  >
                    <div className="card-thumb">
                      {pl.thumbnails?.[0] && (
                        <img src={thumb(pl.thumbnails, 200)} alt={pl.title} />
                      )}
                      <div className="card-play-btn">
                        <PlayIcon />
                      </div>
                    </div>
                    <div className="card-title">{pl.title}</div>
                    <div className="card-sub">{pl.count ?? ""} songs</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Playlist detail ──────────────────────────────────────────────── */}
        {view === "playlist" && !loading && openPlaylist && (
          <div className="page">
            <div className="page-header">
              <button className="back-btn" onClick={() => setView("library")}>
                ← Library
              </button>
              <h2 className="page-title">{openPlaylist.title}</h2>
              <span className="track-count">
                {openPlaylist.tracks.length} songs
              </span>
            </div>
            <TrackTable
              tracks={openPlaylist.tracks}
              currentId={player.track?.videoId}
              playing={player.playing}
              onPlay={playTrack}
              onDownload={handleDownload}
              dlStatus={dlStatus}
              showAlbum
              onArtistClick={loadArtist}
              onToggle={togglePlay}
              onHover={handleHoverPrefetch}
              onRemove={openPlaylistOwned ? removeTrack : undefined}
            />
          </div>
        )}

        {/* ── Liked songs ──────────────────────────────────────────────────── */}
        {view === "liked" && !loading && (
          <div className="page">
            <h2 className="page-title">Liked Songs</h2>
            {likedSongs.length === 0 ? (
              <div className="empty-state">
                <p>{authenticated ? "No liked songs." : "Sign in."}</p>
              </div>
            ) : (
              <TrackTable
                tracks={likedSongs}
                currentId={player.track?.videoId}
                playing={player.playing}
                onPlay={playTrack}
                onDownload={handleDownload}
                dlStatus={dlStatus}
                showAlbum
                onArtistClick={loadArtist}
                onToggle={togglePlay}
                onHover={handleHoverPrefetch}
              />
            )}
          </div>
        )}

        {/* ── History ──────────────────────────────────────────────────────── */}
        {view === "history" && !loading && (
          <div className="page">
            <h2 className="page-title">Recently Played</h2>
            {history.length === 0 ? (
              <div className="empty-state">
                <p>Nothing played yet. Play a song and it'll show up here.</p>
              </div>
            ) : (
              <TrackTable
                tracks={history as unknown as Track[]}
                currentId={player.track?.videoId}
                playing={player.playing}
                onPlay={playTrack}
                onDownload={handleDownload}
                dlStatus={dlStatus}
                onArtistClick={loadArtist}
                onToggle={togglePlay}
                onHover={handleHoverPrefetch}
              />
            )}
          </div>
        )}

        {/* ── Artist page ──────────────────────────────────────────────────── */}
        {view === "artist" && !loading && openArtist && (
          <div className="page artist-page">
            {/* Header */}
            <div
              className="artist-header"
              style={
                openArtist.thumbnails?.[0]
                  ? {
                      backgroundImage: `url(${thumb(openArtist.thumbnails, 800)})`,
                    }
                  : undefined
              }
            >
              <button className="artist-back-btn" onClick={goBack}>
                ← Back
              </button>
              <div className="artist-header-content">
                <div className="artist-header-avatar">
                  {openArtist.thumbnails?.[0] && (
                    <img
                      src={thumb(openArtist.thumbnails, 200)}
                      alt=""
                      onError={thumbOnError()}
                    />
                  )}
                </div>
                <div className="artist-header-info">
                  <div className="artist-verified">✓ Verified Artist</div>
                  <h1 className="artist-name">{openArtist.name}</h1>
                  {openArtist.subscribers && (
                    <div className="artist-subs">
                      {openArtist.subscribers} subscribers
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="artist-body">
              {/* Top Songs */}
              {(openArtist.songs?.results?.length ?? 0) > 0 && (
                <section className="artist-section">
                  <h2 className="artist-section-title">Songs</h2>
                  <TrackTable
                    tracks={openArtist.songs!.results as unknown as Track[]}
                    currentId={player.track?.videoId}
                    playing={player.playing}
                    onPlay={playTrack}
                    onDownload={handleDownload}
                    dlStatus={dlStatus}
                    onArtistClick={loadArtist}
                    onToggle={togglePlay}
                    onHover={handleHoverPrefetch}
                  />
                </section>
              )}

              {/* Albums */}
              {(openArtist.albums?.results?.length ?? 0) > 0 && (
                <section className="artist-section">
                  <h2 className="artist-section-title">Albums</h2>
                  <div className="artist-cards-scroll">
                    {openArtist.albums!.results.map((album, i) => (
                      <div
                        key={album.browseId ?? i}
                        className={`card ${album.browseId ? "card-clickable" : ""}`}
                        onClick={() =>
                          album.browseId && loadAlbum(album.browseId)
                        }
                      >
                        <div className="card-thumb">
                          {album.thumbnails?.[0] && (
                            <img
                              src={thumb(album.thumbnails, 200)}
                              alt=""
                              loading="lazy"
                              onError={thumbOnError()}
                            />
                          )}
                          <div className="card-play-btn">
                            <PlayIcon />
                          </div>
                        </div>
                        <div className="card-title">{album.title}</div>
                        <div className="card-sub">
                          {album.year ?? album.type ?? "Album"}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Singles */}
              {(openArtist.singles?.results?.length ?? 0) > 0 && (
                <section className="artist-section">
                  <h2 className="artist-section-title">Singles</h2>
                  <div className="artist-cards-scroll">
                    {openArtist.singles!.results.map((single, i) => (
                      <div
                        key={single.browseId ?? i}
                        className={`card ${single.browseId ? "card-clickable" : ""}`}
                        onClick={() =>
                          single.browseId && loadAlbum(single.browseId)
                        }
                      >
                        <div className="card-thumb">
                          {single.thumbnails?.[0] && (
                            <img
                              src={thumb(single.thumbnails, 200)}
                              alt=""
                              loading="lazy"
                              onError={thumbOnError()}
                            />
                          )}
                          <div className="card-play-btn">
                            <PlayIcon />
                          </div>
                        </div>
                        <div className="card-title">{single.title}</div>
                        <div className="card-sub">
                          {single.year ?? "Single"}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Similar Artists */}
              {(openArtist.related?.results?.length ?? 0) > 0 && (
                <section className="artist-section">
                  <h2 className="artist-section-title">Similar Artists</h2>
                  <div className="artist-cards-scroll">
                    {openArtist.related!.results.map((artist, i) => (
                      <div
                        key={artist.browseId ?? i}
                        className="card artist-card-round"
                        onClick={() =>
                          artist.browseId && loadArtist(artist.browseId)
                        }
                      >
                        <div className="card-thumb">
                          {artist.thumbnails?.[0] && (
                            <img
                              src={thumb(artist.thumbnails, 200)}
                              alt=""
                              loading="lazy"
                              onError={thumbOnError()}
                            />
                          )}
                          <div className="card-play-btn">
                            <PlayIcon />
                          </div>
                        </div>
                        <div className="card-title">{artist.title}</div>
                        <div className="card-sub">
                          {artist.subscribers ?? "Artist"}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        )}

        {/* ── Album / single page ──────────────────────────────────────────── */}
        {view === "album" && !loading && openAlbum && (
          <div className="page album-page">
            <div className="album-header">
              <button className="artist-back-btn" onClick={goBack}>
                ← Back
              </button>
              <div className="album-header-content">
                <div className="album-cover">
                  {openAlbum.thumbnails?.[0] ? (
                    <img
                      src={thumb(openAlbum.thumbnails, 240)}
                      alt=""
                      onError={thumbOnError()}
                    />
                  ) : (
                    <span className="album-cover-ph">♫</span>
                  )}
                </div>
                <div className="album-header-info">
                  <div className="album-type">{openAlbum.type ?? "Album"}</div>
                  <h1 className="album-title">{openAlbum.title}</h1>
                  <div className="album-meta">
                    {(openAlbum.artists ?? []).map((a, i) => (
                      <span key={i}>
                        {i > 0 && <span className="album-meta-sep">, </span>}
                        {a.id ? (
                          <span
                            className="artist-link"
                            onClick={() => loadArtist(a.id!)}
                          >
                            {a.name}
                          </span>
                        ) : (
                          <span>{a.name}</span>
                        )}
                      </span>
                    ))}
                    {openAlbum.year && (
                      <span className="album-meta-dot">{openAlbum.year}</span>
                    )}
                    {openAlbum.trackCount != null && (
                      <span className="album-meta-dot">
                        {openAlbum.trackCount} songs
                      </span>
                    )}
                    {openAlbum.duration && (
                      <span className="album-meta-dot">
                        {openAlbum.duration}
                      </span>
                    )}
                  </div>
                  {(() => {
                    const tracks = openAlbum.tracks.filter((t) => t.videoId);
                    const isCurrent =
                      !!player.track?.videoId &&
                      tracks.some((t) => t.videoId === player.track!.videoId);
                    const showPause = isCurrent && player.playing;
                    return (
                      <div className="album-actions">
                        <button
                          className="album-play-all"
                          disabled={tracks.length === 0}
                          onClick={() => {
                            if (!tracks.length) return;
                            isCurrent ? togglePlay() : playTrack(tracks[0]);
                          }}
                        >
                          {showPause ? <PauseIcon /> : <PlayIcon />}
                          <span>{showPause ? "Pause" : "Play"}</span>
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
            <div className="artist-body">
              {openAlbum.tracks.length === 0 ? (
                <div className="empty-state">
                  <p>No tracks available for this release.</p>
                </div>
              ) : (
                <TrackTable
                  tracks={openAlbum.tracks}
                  currentId={player.track?.videoId}
                  playing={player.playing}
                  onPlay={playTrack}
                  onDownload={handleDownload}
                  dlStatus={dlStatus}
                  onArtistClick={loadArtist}
                  onToggle={togglePlay}
                  onHover={handleHoverPrefetch}
                />
              )}
            </div>
          </div>
        )}

        {/* ── Artists ──────────────────────────────────────────────────────── */}
        {view === "artists" && !loading && (
          <div className="page">
            <h2 className="page-title">Artists</h2>
            <form
              className="filter-search-form"
              onSubmit={(e) => {
                e.preventDefault();
                doArtistSearch(artistQuery);
              }}
            >
              <span className="search-icon" style={{ color: "var(--text3)" }}>
                <SearchIcon size={15} color="var(--text3)" />
              </span>
              <input
                className="filter-search-input"
                type="text"
                placeholder="Search artists…"
                value={artistQuery}
                onChange={(e) => setArtistQuery(e.target.value)}
              />
            </form>
            {artistResults.length === 0 ? (
              <div className="empty-state">
                <p>{ytmConnected ? "No library artists yet." : "Search for an artist above."}</p>
              </div>
            ) : (
              <div className="shelf-grid">
                {artistResults.map((item, i) => (
                  <div
                    key={item.browseId ?? i}
                    className="card"
                    onClick={() => item.browseId && loadArtist(item.browseId)}
                  >
                    <div className="card-thumb">
                      {item.thumbnails?.[0] && (
                        <img
                          src={thumb(item.thumbnails, 200)}
                          alt={item.title}
                        />
                      )}
                      <div className="card-play-btn">
                        <PlayIcon />
                      </div>
                    </div>
                    <div className="card-title">{item.title}</div>
                    <div className="card-sub">Artist</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Albums ───────────────────────────────────────────────────────── */}
        {view === "albums" && !loading && (
          <div className="page">
            <h2 className="page-title">Albums</h2>
            <form
              className="filter-search-form"
              onSubmit={(e) => {
                e.preventDefault();
                doAlbumSearch(albumQuery);
              }}
            >
              <span className="search-icon" style={{ color: "var(--text3)" }}>
                <SearchIcon size={15} color="var(--text3)" />
              </span>
              <input
                className="filter-search-input"
                type="text"
                placeholder="Search albums…"
                value={albumQuery}
                onChange={(e) => setAlbumQuery(e.target.value)}
              />
            </form>
            {albumResults.length === 0 ? (
              <div className="empty-state">
                <p>{ytmConnected ? "No saved albums yet." : "Search for an album above."}</p>
              </div>
            ) : (
              <div className="shelf-grid">
                {albumResults.map((item, i) => (
                  <div
                    key={item.browseId ?? item.playlistId ?? i}
                    className={`card ${item.browseId ? "card-clickable" : ""}`}
                    onClick={() => item.browseId && loadAlbum(item.browseId)}
                  >
                    <div className="card-thumb">
                      {item.thumbnails?.[0] && (
                        <img
                          src={thumb(item.thumbnails, 200)}
                          alt={item.title}
                        />
                      )}
                      <div className="card-play-btn">
                        <PlayIcon />
                      </div>
                    </div>
                    <div className="card-title">{item.title}</div>
                    <div className="card-sub">
                      {item.artists?.map((a) => a.name).join(", ")}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Podcasts (coming soon) ────────────────────────────────────────── */}
        {view === "podcasts" && (
          <div className="page">
            <div className="coming-soon">
              <div className="coming-soon-icon">🎙</div>
              <h2>Podcasts</h2>
              <p>Podcast support is coming soon. Stay tuned!</p>
            </div>
          </div>
        )}

        {/* ── Explore ──────────────────────────────────────────────────────── */}
        {view === "explore" && (
          <div className="page">
            <h2 className="page-title">Explore</h2>

            {/* GENRES — always visible, instant. Clicks run a search. */}
            <section className="explore-section">
              <h3 className="explore-section-title">Browse by genre</h3>
              <div className="mood-grid">
                {GENRE_TILES.map((g, i) => (
                  <div
                    key={i}
                    className="mood-tile"
                    style={{
                      background: MOOD_COLORS[i % MOOD_COLORS.length],
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      setSearchQuery(g.title);
                      doSearch(g.query);
                    }}
                  >
                    <span className="mood-tile-title">{g.title}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* MOODS — always visible, instant. */}
            <section className="explore-section">
              <h3 className="explore-section-title">Moods &amp; activities</h3>
              <div className="mood-grid">
                {MOOD_TILES.map((m, i) => (
                  <div
                    key={i}
                    className="mood-tile"
                    style={{
                      background: MOOD_COLORS[(i + 8) % MOOD_COLORS.length],
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      setSearchQuery(m.title);
                      doSearch(m.query);
                    }}
                  >
                    <span className="mood-tile-title">{m.title}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* CHARTS — only shown if available */}
            {exploreLoading && (
              <div className="page-spinner" style={{ margin: "40px auto" }} />
            )}

            {!exploreLoading && chartTracks.length > 0 && (
              <section className="explore-section">
                <h3 className="explore-section-title">Trending</h3>
                <div className="chart-list">
                  {chartTracks.slice(0, 50).map((t, i) => {
                    const isActive = t.videoId === player.track?.videoId;
                    return (
                      <div
                        key={t.videoId ?? i}
                        className={`chart-item ${isActive ? "active-track" : ""}`}
                        onClick={() =>
                          t.videoId && playTrack(t as unknown as Track)
                        }
                      >
                        <span className="chart-rank">{t.rank ?? i + 1}</span>
                        <div className="chart-art">
                          {t.thumbnails?.[0] && (
                            <img
                              src={thumb(t.thumbnails as api.Thumbnail[], 46)}
                              alt={t.title}
                            />
                          )}
                        </div>
                        <div className="chart-info">
                          <div className="chart-title">{t.title}</div>
                          <div className="chart-artist">
                            {t.artists?.map((a) => a.name).join(", ")}
                          </div>
                        </div>
                        <span className="chart-meta">
                          {t.views ?? t.duration ?? ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* NEW MUSIC — reuses home shelf data. Home shelves mostly contain
                albums/playlists (no videoId), so we keep anything clickable. */}
            {homeShelves.length > 0 &&
              (() => {
                const items = homeShelves
                  .flatMap((s) => s.contents ?? [])
                  .filter((c) => c.videoId || c.playlistId || c.browseId)
                  .slice(0, 12);
                if (items.length === 0) return null;
                return (
                  <section className="explore-section">
                    <h3 className="explore-section-title">
                      New &amp; recommended
                    </h3>
                    <div className="shelf-grid">
                      {items.map((item, j) => (
                        <TrackCard
                          key={
                            item.videoId ??
                            item.playlistId ??
                            item.browseId ??
                            j
                          }
                          item={item}
                          onPlay={playTrack}
                          currentId={player.track?.videoId}
                          playing={player.playing}
                          onArtistClick={loadArtist}
                          onPlaylistOpen={loadPlaylist}
                        />
                      ))}
                    </div>
                  </section>
                );
              })()}
          </div>
        )}
      </main>

      {/* ══════════════════════════════════════════════════════════════════
          ICON STRIP — shown on non-home views when panel is closed
          ══════════════════════════════════════════════════════════════════ */}
      {showStrip && !panelOpen && (
        <div className="icon-strip">
          <button
            className={`strip-btn ${rightPanel === "queue" ? "active" : ""}`}
            title="Queue & Lyrics"
            onClick={() => togglePanel("queue")}
          >
            <QueueIcon />
          </button>
          <button
            className={`strip-btn ${rightPanel === "library" ? "active" : ""}`}
            title="Library"
            onClick={() => togglePanel("library")}
          >
            <LibraryIcon />
          </button>
          <button
            className={`strip-btn ${rightPanel === "related" ? "active" : ""}`}
            title="Related"
            onClick={() => togglePanel("related")}
          >
            <RelatedIcon />
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          RIGHT PANEL — 300px, toggleable
          ══════════════════════════════════════════════════════════════════ */}
      {panelOpen && (
        <div className="right-panel">
          {/* Header */}
          <div className="right-panel-header">
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className={`strip-btn ${rightPanel === "queue" ? "active" : ""}`}
                onClick={() => togglePanel("queue")}
                title="Queue"
              >
                <QueueIcon />
              </button>
              <button
                className={`strip-btn ${rightPanel === "library" ? "active" : ""}`}
                onClick={() => togglePanel("library")}
                title="Library"
              >
                <LibraryIcon />
              </button>
              <button
                className={`strip-btn ${rightPanel === "related" ? "active" : ""}`}
                onClick={() => togglePanel("related")}
                title="Related"
              >
                <RelatedIcon />
              </button>
            </div>
            <button
              className="right-panel-close"
              onClick={() => setRightPanel(null)}
            >
              ✕
            </button>
          </div>

          {/* Queue panel */}
          {rightPanel === "queue" && (
            <>
              <div className="panel-tabs">
                <button
                  className={`panel-tab ${queueSubTab === "upnext" ? "active" : ""}`}
                  onClick={() => setQueueSubTab("upnext")}
                >
                  Up Next
                </button>
                <button
                  className={`panel-tab ${queueSubTab === "lyrics" ? "active" : ""}`}
                  onClick={() => setQueueSubTab("lyrics")}
                >
                  Lyrics
                </button>
              </div>
              <div className="panel-content">
                {queueSubTab === "upnext" &&
                  (queue.length === 0 ? (
                    <div className="lyrics-none">No tracks in queue.</div>
                  ) : (
                    queue.map((t, i) => (
                      <div
                        key={t.videoId ?? i}
                        className={`queue-item ${i === queueIdx ? "active" : ""}`}
                        onClick={() => playFromQueue(i)}
                      >
                        <div className="queue-item-art">
                          {(t.thumbnails?.[0] || t.videoId) && (
                            <img
                              src={
                                t.thumbnails?.[0]
                                  ? thumb(t.thumbnails, 40)
                                  : ytFallback(t.videoId)
                              }
                              alt={t.title}
                              onError={thumbOnError(t.videoId)}
                            />
                          )}
                          {i === queueIdx && (
                            <div
                              className="queue-item-overlay"
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePlay();
                              }}
                            >
                              {player.playing ? <EqBars /> : <PlayIcon />}
                            </div>
                          )}
                        </div>
                        <div className="queue-item-info">
                          <div className="queue-item-title">{t.title}</div>
                          <div className="queue-item-artist">
                            {t.artists?.map((a, ai) => (
                              <span key={ai}>
                                {ai > 0 && ", "}
                                {a.id ? (
                                  <span
                                    className="artist-link"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      loadArtist(a.id!);
                                    }}
                                  >
                                    {a.name}
                                  </span>
                                ) : (
                                  a.name
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                        <span className="queue-item-dur">
                          {t.duration ?? ""}
                        </span>
                      </div>
                    ))
                  ))}
                {queueSubTab === "lyrics" &&
                  (lyricsLoading ? (
                    <div className="lyrics-loading">Loading lyrics…</div>
                  ) : lyrics?.synced ? (
                    <LyricsSynced
                      lines={syncedLines}
                      audioRef={audioRef}
                      onSeek={(t) => {
                        if (audioRef.current) {
                          audioRef.current.currentTime = t;
                          setPlayer((p) => ({ ...p, currentTime: t }));
                        }
                      }}
                    />
                  ) : lyrics?.plain ? (
                    <div className="lyrics-plain">{lyrics.plain}</div>
                  ) : (
                    <div className="lyrics-none">
                      {player.track
                        ? "No lyrics found."
                        : "Play a track to see lyrics."}
                    </div>
                  ))}
              </div>
            </>
          )}

          {/* Library panel */}
          {rightPanel === "library" && (
            <>
              <div className="panel-tabs">
                <span className="right-panel-title">Your Playlists</span>
              </div>
              <div className="panel-content">
                {visiblePlaylists.length === 0 ? (
                  <div className="lyrics-none">
                    {!authenticated ? (
                      "Sign in to see your playlists."
                    ) : libraryPlaylists.length === 0 ? (
                      <button
                        className="btn-primary small"
                        onClick={loadLibrary}
                      >
                        Load playlists
                      </button>
                    ) : (
                      "No synced playlists — click Edit to pick some."
                    )}
                  </div>
                ) : (
                  visiblePlaylists.map((pl) => (
                    <div
                      key={pl.playlistId}
                      className="queue-item"
                      onClick={() => loadYtPlaylist(pl.playlistId, pl.title)}
                    >
                      <div className="queue-item-art">
                        {pl.thumbnails?.[0] ? (
                          <img src={thumb(pl.thumbnails, 40)} alt={pl.title} />
                        ) : (
                          <div
                            style={{
                              width: "100%",
                              height: "100%",
                              background: "var(--bg3)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            ♫
                          </div>
                        )}
                      </div>
                      <div className="queue-item-info">
                        <div className="queue-item-title">{pl.title}</div>
                        <div className="queue-item-artist">
                          {pl.count ?? ""} songs
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {/* Related panel */}
          {rightPanel === "related" && (
            <>
              <div className="panel-tabs">
                <span className="right-panel-title">Related</span>
              </div>
              <div className="panel-content">
                {relatedTracks.length === 0 ? (
                  <div className="lyrics-none">
                    {player.track
                      ? "Loading…"
                      : "Play a track to see related songs."}
                  </div>
                ) : (
                  relatedTracks.map((t, i) => {
                    const isActive = t.videoId === player.track?.videoId;
                    // watch playlist tracks may use 'thumbnail' (list) instead of 'thumbnails'
                    const thumbs = t.thumbnails ?? (t as any).thumbnail;
                    return (
                      <div
                        key={t.videoId ?? i}
                        className={`queue-item ${isActive ? "active" : ""}`}
                        onClick={() => t.videoId && playTrack(t)}
                      >
                        <div className="queue-item-art">
                          {(thumbs?.[0] || t.videoId) && (
                            <img
                              src={
                                thumbs?.[0]
                                  ? thumb(thumbs, 40)
                                  : ytFallback(t.videoId)
                              }
                              alt={t.title}
                              onError={thumbOnError(t.videoId)}
                            />
                          )}
                          {isActive && (
                            <div
                              className="queue-item-overlay"
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePlay();
                              }}
                            >
                              {player.playing ? <EqBars /> : <PlayIcon />}
                            </div>
                          )}
                        </div>
                        <div className="queue-item-info">
                          <div className="queue-item-title">{t.title}</div>
                          <div className="queue-item-artist">
                            {(
                              t as Track & { artists?: { name: string }[] }
                            ).artists
                              ?.map((a: { name: string }) => a.name)
                              .join(", ")}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TrackCard({
  item,
  onPlay,
  currentId,
  playing,
  onArtistClick,
  onPlaylistOpen,
  onHover,
}: {
  item: SearchResult;
  onPlay: (t: Track) => void;
  currentId?: string;
  playing: boolean;
  onArtistClick?: (browseId: string) => void;
  onPlaylistOpen?: (id: string) => void;
  onHover?: (videoId: string, title?: string, artist?: string) => void;
}) {
  const isActive = !!item.videoId && item.videoId === currentId;
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = () => {
    if (item.videoId) {
      onPlay(item as unknown as Track);
    } else if (item.playlistId && onPlaylistOpen) {
      onPlaylistOpen(item.playlistId);
    } else if (item.browseId && onArtistClick) {
      onArtistClick(item.browseId);
    }
  };

  return (
    <div
      className={`card ${isActive ? "active" : ""}`}
      onClick={handleClick}
      onMouseEnter={() => {
        if (!item.videoId || !onHover) return;
        hoverTimer.current = setTimeout(
          () => onHover(item.videoId!, item.title, item.artists?.[0]?.name),
          400,
        );
      }}
      onMouseLeave={() => {
        if (hoverTimer.current) {
          clearTimeout(hoverTimer.current);
          hoverTimer.current = null;
        }
      }}
    >
      <div className="card-thumb">
        {(item.thumbnails?.[0] || item.videoId) && (
          <img
            src={
              item.thumbnails?.[0]
                ? thumb(item.thumbnails, 200)
                : ytFallback(item.videoId)
            }
            alt={item.title}
            onError={thumbOnError(item.videoId)}
          />
        )}
        <div className="card-play-btn">
          {isActive && playing ? <PauseIcon /> : <PlayIcon />}
        </div>
      </div>
      <div className="card-title">{item.title}</div>
      <div className="card-sub">
        {item.artists?.map((a, ai) => (
          <span key={ai}>
            {ai > 0 && ", "}
            {onArtistClick && a.id ? (
              <span
                className="artist-link"
                onClick={(e) => {
                  e.stopPropagation();
                  onArtistClick(a.id!);
                }}
              >
                {a.name}
              </span>
            ) : (
              a.name
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function LyricsSynced({
  lines,
  audioRef,
  onSeek,
}: {
  lines: { time: number; text: string }[];
  audioRef: React.RefObject<HTMLAudioElement | null>;
  onSeek: (t: number) => void;
}) {
  // We poll audio.currentTime via rAF (~60 Hz) instead of the React state's
  // currentTime — that state only updates from `onTimeUpdate` which fires
  // every ~250 ms and causes visibly laggy highlighting on synced lyrics.
  // Polling the audio element directly + only re-rendering on activeIdx
  // changes gives precise sync without flooding React with state updates.
  const [activeIdx, setActiveIdx] = useState(-1);
  const activeRef = useRef<HTMLDivElement>(null);
  const activeIdxRef = useRef(-1);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        const t = audio.currentTime;
        const ls = linesRef.current;
        // Linear scan — fast enough for the typical 50-150 lines.
        let idx = -1;
        for (let i = 0; i < ls.length; i++) {
          if (ls[i].time <= t) idx = i;
          else break;
        }
        if (idx !== activeIdxRef.current) {
          activeIdxRef.current = idx;
          setActiveIdx(idx);
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [audioRef]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIdx]);

  return (
    <div className="lyrics-synced">
      {lines.map((l, i) => {
        const isActive = i === activeIdx;
        return (
          <div
            key={i}
            ref={isActive ? activeRef : undefined}
            className={`lyrics-line${isActive ? " active" : ""}`}
            onClick={() => onSeek(l.time)}
          >
            {l.text}
          </div>
        );
      })}
    </div>
  );
}

function TrackTable({
  tracks,
  currentId,
  playing,
  onPlay,
  onDownload,
  dlStatus,
  showAlbum,
  onArtistClick,
  onToggle,
  onHover,
  onRemove,
}: {
  tracks: Track[];
  currentId?: string;
  playing: boolean;
  onPlay: (t: Track) => void;
  onDownload: (t: Track) => void;
  dlStatus: Record<string, DlState>;
  showAlbum?: boolean;
  onArtistClick?: (browseId: string) => void;
  onToggle?: () => void;
  onHover?: (videoId: string, title?: string, artist?: string) => void;
  onRemove?: (t: Track) => void;
}) {
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <div className="track-table">
      <div className="track-table-header">
        <span className="col-num">#</span>
        <span>Title</span>
        {showAlbum ? <span>Album</span> : <span />}
        <span className="col-duration">⏱</span>
        <span />
      </div>
      <div className="track-list">
        {tracks.map((t, i) => {
          const isActive = t.videoId === currentId;
          const dl = dlStatus[t.videoId] as DlState | undefined;
          const dlIcon =
            dl === "loading"
              ? "⟳"
              : dl === "done"
                ? "✓"
                : dl === "error"
                  ? "✗"
                  : "↓";
          return (
            <div
              key={t.videoId ?? i}
              className={`track-row ${isActive ? "active" : ""}`}
              onClick={() => t.videoId && onPlay(t)}
              onMouseEnter={() => {
                if (!t.videoId || !onHover) return;
                hoverTimer.current = setTimeout(
                  () => onHover!(t.videoId!, t.title, t.artists?.[0]?.name),
                  400,
                );
              }}
              onMouseLeave={() => {
                if (hoverTimer.current) {
                  clearTimeout(hoverTimer.current);
                  hoverTimer.current = null;
                }
              }}
            >
              <div className="track-num">
                {isActive && playing ? (
                  <EqBars />
                ) : (
                  <>
                    <span className="track-num-index">{i + 1}</span>
                    <span className="track-num-play">
                      <PlayIcon />
                    </span>
                  </>
                )}
              </div>
              <div className="track-cell-title">
                <div className="track-thumb">
                  {(t.thumbnails?.[0] || t.videoId) && (
                    <img
                      src={
                        t.thumbnails?.[0]
                          ? thumb(t.thumbnails, 40)
                          : ytFallback(t.videoId)
                      }
                      alt={t.title}
                      onError={thumbOnError(t.videoId)}
                    />
                  )}
                  {isActive && (
                    <div
                      className="track-thumb-overlay"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle?.();
                      }}
                    >
                      {playing ? <EqBars /> : <PlayIcon />}
                    </div>
                  )}
                </div>
                <div className="track-cell-info">
                  <div className="track-cell-name">{t.title}</div>
                  <div className="track-cell-artist">
                    {t.artists?.map((a, ai) => (
                      <span key={ai}>
                        {ai > 0 && ", "}
                        {onArtistClick && a.id ? (
                          <span
                            className="artist-link"
                            onClick={(e) => {
                              e.stopPropagation();
                              onArtistClick(a.id!);
                            }}
                          >
                            {a.name}
                          </span>
                        ) : (
                          a.name
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <span className="track-cell-album">
                {showAlbum ? (t.album?.name ?? "") : ""}
              </span>
              <span className="track-cell-duration">{t.duration ?? ""}</span>
              <div className="track-actions">
                {onRemove && (
                  <button
                    className="row-remove-btn"
                    title="Remove from this playlist"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(t);
                    }}
                  >
                    ✕
                  </button>
                )}
                <button
                  className={`dl-btn ${dl ?? ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload(t);
                  }}
                  disabled={dl === "loading"}
                  title={`Download to ${DOWNLOAD_DIR}`}
                >
                  {dlIcon}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
