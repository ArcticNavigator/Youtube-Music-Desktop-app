// ═══════════════════════════════════════════════════════════════════════════════
// lib.rs — Rust backend for YouTube Music Desktop
// ═══════════════════════════════════════════════════════════════════════════════
//
// This file is the heart of the native side of the app. Its two jobs are:
//
//   1. SIDECAR MANAGEMENT
//      On startup, Rust spawns the Python process (sidecar/main.py).
//      That Python process is a small HTTP server (FastAPI) that does all the
//      heavy lifting: fetching YouTube Music data, extracting stream URLs, etc.
//      When the app window closes, Rust kills the Python process cleanly.
//
//   2. IPC COMMANDS
//      The React frontend can call Rust functions via Tauri's `invoke()` API.
//      Right now we expose one command: `sidecar_url()` so the frontend knows
//      which localhost port to talk to.
//
// In later phases this file will also handle:
//   - Audio playback via libmpv (Phase 3)
//   - System tray icon and right-click menu (Phase 4)
//   - Global media hotkeys (Phase 4)
// ═══════════════════════════════════════════════════════════════════════════════

use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};

use rand::RngCore;

mod oauth;
mod ytcookies;

// ── Constants ──────────────────────────────────────────────────────────────────

// The port our Python FastAPI sidecar listens on.
// We use a high, specific port (34785) to avoid clashing with common services.
const SIDECAR_PORT: u16 = 34785;

// ── Localhost auth token ────────────────────────────────────────────────────────
//
// Binding 127.0.0.1 keeps the sidecar off the network, but any OTHER local process
// (or a web page doing a localhost fetch) could still call it. We generate a random
// 256-bit token once per launch, hand it to the sidecar via `--auth-token`, and hand
// it to the frontend via the `sidecar_token` IPC command. Every sidecar request then
// carries `Authorization: Bearer <token>`; requests without it are rejected.
static SIDECAR_TOKEN: OnceLock<String> = OnceLock::new();

fn sidecar_token_value() -> &'static str {
    SIDECAR_TOKEN.get_or_init(|| {
        let mut bytes = [0u8; 32]; // 256 bits
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    })
}

// ── Global sidecar handle ──────────────────────────────────────────────────────
//
// We store the running Python process here so we can kill it when the app exits.
//
// Why `Mutex<Option<Child>>`?
//   - `Child` is the handle to the spawned process (like a PID you can kill).
//   - `Option` because it might not have started yet (None = not started).
//   - `Mutex` because Tauri can call event handlers on different threads, and
//     we need exclusive access when reading or writing the child.
static SIDECAR: Mutex<Option<Child>> = Mutex::new(None);

// ── Helper: which Python binary to use ────────────────────────────────────────
//
// Windows calls it "python", Linux/macOS call it "python3".
// This is a compile-time check — no runtime cost.
fn python_bin() -> &'static str {
    if cfg!(target_os = "windows") {
        "python"
    } else {
        "python3"
    }
}

// ── Free a stale sidecar holding our port ───────────────────────────────────────
//
// On Windows, `python` is a launcher shim that re-execs the real interpreter as a
// separate process. Our `child.kill()` on app close only kills the shim, so an
// unclean exit (Ctrl+C in the dev terminal, a crash) can orphan the real server —
// it keeps holding SIDECAR_PORT with a now-stale per-launch token. The next launch
// then can't bind the port, its fresh sidecar dies, and every guarded request 401s
// because the frontend's new token doesn't match the orphan's old one. So before
// starting, we forcibly free the port.
#[cfg(target_os = "windows")]
fn free_stale_sidecar() {
    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "Get-NetTCPConnection -LocalPort {SIDECAR_PORT} -State Listen \
                 -ErrorAction SilentlyContinue | ForEach-Object {{ \
                 Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}"
            ),
        ])
        .status();
}

#[cfg(not(target_os = "windows"))]
fn free_stale_sidecar() {}

// ── Start the Python sidecar ───────────────────────────────────────────────────
//
// How we find the sidecar:
//   `env!("CARGO_MANIFEST_DIR")` gives us the path to src-tauri/ at build time.
//   We go one level up (..) to reach the project root, then into sidecar/.
//
// This means the sidecar path is baked into the binary at compile time —
// perfectly fine for a personal-use app where source and binary live together.
fn start_sidecar() {
    // Build the full path to sidecar/main.py
    let manifest_dir = env!("CARGO_MANIFEST_DIR"); // e.g. D:\Youtube Music app\src-tauri
    let sidecar_main = std::path::Path::new(manifest_dir)
        .parent()
        .unwrap() // D:\Youtube Music app
        .join("sidecar")
        .join("main.py"); // D:\Youtube Music app\sidecar\main.py

    println!("Starting sidecar: {}", sidecar_main.display());

    // Clear any sidecar orphaned by a previous unclean exit before we start ours.
    free_stale_sidecar();

    match Command::new(python_bin())
        .arg(&sidecar_main)
        .arg("--port")
        .arg(SIDECAR_PORT.to_string())
        .arg("--auth-token")
        .arg(sidecar_token_value())
        .spawn()
    {
        Ok(child) => {
            println!("Sidecar started (PID {})", child.id());
            *SIDECAR.lock().unwrap() = Some(child);
        }
        Err(e) => {
            // Non-fatal: the app will still open, but music won't play.
            // The React UI handles this by showing a "Starting…" screen until
            // the sidecar responds to /health.
            eprintln!("Failed to start sidecar: {e}");
            eprintln!("Make sure Python is installed and on your PATH.");
        }
    }
}

// ── Stop the Python sidecar ────────────────────────────────────────────────────
//
// Called when the app window closes. We kill the Python process so it doesn't
// linger in the background after the user closes the app.
fn stop_sidecar() {
    if let Ok(mut guard) = SIDECAR.lock() {
        if let Some(ref mut child) = *guard {
            println!("Stopping sidecar (PID {})…", child.id());
            let _ = child.kill(); // ignore error if it already exited
        }
        *guard = None;
    }
}

// ── IPC Command: get sidecar URL ──────────────────────────────────────────────
//
// The React frontend calls this on startup via:
//   import { invoke } from "@tauri-apps/api/core";
//   const url = await invoke("sidecar_url"); // → "http://127.0.0.1:34785"
//
// Then all API calls go directly from the React fetch() to that URL.
#[tauri::command]
fn sidecar_url() -> String {
    format!("http://127.0.0.1:{SIDECAR_PORT}")
}

// ── IPC Command: get the sidecar bearer token ──────────────────────────────────
//
// The frontend calls this once on startup and attaches the value as
// `Authorization: Bearer <token>` to every sidecar request. Only code running
// inside our Tauri window can reach this IPC command, so the token never leaks
// to other local processes.
#[tauri::command]
fn sidecar_token() -> String {
    sidecar_token_value().to_string()
}

// ── IPC Command: begin Google sign-in (PKCE loopback flow) ──────────────────────
//
// Opens the system browser to Google's consent page, captures the redirect on a
// loopback listener, exchanges the code, validates the id_token, and returns the
// verified identity (name + email). Async so the blocking flow doesn't freeze the UI.
#[tauri::command]
async fn oauth_begin() -> Result<oauth::Identity, String> {
    oauth::begin().await
}

// ── IPC Command: current signed-in identity (if any) ────────────────────────────
#[tauri::command]
fn oauth_status() -> Option<oauth::Identity> {
    oauth::current_identity()
}

// ── IPC Command: restore session on startup (silent re-login from keychain) ─────
#[tauri::command]
async fn oauth_restore() -> Option<oauth::Identity> {
    oauth::restore().await
}

// ── IPC Command: sign out (revoke at Google + clear keychain/sidecar/session) ───
#[tauri::command]
async fn oauth_logout() -> Result<(), String> {
    oauth::logout().await
}

// ── App entry point ────────────────────────────────────────────────────────────
//
// `pub fn run()` is called from main.rs. The `#[cfg_attr]` line is Tauri's
// magic for mobile entry points — ignore it for desktop use.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 1. Start the Python sidecar before the window opens
    start_sidecar();

    // 2. Build and run the Tauri app
    tauri::Builder::default()
        // Register the opener plugin (lets Rust open URLs in the default browser —
        // used by the OAuth login flow)
        .plugin(tauri_plugin_opener::init())
        // Register our IPC commands so the frontend can call them
        .invoke_handler(tauri::generate_handler![
            sidecar_url,
            sidecar_token,
            oauth_begin,
            oauth_status,
            oauth_restore,
            oauth_logout,
            ytcookies::ytmusic_connect_begin,
            ytcookies::ytmusic_connect_finish,
            ytcookies::ytmusic_disconnect,
            ytcookies::ytmusic_restore
        ])
        // Clean up when the user closes the app — but ONLY when the MAIN window is
        // destroyed. Secondary windows (e.g. the YouTube Music login window) close
        // during normal use and must NOT kill the sidecar.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    stop_sidecar();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
