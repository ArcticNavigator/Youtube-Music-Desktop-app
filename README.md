# YouTube Music Desktop

A clean, fast, **personal** desktop player for YouTube Music. It lets you search,
browse artists and albums, open playlists, read lyrics, keep a local listening
history, and pop out a small always-on-top mini-player while you work. Sign in with
Google and it becomes _yours_ your playlists, your Liked Songs, and (with a
connected YouTube Music session) your real personalized home feed.

This is a hobby project built for personal use. **It is not affiliated with,
sponsored by, or endorsed by Google, YouTube, or YouTube Music.** All trademarks,
music, artwork, and content belong to their respective owners.

> ⚠️ **Please read the [License](LICENSE) and [Terms](TERMS.md) before using or
> sharing this.** In short: it's free to use and you're welcome to contribute, but
> you may **not** sell it, rebrand it, or use it for piracy or any commercial
> purpose.

---

## What it can do

- **Play anything on YouTube Music** - songs, albums, singles, playlists, radio
  ("Up Next") mixes. No official API key needed for playback.
- **Search** - with live suggestions as you type.
- **Browse** - artist pages (top songs, albums, singles, related artists) and full
  album/single pages.
- **Your library** (after sign-in) - your playlists, Liked Songs, and a real
  personalized home feed.
- **Download songs** - to your computer as tagged `.m4a` files with album art.
- **Add / remove tracks** - from your own YouTube playlists, right from the app.
- **Lyrics** - synced (line-by-line) where available, plain text otherwise.
- **Mini-player** - a small, draggable, always-on-top window for quick control.
- **Guest mode** - everything except your personal library works without signing
  in at all.

## How it works (the short version)

The app has three parts that run together on your machine:

1. **The window** you see is a lightweight desktop shell (built with Tauri + Rust).
   It manages the window, handles Google sign-in securely, and stores your secrets
   in your operating system's keychain.
2. **A small local helper** (a Python program) runs quietly in the background on
   `127.0.0.1` (your own computer only, never exposed to the internet). It talks
   to YouTube Music to fetch search results, home feeds, playlists, lyrics, and the
   direct audio stream for whatever you're playing.
3. **The interface** itself (built with React) is what you click around in.

When you press play, the helper resolves a direct audio link and the app streams it
straight to your speakers. Nothing is proxied through any server it run, it's just
your computer talking to YouTube, the same way the website does.

---

## Installing it

### Option A - Install the built app (easiest)

1. Grab the installer for your platform from the project's Releases page (or build
   it yourself, see Option B).
   - **Windows:** `.msi` or `.exe`
   - **macOS:** `.dmg`
   - **Linux:** `.AppImage` or `.deb`
2. Run the installer and launch **YouTube Music** like any other app.
3. That's it, search and playback work immediately in guest mode.

> The app bundles its own helper, so you don't need to install Python or anything
> else to _use_ a released build.

### Option B - Build it from source for contribution

You'll need **Node.js**, **Rust** (via [rustup](https://rustup.rs/)), and
**Python 3** installed and on your `PATH`.

```bash
# 1. Install dependencies
npm install
pip install -r sidecar/requirements.txt

# 2. (Optional) Set up sign-in and the optional account record — see "Configuration"
cp src-tauri/.env.example src-tauri/.env      # Google OAuth client (for sign-in)
cp sidecar/.env.example   sidecar/.env        # Supabase keys (optional feature)

# 3. Run it in development
npm run tauri dev

# 4. …or produce an installer for your platform
npm run tauri build
```

The finished installer lands in `src-tauri/target/release/bundle/`.

---

## Signing in

Signing in is **completely optional** - guest mode plays everything. Sign in only
if you want _your_ library and personalization. There are two levels:

### 1. Google sign-in (your playlists + Liked Songs)

- Click **Sign in** in the app. Your normal web browser opens to Google's official
  consent screen.
- Approve, and the browser hands a one-time code back to the app. The app exchanges
  it for a token and stores it **only in your OS keychain** - never on any server we
  run, never in plain text.
- This uses the secure PKCE flow designed for desktop apps, so there's no password
  for the app to ever see.

This unlocks your own YouTube playlists and Liked Songs.

### 2. Connect YouTube Music (full personalization)

YouTube's private music service needs a logged-in _session_ (not just a token) to
hand over the truly personalized stuf - your "for you" home feed, your library
Artists and Albums, and your real Liked Music and history.

- Open **Settings → Connect YouTube Music**.
- A small in-app window opens to `music.youtube.com`. Sign in there as you normally
  would.
- Click **"I've signed in"**, and the app reads your session and keeps it connected.
  This stays connected across restarts, you only do it once.

> **The ≤100-user limit:** The optional account record (see Privacy) is capped at
> **100 sign-ups** total, because this is a small personal project. Once 100 people
> have signed in, **new** sign-ins are turned off and the app simply runs in guest
> mode for newcomers - search and playback keep working fully; only the personalized
> account features are unavailable. Anyone already signed in is unaffected.

---

## Downloading songs

1. Find any track (in search, an album, a playlist, your histor - anywhere a song
   appears).
2. Use the **download** action on the track.
3. Choose where to save it. The app saves a high-quality `.m4a` audio file named
   `Artist - Title.m4a`, with the album art and track metadata embedded so it
   looks right in any music player or file browser.

> Downloads are for your **own personal, offline listening** only. Respect the
> rights of artists and copyright holders, and the laws where you live. Don't
> redistribute, share, or sell what you download.

## Adding & removing songs from playlists

Once you're signed in with Google, you can manage your own YouTube playlists without
leaving the app:

- **Add a song:** use the add-to-playlist action on any track and pick one of your
  playlists. The change is written straight to your YouTube account, so it shows up
  on the YouTube Music website and apps too.
- **Remove a song:** open one of your own playlists and use the remove action on a
  track. It's removed from your real playlist.

Changes sync both ways because they go through your actual YouTube account. This app
is just a friendlier remote control for it.

---

## Configuration (only needed when building from source)

| File                  | What it's for                                                                            | Needed?                                  |
| --------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| `src-tauri/.env`      | Your Google OAuth client ID/secret (Desktop app type, from Google Cloud Console)         | Only for sign-in features                |
| `sidecar/.env`        | Your Supabase project URL + anon key                                                     | Only for the optional account record     |
| `sidecar/data/*.mmdb` | A DB-IP "IP to City Lite" database for offline city-level location on the account record | Optional; field is left blank without it |

- **Without `src-tauri/.env`:** guest playback and search work; sign-in is disabled.
- **Without `sidecar/.env`:** everything works except the optional first-login
  record and data-rights screen (those calls simply do nothing).

Copy the matching `.env.example` file and fill in your own values. **Never commit
your real `.env` files** - they're already in `.gitignore`.

---

## Contributing

Contributions are genuinely welcome - bug reports, fixes, and thoughtful features.

- Open an issue describing the bug or idea first, so we can agree on the approach.
- Keep pull requests focused and small; match the existing code style and the
  commenting style you see in each file.
- Run the app (`npm run tauri dev`) and make sure your change works before opening a
  PR.

**One firm rule:** by contributing, you agree your contribution is shared under this
project's [License](LICENSE). You may study the code, run it, modify it, and submit
improvements, but you may **not** repackage, rebrand, sell, or redistribute this app
(or a clone of it) for commercial gain, and you may **not** use it to enable piracy.
This project exists for learning and personal use, and we want to keep it that way.

---

## Credits & acknowledgements

This app would not exist without these services and projects. Huge thanks to:

- **YouTube & YouTube Music** (Google LLC) - the source of all music, metadata,
  artwork, and streams. This app is an unofficial client; all content and trademarks
  are theirs.
- **Google Cloud / Google OAuth & the YouTube Data API** - secure sign-in and
  official playlist management.
- **Supabase** - authentication-adjacent storage and Edge Functions for the optional
  account record.
- **DB-IP** - the _IP to City Lite_ database used for optional, on-device,
  approximate location ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
- The open-source libraries that power playback, the UI, and the desktop shell - see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the full list and their
  licenses.

## Legal

- **[License](LICENSE)** - PolyForm Noncommercial 1.0.0 (free for personal &
  noncommercial use; no selling, no piracy).
- **[Terms & Conditions](TERMS.md)** - acceptable use and disclaimers.
- **[Privacy Policy](docs/PRIVACY.md)** - exactly what the optional account record
  stores, and your rights (also viewable inside the app).
- **[Third-party notices](THIRD_PARTY_NOTICES.md)** - open-source dependencies and
  their licenses.
