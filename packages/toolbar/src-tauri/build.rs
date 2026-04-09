fn main() {
    // In dev builds (version is 0.0.0-dev), read the tentacle version
    // from package.json so the tray menu shows a meaningful version.
    let cargo_version = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    if cargo_version.contains("dev") {
        let tentacle_pkg = std::path::Path::new("../../tentacle/package.json");
        if let Ok(content) = std::fs::read_to_string(tentacle_pkg) {
            if let Some(start) = content.find("\"version\"") {
                let rest = &content[start..];
                if let Some(colon) = rest.find(':') {
                    let after_colon = rest[colon + 1..].trim().trim_start_matches('"');
                    if let Some(end) = after_colon.find('"') {
                        let version = &after_colon[..end];
                        println!("cargo:rustc-env=KRAKI_DEV_VERSION={version}");
                    }
                }
            }
        }
    }

    tauri_build::build()
}
