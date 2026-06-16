// ─────────────────────────────────────────────────────────────────────────────
// main.rs — Binary entry point (keep this file minimal)
// ─────────────────────────────────────────────────────────────────────────────
//
// This file exists only to start the app. All real logic lives in lib.rs.
//
// Why split main.rs and lib.rs?
//   Tauri needs lib.rs for mobile builds (iOS/Android use a library entry point,
//   not a binary main()). Keeping them separate means the same code works for
//   both desktop (main.rs) and mobile (lib.rs) without duplication.
//
// The `#![cfg_attr(...)]` line hides the console window on Windows in release
// builds. Without it, a black terminal window would flash open alongside the app.
// In debug/dev mode we keep it so you can see println! output.
// ─────────────────────────────────────────────────────────────────────────────

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    youtube_music_lib::run()
}
