# Third-Party Notices

Tunecat Music is built on open-source software and one openly-licensed data
set. This file lists those components and their licenses, and gives credit where it's
required.

The project's **own** source code is licensed under [PolyForm Noncommercial
1.0.0](LICENSE). The components below are licensed **separately** by their authors
under their own terms, nothing here changes those terms.

---

## Which attributions are legally required?

If you **distribute a build** of this app (an installer, binary, or bundle), the
following obligations apply:

| Component                                           | License                           | What it requires you to do                                                                                                                                |
| --------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DB-IP "IP to City Lite"** (optional GeoIP data)   | **CC BY 4.0**                     | **Required:** credit "DB-IP" and link the CC BY 4.0 license wherever the data is used or shipped. Already done in the app, the Privacy Policy, and below. |
| Apache-2.0 components (e.g. `geoip2`, `typescript`) | **Apache-2.0**                    | Include the Apache-2.0 license text and preserve any `NOTICE` file when redistributing.                                                                   |
| MIT components (most of the stack)                  | **MIT**                           | Include the MIT copyright notice and permission text in your distribution.                                                                                |
| BSD components (e.g. `uvicorn`, `python-dotenv`)    | **BSD-3-Clause**                  | Include the copyright notice and disclaimer in your distribution.                                                                                         |
| **FFmpeg** (bundled binary, for downloads)          | **LGPL-2.1-or-later**             | Include the LGPL text, credit FFmpeg, and make its source available. We invoke it as a separate executable (no linking), so only FFmpeg's own code is affected. |
| `yt-dlp`                                            | **The Unlicense** (public domain) | No obligation.                                                                                                                                            |

> **At release time**, generate the full verbatim license texts and bundle them with
> the installer. You can collect them automatically:
>
> - JavaScript: `npx license-checker --production --summary`
> - Rust: `cargo install cargo-about && cargo about generate about.hbs`
> - Python: `pip install pip-licenses && pip-licenses --format=markdown`

---

## Data

- **DB-IP - IP to City Lite database**
  Used (optionally, only if you add the `.mmdb` file) for on-device, approximate,
  city-level location on the optional account record. The lookup happens entirely on
  your computer; your IP is never sent to a third-party geolocation service.
  Licensed under **Creative Commons Attribution 4.0 International (CC BY 4.0)** -
  <https://creativecommons.org/licenses/by/4.0/>.
  Source: <https://db-ip.com/db/download/ip-to-city-lite>.

## Services (not bundled, accessed over the network)

These are not redistributed with the app, but the app relies on them:

- **YouTube & YouTube Music** (Google LLC) - all music, metadata, artwork, and audio
  streams. This app is an unofficial client; all content and trademarks are theirs.
- **Google OAuth 2.0 & the YouTube Data API v3** (Google LLC) - sign-in and official
  playlist management.
- **Supabase** — optional account record storage and Edge Functions.

## Desktop shell & Rust crates

Licensed under **MIT** or **Apache-2.0** (most are dual-licensed `MIT OR Apache-2.0`):

- `tauri`, `tauri-build`, `tauri-plugin-opener` - Tauri (MIT/Apache-2.0)
- `serde`, `serde_json` (MIT/Apache-2.0)
- `reqwest` (MIT/Apache-2.0)
- `jsonwebtoken` (MIT)
- `keyring` (MIT/Apache-2.0)
- `tiny_http` (MIT/Apache-2.0)
- `url`, `base64`, `sha2`, `rand` (MIT/Apache-2.0)
- `open` (MIT)
- `dotenvy` (MIT)

## Frontend (npm)

- `react`, `react-dom` (MIT)
- `react-markdown`, `remark-gfm` (MIT)
- `@tauri-apps/api`, `@tauri-apps/plugin-opener`, `@tauri-apps/cli` (MIT/Apache-2.0)
- `vite`, `@vitejs/plugin-react` (MIT)
- `typescript` (Apache-2.0)
- `@types/react`, `@types/react-dom` (MIT)

## Sidecar (Python)

- `ytmusicapi` (MIT) - YouTube Music InnerTube client
- `yt-dlp` (The Unlicense / public domain) - stream resolution & downloads
- `fastapi` (MIT) - local HTTP helper
- `uvicorn` (BSD-3-Clause) - ASGI server
- `python-dotenv` (BSD-3-Clause) - env loading
- `geoip2` (Apache-2.0) - MaxMind-format database reader
- `imageio-ffmpeg` (BSD-2-Clause) - ships the bundled ffmpeg binary used for downloads

### Bundled FFmpeg binary

The download feature shells out to **FFmpeg**, whose binary is bundled (via
`imageio-ffmpeg`) inside the frozen sidecar. FFmpeg is licensed under the
**GNU LGPL-2.1-or-later** (some builds, GPL). It is a separate program invoked as a
subprocess — it is not linked into this app's code, so its copyleft does not extend
to the rest of the project. License + source: <https://ffmpeg.org/legal.html> and
<https://ffmpeg.org/download.html>.

Transitive dependencies (e.g. `pydantic`, `starlette`, `anyio`) carry their own
permissive MIT/BSD/Apache licenses; collect them with the tooling noted above when
cutting a release.

---

_If you believe a component is missing or mis-attributed here, please open an issue,
correct attribution matters and will fix it promptly._
