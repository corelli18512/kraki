use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// Invoke `kraki start` via the bundled sidecar.
pub async fn start_daemon_inner(app: &AppHandle) -> Result<(), String> {
    app.shell()
        .sidecar("kraki")
        .map_err(|e| e.to_string())?
        .args(["start"])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Invoke `kraki stop` via the bundled sidecar.
pub async fn stop_daemon_inner(app: &AppHandle) -> Result<(), String> {
    app.shell()
        .sidecar("kraki")
        .map_err(|e| e.to_string())?
        .args(["stop"])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Get the pairing URL by running `kraki connect --url-only` and capturing stdout.
#[tauri::command]
pub async fn get_pairing_url(app: AppHandle) -> Result<String, String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("kraki")
        .map_err(|e| e.to_string())?
        .args(["connect", "--url-only"])
        .spawn()
        .map_err(|e| e.to_string())?;

    use tauri_plugin_shell::process::CommandEvent;
    let mut url = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                url.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Stderr(bytes) => {
                let msg = String::from_utf8_lossy(&bytes).trim().to_string();
                if !msg.is_empty() {
                    return Err(msg);
                }
            }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }

    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("No pairing URL returned from daemon".to_string());
    }
    Ok(url)
}

/// Tauri command: start daemon.
#[tauri::command]
pub async fn start_daemon(app: AppHandle) -> Result<(), String> {
    start_daemon_inner(&app).await
}

/// Tauri command: stop daemon.
#[tauri::command]
pub async fn stop_daemon(app: AppHandle) -> Result<(), String> {
    stop_daemon_inner(&app).await
}

/// Start the sidecar daemon automatically on app launch if it isn't running.
pub fn start_sidecar(app: &AppHandle) -> tauri::Result<()> {
    let status = crate::status::read_status();
    if !status.daemon_running {
        let _ = tauri::async_runtime::block_on(start_daemon_inner(app));
    }
    Ok(())
}

/// Tauri command: trigger an on-demand update check.
/// Returns the latest version string if an update is available, otherwise None.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Option<String> {
    let current = env!("CARGO_PKG_VERSION");
    let latest = crate::update::fetch_latest_version()?;
    if crate::update::is_newer(&latest, current) {
        let mut pending = crate::update::PENDING_UPDATE.lock().unwrap();
        *pending = Some(latest.clone());
        drop(pending);
        let status = crate::status::read_status();
        crate::tray::update_tray(&app, &status);
        Some(latest)
    } else {
        None
    }
}
