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

    tauri_build::build()
}
