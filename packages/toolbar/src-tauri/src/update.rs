use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::tray;

const GITHUB_REPO: &str = "corelli18512/kraki";
const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;
const INITIAL_DELAY_SECS: u64 = 5;

/// The version string of a pending update, if any. Set by the background checker.
pub static PENDING_UPDATE: Mutex<Option<String>> = Mutex::new(None);

/// Fetches the latest release tag from the GitHub API via curl subprocess.
pub fn fetch_latest_version() -> Option<String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");

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

    parse_tag_name(&String::from_utf8(output.stdout).ok()?)
}

fn parse_tag_name(json: &str) -> Option<String> {
    let key = "\"tag_name\":";
    let start = json.find(key)? + key.len();
    let rest = json[start..].trim_start_matches([' ', '"']);
    let end = rest.find('"')?;
    let tag = &rest[..end];
    Some(tag.strip_prefix('v').unwrap_or(tag).to_string())
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
    let current = env!("CARGO_PKG_VERSION").to_string();

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
    fn test_parse_tag_name() {
        let json = r#"{"tag_name":"v0.4.8","name":"Release 0.4.8"}"#;
        assert_eq!(parse_tag_name(json), Some("0.4.8".to_string()));
    }
}
