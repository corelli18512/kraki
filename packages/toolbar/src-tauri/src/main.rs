// Prevents additional console window on Windows in release mode
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod status;
mod tray;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostarted"]),
        ))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Hide the app from the macOS dock and Windows taskbar — tray only
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            tray::setup_tray(app)?;
            status::start_poller(app.handle().clone());
            commands::start_sidecar(app.handle())?;

            // Enable auto-start on first launch
            let autostart = app.autolaunch();
            if !autostart.is_enabled().unwrap_or(false) {
                let _ = autostart.enable();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_pairing_url,
            commands::start_daemon,
            commands::stop_daemon,
        ])
        .run(tauri::generate_context!())
        .expect("error running kraki toolbar");
}
