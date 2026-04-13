use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

use crate::tray;

const INITIAL_DELAY_SECS: u64 = 5;
const CHECK_INTERVAL_SECS: u64 = 4 * 60 * 60; // 4 hours

/// The version string of a pending update, if any.
pub static PENDING_UPDATE: Mutex<Option<String>> = Mutex::new(None);

/// Start the background update checker using tauri-plugin-updater.
/// Checks shortly after startup, then every CHECK_INTERVAL_SECS.
pub fn start_checker(app: tauri::AppHandle) {
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(INITIAL_DELAY_SECS));

        loop {
            let app_clone = app.clone();
            let result = tauri::async_runtime::block_on(async {
                let updater = app_clone.updater_builder().build().ok()?;
                updater.check().await.ok()?
            });

            if let Some(update) = result {
                let version = update.version.clone();
                let mut pending = PENDING_UPDATE.lock().unwrap();
                if pending.as_deref() != Some(&version) {
                    *pending = Some(version);
                    drop(pending);
                    let status = crate::status::read_status();
                    tray::update_tray(&app, &status);
                }
            }

            thread::sleep(Duration::from_secs(CHECK_INTERVAL_SECS));
        }
    });
}

/// Download and install the pending update, then relaunch.
pub fn install_update(app: tauri::AppHandle) {
    thread::spawn(move || {
        let result = tauri::async_runtime::block_on(async {
            let updater = app.updater_builder().build()?;
            if let Some(update) = updater.check().await? {
                update.download_and_install(|_, _| {}, || {}).await?;
            }
            Ok::<(), Box<dyn std::error::Error>>(())
        });

        if let Err(e) = result {
            eprintln!("Update failed: {e}");
        } else {
            // Relaunch after install
            tauri::process::restart(&app.env());
        }
    });
}
