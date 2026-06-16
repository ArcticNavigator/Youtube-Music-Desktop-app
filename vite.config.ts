// ═══════════════════════════════════════════════════════════════════════════════
// vite.config.ts — Vite bundler configuration
// ═══════════════════════════════════════════════════════════════════════════════
//
// Vite is the build tool for the React frontend (the src/ folder).
// In dev mode, it runs a hot-reload server at http://localhost:1420.
// Tauri opens that URL in the desktop window, so every time you save a .tsx
// file the UI updates instantly — no need to rebuild Rust.
//
// This config has minimal changes from the Tauri default:
//   - Port is fixed at 1420 (Tauri's default dev URL)
//   - src-tauri/ is excluded from file watching (Rust builds separately)
// ═══════════════════════════════════════════════════════════════════════════════

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// TAURI_DEV_HOST is set when running on a remote device (e.g. Android emulator).
// For desktop development it's always undefined — the || false means "bind to localhost".
// @ts-expect-error process is a Node.js global (not in browser types, but fine here)
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],

  // Don't clear the terminal on rebuild — shows Rust compiler errors from Tauri too
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true, // fail if port 1420 is taken (instead of using a random port)
    host: host || false,

    // WebSocket for hot-module replacement (instant UI updates on save)
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,

    watch: {
      // Don't trigger Vite rebuilds when Rust files change (Cargo handles those)
      ignored: ["**/src-tauri/**"],
    },
  },
}));
