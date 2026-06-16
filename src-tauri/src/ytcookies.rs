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
// webview's cookie store (Tauri 2.2+). The raw cookie is kept in the OS keychain and
// pushed to the sidecar, which verifies it with a real authenticated call.

use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LOGIN_LABEL: &str = "ytmusic-login";
const YTM_URL: &str = "https://music.youtube.com/";
const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const KEYRING_SERVICE: &str = "com.youtubemusic.desktop";
const KEYRING_COOKIE_USER: &str = "ytmusic-cookie";

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

// ── Keychain (raw session cookie) ────────────────────────────────────────────────
fn cookie_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_COOKIE_USER).map_err(|e| e.to_string())
}
fn store_cookie(c: &str) {
    if let Ok(e) = cookie_entry() {
        let _ = e.set_password(c);
    }
}
fn load_cookie() -> Option<String> {
    cookie_entry().ok().and_then(|e| e.get_password().ok())
}
fn clear_cookie_keychain() {
    if let Ok(e) = cookie_entry() {
        let _ = e.delete_credential();
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

/// Disconnect: clear the keychain cookie and the sidecar's browser client.
#[tauri::command]
pub async fn ytmusic_disconnect() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        clear_cookie_keychain();
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

/// On startup, silently re-push any stored cookie to the sidecar. Returns whether a
/// working session was restored.
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

#[tauri::command]
pub async fn ytmusic_restore() -> Result<bool, String> {
    Ok(restore().await)
}
