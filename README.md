# YouTube Music Desktop

A personal, NewPipe-style desktop client for YouTube Music — plays full tracks
(audio + video fallback), search, artist/album browsing, playlists, lyrics, and
a draggable always-on-top mini-player. No official API key required for
playback; an optional Google sign-in unlocks library sync (playlists, Liked
Songs) and, with a connected YouTube Music session, full personalization
(home feed, library Artists/Albums, real Liked Songs/history).

This is a personal project, not affiliated with or endorsed by Google/YouTube.

## Stack

- **Frontend:** React + TypeScript (Vite)
- **Shell:** Tauri 2 (Rust) — window management, OS keychain, Google OAuth (PKCE)
- **Sidecar:** Python (FastAPI) — talks to YouTube Music's InnerTube API via
  [`ytmusicapi`](https://github.com/sigma67/ytmusicapi) and to YouTube via
  [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) for stream resolution
- **Backend (optional):** Supabase (Postgres + Edge Functions) — only used for
  the opt-in first-login compliance record and data-subject rights; the app
  is fully usable without it configured

## Repo layout

```
src/             React UI (App.tsx, api.ts — sidecar HTTP client)
src-tauri/       Rust shell: window/lifecycle, sidecar process management,
                 Google OAuth (PKCE), OS keychain, YT Music cookie capture
sidecar/         Python FastAPI: search/home/playlists/lyrics, auth, local
                 play history, Supabase data-rights calls
backend/supabase/ SQL migrations + Edge Functions for the optional first-login
                 record (see backend/supabase/README.md to deploy)
docs/            Privacy policy, smoke-test checklist, design/decision notes
```

## Setup

Prerequisites: Node.js, Rust (via [rustup](https://rustup.rs/)), Python 3.x —
all on `PATH`.

```bash
npm install
pip install -r sidecar/requirements.txt
```

Copy the env templates and fill in your own values:

```bash
cp sidecar/.env.example sidecar/.env          # Supabase URL + anon key (optional feature)
cp src-tauri/.env.example src-tauri/.env      # Google OAuth client (Desktop app type)
```

- Without `sidecar/.env`, everything works except the first-login record/data
  rights UI (Supabase calls no-op).
- Without `src-tauri/.env`, Google sign-in (library sync, YT Music cookie
  connect) is unavailable; guest playback/search still works.
- Optional: drop a DB-IP ["IP to City Lite"](https://db-ip.com/db/download/ip-to-city-lite)
  `.mmdb` file into `sidecar/data/` for offline city-level location on the
  first-login record. Without it, that field is just left blank.

## Run

```bash
npm run tauri dev
```

Rust spawns the Python sidecar automatically (`127.0.0.1`, random per-launch
auth token — see `src-tauri/src/lib.rs`); you don't start it separately.

## Build

```bash
npm run tauri build
```

Produces a platform installer under `src-tauri/target/release/bundle/`.

## Docs

- [`docs/PRIVACY.md`](docs/PRIVACY.md) — privacy policy (rendered in-app too)
- [`docs/SMOKE-TEST.md`](docs/SMOKE-TEST.md) — manual regression checklist
- [`docs/TODO.md`](docs/TODO.md) — feature status
- [`docs/plans/`](docs/plans/) — architecture/design notes
