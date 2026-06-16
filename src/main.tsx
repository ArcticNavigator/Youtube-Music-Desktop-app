// ─────────────────────────────────────────────────────────────────────────────
// main.tsx — React entry point (keep this file minimal)
// ─────────────────────────────────────────────────────────────────────────────
//
// This file boots the React app. It finds the <div id="root"> in index.html
// and hands control to App.tsx, which renders everything you see in the window.
//
// StrictMode is a React developer tool that intentionally runs things twice
// in development to catch common bugs early. It has zero effect in production.
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
