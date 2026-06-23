; ─────────────────────────────────────────────────────────────────────────────
; NSIS installer hooks — wipe ALL per-user data on uninstall, so a later reinstall
; starts completely fresh (no silent re-login). Opt-in behaviour requested explicitly.
;
; By default an uninstall removes only the program files; the Google refresh token in
; Windows Credential Manager and the AppData / WebView2 stores survive, which is why a
; reinstall stayed logged in. These hooks clear all three.
;
; NOTE: this runs only for the NSIS installer (setup.exe). The MSI does not get this
; cleanup (WiX custom actions would be needed). Tauri's default install mode is
; per-user, so $APPDATA / $LOCALAPPDATA resolve to the uninstalling user's profile.
; ─────────────────────────────────────────────────────────────────────────────

!macro NSIS_HOOK_POSTUNINSTALL
  ; 1) Google refresh token — Windows Credential Manager generic credential.
  ;    Target name confirmed via `cmdkey /list` (keyring service com.youtubemusic.desktop,
  ;    user "google-refresh-token").
  nsExec::Exec '"$SYSDIR\cmdkey.exe" /delete:google-refresh-token.com.youtubemusic.desktop'

  ; 2) Roaming app data — caches (home/podcasts/thumbnails), history, and the
  ;    YouTube Music session cookie (ytm_session.dat).
  RMDir /r "$APPDATA\YouTubeMusic"

  ; 3) Local app data — the WebView2 user-data store (holds the Google/YTM login
  ;    cookies) plus any other local app data. The WebView2 folder is named after
  ;    the app's productName, so wipe both the old ("YouTube Music") and current
  ;    ("Tunecat Music") names — covers upgrades from the old build and fresh installs.
  RMDir /r "$LOCALAPPDATA\com.youtubemusic.desktop"
  RMDir /r "$LOCALAPPDATA\YouTube Music"
  RMDir /r "$LOCALAPPDATA\Tunecat Music"
!macroend
