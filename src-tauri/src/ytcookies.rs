// ═══════════════════════════════════════════════════════════════════════════════
// ytcookies.rs — YouTube Music session-cookie auth (the in-app login spike)
// ═══════════════════════════════════════════════════════════════════════════════
//
// OAuth tokens are rejected by YouTube's private InnerTube API, so the personalized
// home, library artists/albums, real liked songs and history are only reachable with
// a logged-in *session cookie*. We get one by opening an in-app login window to
// music.youtube.com (spoofing a desktop-Chrome user-agent so Google is less likely to
// block the embedded webview), letting the user sign in, then reading the cookies —
// including the HttpOnly `__Secure-3PAPISID` that ytmusicapi needs — straight from the
// webview's cookie store (Tauri 2.2+). The raw cookie is persisted to a file in the
// app-data directory and pushed to the sidecar, which verifies it with a real call.

use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LOGIN_LABEL: &str = "ytmusic-login";
// Hidden window used on startup to silently re-rotate the Google session cookies.
const REFRESH_LABEL: &str = "ytmusic-refresh";
const YTM_URL: &str = "https://music.youtube.com/";
const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// Only do the (slow) webview refresh when the stored cookie is older than this — so
// frequent restarts stay instant, but a session left to go stale (overnight+) is
// refreshed. Google rotates __Secure-3PSIDTS/SIDCC roughly daily; 6h is a safe margin.
const REFRESH_AFTER: Duration = Duration::from_secs(6 * 3600);
// How long to let the hidden YTM page load + run Google's background cookie rotation
// before we read the refreshed cookies back out of the shared store.
const REFRESH_WAIT: Duration = Duration::from_secs(7);

fn sidecar_base() -> String {
    format!("http://127.0.0.1:{}", crate::SIDECAR_PORT)
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        // Verifying the cookie makes several cold InnerTube calls to YouTube, which can
        // be slow on first use — give it generous headroom so we don't drop the request.
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())
}

// ── File storage (raw session cookie) ───────────────────────────────────────────
// Windows Credential Manager caps CredentialBlobSize at 2560 bytes (1280 UTF-16
// chars), which the combined Google cookie string regularly exceeds. Store as a
// plain file in the user's app-data directory instead — same directory the Python
// sidecar uses for history.json, so it's already user-private and per-profile.
fn cookie_file_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|d| std::path::PathBuf::from(d).join("YouTubeMusic").join("ytm_session.dat"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME").ok().map(|h| {
            std::path::PathBuf::from(h)
                .join("Library")
                .join("Application Support")
                .join("YouTubeMusic")
                .join("ytm_session.dat")
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::env::var("HOME").ok().map(|h| {
            std::path::PathBuf::from(h)
                .join(".local")
                .join("share")
                .join("YouTubeMusic")
                .join("ytm_session.dat")
        })
    }
}
fn store_cookie(c: &str) {
    if let Some(path) = cookie_file_path() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, c.as_bytes());
    }
}
fn load_cookie() -> Option<String> {
    std::fs::read_to_string(cookie_file_path()?).ok()
}
fn clear_cookie() {
    if let Some(path) = cookie_file_path() {
        let _ = std::fs::remove_file(path);
    }
}

// The Google/YouTube auth cookies ytmusicapi needs. We send ONLY these (an allowlist)
// rather than the whole webview cookie store — the full store can be tens of KB, and a
// large localhost POST body was getting the connection reset on Windows. This keeps the
// body to a couple of KB and avoids odd third-party cookies.
const AUTH_COOKIES: &[&str] = &[
    "SID", "__Secure-1PSID", "__Secure-3PSID",
    "HSID", "SSID", "APISID", "SAPISID",
    "__Secure-1PAPISID", "__Secure-3PAPISID",
    "SIDCC", "__Secure-1PSIDCC", "__Secure-3PSIDCC",
    "__Secure-1PSIDTS", "__Secure-3PSIDTS",
    "LOGIN_INFO", "PREF", "YSC", "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA",
];

// Join the allowlisted cookies into a "name=value; …" header — but only if the session
// marker (__Secure-3PAPISID, which ytmusicapi hashes for auth) is present (i.e. logged in).
fn build_cookie_header(cookies: &[tauri::webview::Cookie<'static>]) -> Option<String> {
    let mut has_session = false;
    let mut parts: Vec<String> = Vec::new();
    for c in cookies {
        if !AUTH_COOKIES.contains(&c.name()) {
            continue;
        }
        if c.name() == "__Secure-3PAPISID" {
            has_session = true;
        }
        parts.push(format!("{}={}", c.name(), c.value()));
    }
    if has_session && !parts.is_empty() {
        Some(parts.join("; "))
    } else {
        None
    }
}

// Hand the cookie to the sidecar, which builds a ytmusicapi browser client and tests
// it with a real authenticated call. Returns the sidecar's JSON ({ok, accountName, …}).
fn push_cookie_to_sidecar(cookie: &str) -> Result<serde_json::Value, String> {
    let http = http_client()?;
    let resp = http
        .post(format!("{}/auth/ytmusic-cookie", sidecar_base()))
        .bearer_auth(crate::sidecar_token_value())
        .json(&serde_json::json!({ "cookie": cookie }))
        .send()
        .map_err(|e| format!("request to sidecar failed: {e:?}"))?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|_| format!("sidecar returned status {status}: {text}"))
}

// ── Commands ─────────────────────────────────────────────────────────────────────

/// Open the in-app YouTube Music login window. The user signs in there.
#[tauri::command]
pub async fn ytmusic_connect_begin(app: AppHandle) -> Result<(), String> {
    let url: tauri::Url = YTM_URL.parse().map_err(|e| format!("bad url: {e}"))?;
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.close();
    }
    WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(url))
        .title("Sign in to YouTube Music, then click \u{201c}I\u{2019}ve signed in\u{201d}")
        .inner_size(480.0, 720.0)
        .user_agent(CHROME_UA)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the cookies from the (still-open) login window, verify a session is present,
/// store it, and push to the sidecar for an authenticated test. Returns the sidecar's
/// result JSON. Errors if the user hasn't finished signing in.
#[tauri::command]
pub async fn ytmusic_connect_finish(app: AppHandle) -> Result<serde_json::Value, String> {
    let url: tauri::Url = YTM_URL.parse().map_err(|e| format!("bad url: {e}"))?;
    // The app's webviews share one cookie store, so read from whichever window exists —
    // the login window if it's still open, else the always-present main window. (The
    // login window can navigate/close during Google sign-in, so we don't depend on it.)
    let win = app
        .get_webview_window(LOGIN_LABEL)
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or("No app window available to read cookies from.")?;
    let cookies = win.cookies_for_url(url).map_err(|e| e.to_string())?;
    let header = build_cookie_header(&cookies).ok_or(
        "Couldn't find a signed-in YouTube Music session yet. Make sure you completed \
         sign-in in the login window (you should see your YT Music home), then click again.",
    )?;
    // Close the login window if it's still open.
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.close();
    }

    let cookie = header.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        store_cookie(&cookie);
        push_cookie_to_sidecar(&cookie)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(result)
}

/// Disconnect: delete the stored cookie file and clear the sidecar's browser client.
#[tauri::command]
pub async fn ytmusic_disconnect() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        clear_cookie();
        if let Ok(http) = http_client() {
            let _ = http
                .delete(format!("{}/auth/ytmusic-cookie", sidecar_base()))
                .bearer_auth(crate::sidecar_token_value())
                .send();
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Push the on-disk cookie to the sidecar as-is (no rotation). Used when the stored
/// cookie is still fresh, or as a fallback if a refresh can't complete.
pub async fn restore() -> bool {
    tauri::async_runtime::spawn_blocking(|| match load_cookie() {
        Some(cookie) => push_cookie_to_sidecar(&cookie)
            .ok()
            .and_then(|v| v.get("ok").and_then(|b| b.as_bool()))
            .unwrap_or(false),
        None => false,
    })
    .await
    .unwrap_or(false)
}

/// True when the stored cookie was written recently enough that its rotating Google
/// session tokens (__Secure-3PSIDTS / SIDCC) should still be valid — so we can skip
/// the webview refresh and just push it.
fn cookie_is_fresh() -> bool {
    cookie_file_path()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|age| age < REFRESH_AFTER)
        .unwrap_or(false)
}

/// Silently RE-ROTATE the Google session before pushing it. The stored cookie's
/// rotating tokens (__Secure-3PSIDTS / SIDCC) go stale after ~a day; once stale,
/// basic SAPISIDHASH auth still works (library/playback) but personalized endpoints
/// (home "Quick picks", history, account) start failing — so the home silently
/// degrades to a generic logged-in feed. To refresh them the way a real browser does,
/// we open a hidden, off-screen webview to music.youtube.com (the persisted SID
/// cookies are valid for months, so Google rotates SIDTS as the page loads), then
/// re-read the freshened cookies from the shared store, persist them, and push to the
/// sidecar. Falls back to the on-disk cookie if anything goes wrong.
async fn refresh_and_push(app: AppHandle) -> bool {
    if load_cookie().is_none() {
        return false; // nothing connected — nothing to restore
    }
    // Recently refreshed → skip the slow rotation, just push what we have.
    if cookie_is_fresh() {
        return restore().await;
    }
    let url: tauri::Url = match YTM_URL.parse() {
        Ok(u) => u,
        Err(_) => return restore().await,
    };

    // Build a hidden, unfocused, taskbar-less webview pointed at YTM. Loading the page
    // with valid SID cookies triggers Google's background cookie rotation in the shared
    // store. If it can't be created, fall back to pushing the stored cookie.
    if app.get_webview_window(REFRESH_LABEL).is_none()
        && WebviewWindowBuilder::new(&app, REFRESH_LABEL, WebviewUrl::External(url.clone()))
            .title("")
            .inner_size(420.0, 600.0)
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .user_agent(CHROME_UA)
            .build()
            .is_err()
    {
        return restore().await;
    }

    // Give the page time to load + rotate the cookies (runs in the webview process; we
    // just wait off the async executor).
    let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(REFRESH_WAIT)).await;

    // Read the (hopefully refreshed) cookies from the shared store, then close the
    // hidden window regardless of outcome.
    let refreshed = app
        .get_webview_window(REFRESH_LABEL)
        .or_else(|| app.get_webview_window("main"))
        .and_then(|w| w.cookies_for_url(url).ok())
        .and_then(|cs| build_cookie_header(&cs));
    if let Some(w) = app.get_webview_window(REFRESH_LABEL) {
        let _ = w.close();
    }

    match refreshed {
        // Got a fresh session → persist it (advances the freshness clock) and push.
        Some(cookie) => {
            store_cookie(&cookie);
            tauri::async_runtime::spawn_blocking(move || {
                push_cookie_to_sidecar(&cookie)
                    .ok()
                    .and_then(|v| v.get("ok").and_then(|b| b.as_bool()))
                    .unwrap_or(false)
            })
            .await
            .unwrap_or(false)
        }
        // Rotation produced nothing usable (e.g. store logged out) → push the stored
        // cookie unchanged so we don't drop a session that may still partly work.
        None => restore().await,
    }
}

#[tauri::command]
pub async fn ytmusic_restore(app: AppHandle) -> Result<bool, String> {
    Ok(refresh_and_push(app).await)
}
