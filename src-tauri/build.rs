fn main() {
    // Bake src-tauri/.env into the binary so `env!("GOOGLE_CLIENT_ID")` etc. resolve
    // at compile time. The .env is gitignored; for a Desktop OAuth client the secret
    // is non-confidential (PKCE protects the flow), so compiling it in is fine.
    println!("cargo:rerun-if-changed=.env");
    if let Ok(iter) = dotenvy::from_filename_iter(".env") {
        for (key, value) in iter.flatten() {
            println!("cargo:rustc-env={key}={value}");
        }
    }

    // Re-link (and re-embed the app icon) whenever the icon files change.
    // tauri_build doesn't watch these reliably, so a `tauri icon` regen would
    // otherwise be ignored and the old icon stays baked into the binary.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");

    tauri_build::build()
}
