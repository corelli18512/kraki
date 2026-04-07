#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod status;
mod tray;
mod update;

use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostarted"]),
        ))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            tray::setup_tray(app)?;
            status::start_poller(app.handle().clone());
            update::start_checker(app.handle().clone());
            commands::start_or_setup(app.handle())?;

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
            commands::check_for_updates,
            commands::run_headless_setup,
            commands::run_doctor,
            commands::is_configured,
            commands::start_github_auth,
        ])
        .run(tauri::generate_context!())
        .expect("error running kraki toolbar");
}
