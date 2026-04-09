use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::tray;

const GITHUB_REPO: &str = "corelli18512/kraki";
const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;
const INITIAL_DELAY_SECS: u64 = 5;

/// The version string of a pending update, if any. Set by the background checker.
pub static PENDING_UPDATE: Mutex<Option<String>> = Mutex::new(None);

/// Fetches the latest release that contains binary assets (kraki-macos, kraki-linux, etc).
/// Skips web-only releases that have no binary artifacts.
pub fn fetch_latest_version() -> Option<String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases");

    let output = std::process::Command::new("curl")
        .args([
            "-sSf",
            "--max-time", "10",
            "-H", "User-Agent: kraki-toolbar-updater",
            "-H", "Accept: application/vnd.github.v3+json",
            &url,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let body = String::from_utf8(output.stdout).ok()?;
    // Find the first v* release that has a binary asset (e.g. "kraki-macos")
    find_latest_binary_release(&body)
}

/// Scan releases JSON for the first v* tag that has a "kraki-" asset name.
fn find_latest_binary_release(json: &str) -> Option<String> {
    // Walk through release objects looking for tag_name + assets containing "kraki-"
    let tag_key = "\"tag_name\":";
    let assets_key = "\"assets\":";
    let name_key = "\"name\":";

    let mut pos = 0;
    while let Some(tag_idx) = json[pos..].find(tag_key) {
        let tag_start = pos + tag_idx + tag_key.len();
        let rest = json[tag_start..].trim_start_matches([' ', '"']);
        let tag = if let Some(end) = rest.find('"') {
            &rest[..end]
        } else {
            pos = tag_start;
            continue;
        };

        let version = match tag.strip_prefix('v') {
            Some(v) => v.to_string(),
            None => { pos = tag_start; continue; }
        };

        // Find the assets array for this release (before the next tag_name)
        let next_tag = json[tag_start..].find(tag_key).map(|i| tag_start + i).unwrap_or(json.len());
        let assets_region = &json[tag_start..next_tag];

        if let Some(assets_idx) = assets_region.find(assets_key) {
            let assets_str = &assets_region[assets_idx..];
            // Check if any asset name contains "kraki-" (binary artifacts)
            let mut apos = 0;
            while let Some(name_idx) = assets_str[apos..].find(name_key) {
                let nstart = apos + name_idx + name_key.len();
                let nrest = assets_str[nstart..].trim_start_matches([' ', '"']);
                if let Some(nend) = nrest.find('"') {
                    let asset_name = &nrest[..nend];
                    if asset_name.starts_with("kraki-") {
                        return Some(version);
                    }
                }
                apos = nstart;
            }
        }

        pos = tag_start;
    }
    None
}

/// Returns true if `latest` is strictly newer than `current` (semver comparison).
pub fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> [u64; 3] {
        let mut parts = s.splitn(3, '.').map(|p| p.parse::<u64>().unwrap_or(0));
        [parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0)]
    };
    parse(latest) > parse(current)
}

/// Start the background update checker. Checks after INITIAL_DELAY_SECS on startup,
/// then every CHECK_INTERVAL_SECS. Updates PENDING_UPDATE and rebuilds the tray menu.
pub fn start_checker(app: tauri::AppHandle) {
    let current = crate::tray::effective_version().to_string();

    thread::spawn(move || {
        thread::sleep(Duration::from_secs(INITIAL_DELAY_SECS));

        loop {
            if let Some(latest) = fetch_latest_version() {
                if is_newer(&latest, &current) {
                    let mut pending = PENDING_UPDATE.lock().unwrap();
                    if pending.as_deref() != Some(&latest) {
                        *pending = Some(latest);
                        drop(pending);
                        let status = crate::status::read_status();
                        tray::update_tray(&app, &status);
                    }
                }
            }

            thread::sleep(Duration::from_secs(CHECK_INTERVAL_SECS));
        }
    });
}

/// Open the GitHub Releases page in the default browser.
pub fn open_releases_page() {
    let url = format!("https://github.com/{GITHUB_REPO}/releases/latest");
    #[cfg(target_os = "macos")]
    { let _ = std::process::Command::new("open").arg(&url).spawn(); }
    #[cfg(target_os = "windows")]
    { let _ = std::process::Command::new("cmd").args(["/c", "start", "", &url]).spawn(); }
    #[cfg(target_os = "linux")]
    { let _ = std::process::Command::new("xdg-open").arg(&url).spawn(); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_newer() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
    }

    #[test]
    fn test_find_latest_binary_release() {
        let json = r#"[
            {"tag_name":"v0.9.2","assets":[]},
            {"tag_name":"v0.9.1","assets":[{"name":"kraki-macos-arm64"},{"name":"SHA256SUMS.txt"}]},
            {"tag_name":"v0.9.0","assets":[{"name":"kraki-linux-x64"}]}
        ]"#;
        assert_eq!(find_latest_binary_release(json), Some("0.9.1".to_string()));
    }

    #[test]
    fn test_skips_web_only_releases() {
        let json = r#"[
            {"tag_name":"v0.9.2","assets":[{"name":"web-dist.tar.gz"}]},
            {"tag_name":"v0.9.1","assets":[]}
        ]"#;
        assert_eq!(find_latest_binary_release(json), None);
    }
}
