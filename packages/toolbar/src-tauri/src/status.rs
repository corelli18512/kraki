use serde::Deserialize;
use std::fs;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::tray;

const POLL_INTERVAL_SECS: u64 = 2;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    #[serde(default)]
    pub daemon_running: bool,
    #[serde(default = "default_relay_state")]
    pub relay_state: String,
    #[serde(default)]
    pub relay: String,
    #[serde(default)]
    pub device_name: String,
    pub active_session: Option<SessionInfo>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: Option<String>,
    pub state: String,
}

fn default_relay_state() -> String {
    "disconnected".to_string()
}

fn get_status_path() -> std::path::PathBuf {
    let home = std::env::var("KRAKI_HOME").unwrap_or_else(|_| {
        let base = dirs_next();
        format!("{base}/.kraki")
    });
    std::path::PathBuf::from(home).join("status.json")
}

fn dirs_next() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").unwrap_or_else(|_| ".".to_string())
    }
}

pub fn read_status() -> DaemonStatus {
    let path = get_status_path();
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => DaemonStatus::default(),
    }
}

pub fn start_poller(app: tauri::AppHandle) {
    let last_status: Arc<Mutex<Option<DaemonStatus>>> = Arc::new(Mutex::new(None));

    thread::spawn(move || loop {
        let current = read_status();
        let mut last = last_status.lock().unwrap();

        let changed = last
            .as_ref()
            .map(|prev| {
                prev.relay_state != current.relay_state
                    || prev.daemon_running != current.daemon_running
                    || prev.active_session.as_ref().map(|s| &s.id)
                        != current.active_session.as_ref().map(|s| &s.id)
            })
            .unwrap_or(true);

        if changed {
            tray::update_tray(&app, &current);
        }

        *last = Some(current);
        drop(last);

        thread::sleep(Duration::from_secs(POLL_INTERVAL_SECS));
    });
}
