// ═══════════════════════════════════════════════════════════════════════════════
// oauth.rs — Google sign-in via OAuth 2.0 Authorization Code + PKCE (loopback)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Identity sign-in: a verified Google identity (email / name / picture) via the
// RFC 8252 native-app pattern (PKCE + loopback redirect). Used for account sign-in,
// the first-login record, and the official YouTube Data API.
//
// NOTE: YouTube's PRIVATE music API (InnerTube) does NOT accept third-party OAuth
// tokens, so this token is for identity + the Data API only — never InnerTube.
//
//   1. Mint PKCE verifier/challenge + random `state` (CSRF) + `nonce` (id_token replay).
//   2. Bind a one-shot loopback listener on 127.0.0.1:<random port>.
//   3. Open the SYSTEM browser to Google's consent page.
//   4. Catch the redirect, verify `state`, exchange the code (+ PKCE verifier).
//   5. Validate the id_token (RS256/JWKS + iss/aud/exp + nonce); enrich from userinfo.
//   6. Persist the refresh token in the OS keychain; push the token to the sidecar.
//
// Client id/secret are baked in at build time from src-tauri/.env (see build.rs).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use url::Url;

// ── Compile-time config (from src-tauri/.env via build.rs) ──────────────────────
const CLIENT_ID: &str = env!("GOOGLE_CLIENT_ID");
const CLIENT_SECRET: &str = env!("GOOGLE_CLIENT_SECRET");

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const JWKS_URI: &str = "https://www.googleapis.com/oauth2/v3/certs";
const SCOPE: &str = "openid email profile https://www.googleapis.com/auth/youtube";

const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT: &str = "https://www.googleapis.com/oauth2/v3/userinfo";

const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);

// OS keychain (Windows Credential Manager) — stores ONLY the long-lived refresh token.
const KEYRING_SERVICE: &str = "com.youtubemusic.desktop";
const KEYRING_USER: &str = "google-refresh-token";

// ── Verified identity returned to the frontend ──────────────────────────────────
#[derive(Clone, serde::Serialize)]
pub struct Identity {
    pub sub: String,
    pub email: String,
    pub name: String,
    pub picture: String,
    pub email_verified: bool,
}

// ── In-memory session (refresh token persisted to the OS keychain) ──────────────
struct Session {
    identity: Identity,
    #[allow(dead_code)]
    access_token: String,
    refresh_token: Option<String>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// The currently signed-in identity, if any (drives `oauth_status`).
pub fn current_identity() -> Option<Identity> {
    SESSION
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.identity.clone()))
}

// ── Token lifecycle helpers ─────────────────────────────────────────────────────

fn now_epoch() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

fn sidecar_base() -> String {
    format!("http://127.0.0.1:{}", crate::SIDECAR_PORT)
}

// The id_token doesn't always carry name/picture (especially refresh-issued ones),
// so fetch them from the userinfo endpoint — reliable in both flows.
fn fetch_userinfo(http: &reqwest::blocking::Client, access_token: &str) -> Option<UserInfo> {
    http.get(USERINFO_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .ok()?
        .json()
        .ok()
}

fn enrich_identity(http: &reqwest::blocking::Client, mut identity: Identity, access_token: &str) -> Identity {
    if let Some(ui) = fetch_userinfo(http, access_token) {
        if !ui.name.is_empty() {
            identity.name = ui.name;
        }
        if !ui.picture.is_empty() {
            identity.picture = ui.picture;
        }
        if !ui.email.is_empty() {
            identity.email = ui.email;
        }
    }
    identity
}

/// Push the current token bundle to the sidecar (identity/Data-API use). Retries
/// briefly in case the sidecar is still starting up.
fn push_to_sidecar(http: &reqwest::blocking::Client, access_token: &str, refresh_token: &str, expires_at: i64) {
    let body = serde_json::json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_at": expires_at,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    });
    for _ in 0..5 {
        match http
            .post(format!("{}/auth/session", sidecar_base()))
            .bearer_auth(crate::sidecar_token_value())
            .json(&body)
            .send()
        {
            Ok(r) if r.status().is_success() => return,
            _ => std::thread::sleep(Duration::from_millis(400)),
        }
    }
}

fn clear_sidecar(http: &reqwest::blocking::Client) {
    let _ = http
        .delete(format!("{}/auth/session", sidecar_base()))
        .bearer_auth(crate::sidecar_token_value())
        .send();
}

// ── OS keychain (refresh token only) ─────────────────────────────────────────────

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn store_refresh_token(rt: &str) {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.set_password(rt);
    }
}

fn load_refresh_token() -> Option<String> {
    keyring_entry().ok().and_then(|e| e.get_password().ok())
}

fn clear_refresh_token() {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
}

fn refresh_access_token(
    http: &reqwest::blocking::Client,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let resp = http
        .post(TOKEN_ENDPOINT)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
        ])
        .send()
        .map_err(|e| format!("refresh request failed: {e}"))?;
    let tok: TokenResponse = resp.json().map_err(|e| format!("refresh parse failed: {e}"))?;
    if let Some(err) = tok.error {
        return Err(format!("refresh error: {err}"));
    }
    Ok(tok)
}

// ── Restore on startup (silent re-login from the keychain) ───────────────────────
pub async fn restore() -> Option<Identity> {
    tauri::async_runtime::spawn_blocking(restore_blocking)
        .await
        .ok()
        .flatten()
}

fn restore_blocking() -> Option<Identity> {
    if let Some(id) = current_identity() {
        return Some(id);
    }
    let refresh_token = load_refresh_token()?;
    let http = http_client().ok()?;
    let tok = refresh_access_token(&http, &refresh_token).ok()?;
    if tok.id_token.is_empty() {
        return None; // can't rebuild a verified identity → require fresh login
    }
    // Refresh-issued id_tokens carry no nonce; signature/iss/aud/exp still checked,
    // then name/picture/email come from userinfo.
    let identity = enrich_identity(
        &http,
        verify_id_token(&http, &tok.id_token, None).ok()?,
        &tok.access_token,
    );
    let expires_at = now_epoch() + tok.expires_in;

    push_to_sidecar(&http, &tok.access_token, &refresh_token, expires_at);
    if let Ok(mut g) = SESSION.lock() {
        *g = Some(Session {
            identity: identity.clone(),
            access_token: tok.access_token,
            refresh_token: Some(refresh_token),
        });
    }
    Some(identity)
}

// ── Logout: revoke at Google + clear keychain + clear sidecar + clear session ────
pub async fn logout() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(logout_blocking)
        .await
        .map_err(|e| e.to_string())
}

fn logout_blocking() {
    let refresh_token = {
        let from_session = SESSION
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(|s| s.refresh_token.clone()));
        from_session.or_else(load_refresh_token)
    };
    if let Ok(http) = http_client() {
        if let Some(rt) = refresh_token {
            let _ = http.post(REVOKE_ENDPOINT).form(&[("token", rt.as_str())]).send();
        }
        clear_sidecar(&http);
    }
    clear_refresh_token();
    if let Ok(mut g) = SESSION.lock() {
        *g = None;
    }
}

// ── Public entry point (called from the async `oauth_begin` IPC command) ────────
//
// The flow blocks (loopback listener + blocking HTTP), so we run it on a blocking
// thread and await it — keeping the UI thread responsive.
pub async fn begin() -> Result<Identity, String> {
    tauri::async_runtime::spawn_blocking(run_flow)
        .await
        .map_err(|e| format!("login task failed: {e}"))?
}

fn random_b64(n_bytes: usize) -> String {
    let mut bytes = vec![0u8; n_bytes];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn run_flow() -> Result<Identity, String> {
    // 1. PKCE + anti-CSRF/replay nonces.
    let code_verifier = random_b64(32);
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let state = random_b64(16);
    let nonce = random_b64(16);

    // 2. One-shot loopback listener on an OS-assigned ephemeral port.
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("could not start loopback listener: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("loopback listener has no IP address")?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    // 3. Build the consent URL and open it in the system browser.
    let mut auth = Url::parse(AUTH_ENDPOINT).map_err(|e| e.to_string())?;
    auth.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    open::that(auth.as_str()).map_err(|e| format!("could not open browser: {e}"))?;

    // 4. Wait for Google to redirect back to the loopback (verify `state`).
    let code = wait_for_code(&server, &state)?;

    // 5. Exchange the authorization code (+ PKCE verifier) for tokens.
    let http = http_client()?;
    let token_resp = http
        .post(TOKEN_ENDPOINT)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("code_verifier", code_verifier.as_str()),
        ])
        .send()
        .map_err(|e| format!("token request failed: {e}"))?;

    let tok: TokenResponse = token_resp
        .json()
        .map_err(|e| format!("could not parse token response: {e}"))?;
    if let Some(err) = tok.error {
        return Err(format!("token endpoint error: {err}"));
    }
    if tok.id_token.is_empty() {
        return Err("token response had no id_token".into());
    }

    // 6. Validate the id_token (sig/iss/aud/exp + nonce); enrich from userinfo.
    let identity = enrich_identity(
        &http,
        verify_id_token(&http, &tok.id_token, Some(&nonce))?,
        &tok.access_token,
    );

    // 7. Persist refresh token, push the bundle to the sidecar, stash the session.
    let refresh_token = tok.refresh_token.clone().unwrap_or_default();
    let expires_at = now_epoch() + tok.expires_in;
    if !refresh_token.is_empty() {
        store_refresh_token(&refresh_token);
    }
    push_to_sidecar(&http, &tok.access_token, &refresh_token, expires_at);

    *SESSION.lock().map_err(|_| "session lock poisoned")? = Some(Session {
        identity: identity.clone(),
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
    });

    Ok(identity)
}

/// Block until the loopback receives the redirect (with code/error), ignoring stray
/// requests. Enforces the timeout and the `state` match.
fn wait_for_code(server: &tiny_http::Server, expected_state: &str) -> Result<String, String> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("login timed out")?;
        let request = match server.recv_timeout(remaining).map_err(|e| e.to_string())? {
            Some(r) => r,
            None => return Err("login timed out".into()),
        };

        let full = format!("http://127.0.0.1{}", request.url());
        let parsed = Url::parse(&full).map_err(|e| e.to_string())?;
        let mut code = None;
        let mut state = None;
        let mut oauth_err = None;
        for (k, v) in parsed.query_pairs() {
            match k.as_ref() {
                "code" => code = Some(v.into_owned()),
                "state" => state = Some(v.into_owned()),
                "error" => oauth_err = Some(v.into_owned()),
                _ => {}
            }
        }
        if code.is_none() && oauth_err.is_none() {
            let _ = request.respond(tiny_http::Response::empty(404));
            continue;
        }

        let html = "<!doctype html><html><body style=\"font-family:system-ui;text-align:center;\
            padding-top:3rem;background:#0f0f0f;color:#fff\"><h2>Signed in \u{2713}</h2>\
            <p>You can close this tab and return to YouTube Music.</p></body></html>";
        let header = tiny_http::Header::from_bytes(
            &b"Content-Type"[..],
            &b"text/html; charset=utf-8"[..],
        )
        .unwrap();
        let _ = request.respond(tiny_http::Response::from_string(html).with_header(header));

        if let Some(e) = oauth_err {
            return Err(format!("Google denied the request: {e}"));
        }
        if state.as_deref() != Some(expected_state) {
            return Err("state mismatch — possible CSRF, aborting".into());
        }
        return code.ok_or_else(|| "callback had no authorization code".into());
    }
}

/// Verify Google's id_token (RS256 signature via JWKS + iss/aud/exp) and extract
/// the trusted identity claims. The nonce is checked on the interactive flow only.
fn verify_id_token(
    http: &reqwest::blocking::Client,
    id_token: &str,
    expected_nonce: Option<&str>,
) -> Result<Identity, String> {
    let jwks: Jwks = http
        .get(JWKS_URI)
        .send()
        .map_err(|e| format!("JWKS fetch failed: {e}"))?
        .json()
        .map_err(|e| format!("JWKS parse failed: {e}"))?;

    let header = jsonwebtoken::decode_header(id_token).map_err(|e| e.to_string())?;
    let kid = header.kid.ok_or("id_token header missing kid")?;
    let jwk = jwks
        .keys
        .iter()
        .find(|k| k.kid == kid)
        .ok_or("no matching key in Google JWKS")?;

    let key = jsonwebtoken::DecodingKey::from_rsa_components(&jwk.n, &jwk.e)
        .map_err(|e| format!("bad JWKS key: {e}"))?;

    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[CLIENT_ID]);
    validation.set_issuer(&["https://accounts.google.com", "accounts.google.com"]);

    let data = jsonwebtoken::decode::<IdClaims>(id_token, &key, &validation)
        .map_err(|e| format!("id_token validation failed: {e}"))?;

    if let Some(expected) = expected_nonce {
        if data.claims.nonce.as_deref() != Some(expected) {
            return Err("id_token nonce mismatch — possible replay".into());
        }
    }

    Ok(Identity {
        sub: data.claims.sub,
        email: data.claims.email,
        name: data.claims.name,
        picture: data.claims.picture,
        email_verified: data.claims.email_verified,
    })
}

// ── Wire types ──────────────────────────────────────────────────────────────────
#[derive(serde::Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    id_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: i64,
    #[serde(default)]
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct IdClaims {
    sub: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    picture: String,
    #[serde(default)]
    email_verified: bool,
    #[serde(default)]
    nonce: Option<String>,
    // Present so jsonwebtoken can validate expiry.
    #[allow(dead_code)]
    exp: usize,
}

#[derive(serde::Deserialize)]
struct UserInfo {
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    picture: String,
}

#[derive(serde::Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(serde::Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}
