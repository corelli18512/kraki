use tauri::{AppHandle, Emitter, Manager};
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
    run_sidecar_stdout(&app, &["connect", "--url-only"]).await
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

/// Tauri command: run headless setup via sidecar.
#[tauri::command]
pub async fn run_headless_setup(
    app: AppHandle,
    relay: String,
    auth_method: String,
    device_name: String,
    github_token: Option<String>,
) -> Result<String, String> {
    let mut args = vec![
        "setup".to_string(),
        "--headless".to_string(),
        "--relay".to_string(),
        relay,
        "--auth".to_string(),
        auth_method,
        "--device-name".to_string(),
        device_name,
    ];
    if let Some(token) = github_token {
        args.push("--github-token".to_string());
        args.push(token);
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_sidecar_stdout(&app, &arg_refs).await
}

/// Tauri command: get the relay URL (from env or default).
#[tauri::command]
pub fn get_relay_url() -> String {
    let url = std::env::var("KRAKI_RELAY_URL").unwrap_or_else(|_| "wss://kraki.corelli.cloud".to_string());
    eprintln!("[toolbar] relay URL: {url}");
    url
}

/// Tauri command: query relay capabilities via sidecar.
#[tauri::command]
pub async fn run_relay_info(app: AppHandle, url: String) -> Result<String, String> {
    run_sidecar_stdout(&app, &["relay-info", &url]).await
}

/// Tauri command: run doctor and return JSON.
#[tauri::command]
pub async fn run_doctor(app: AppHandle) -> Result<String, String> {
    run_sidecar_stdout(&app, &["doctor"]).await
}

/// Tauri command: check if config exists.
#[tauri::command]
pub fn is_configured() -> bool {
    crate::status::config_exists()
}

/// Start the sidecar daemon on app launch, or open setup if not configured.
/// Stops any stale daemon first to prevent orphan workers.
pub fn start_or_setup(app: &AppHandle) -> tauri::Result<()> {
    if !crate::status::config_exists() {
        open_setup_window(app);
        return Ok(());
    }
    // Stop any stale daemon before starting fresh
    let _ = tauri::async_runtime::block_on(stop_daemon_inner(app));
    let _ = tauri::async_runtime::block_on(start_daemon_inner(app));
    Ok(())
}

/// Open the setup window.
pub fn open_setup_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("setup") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Tauri command: trigger an on-demand update check via the updater plugin.
/// Returns the latest version string if an update is available, otherwise None.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Option<String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater_builder().build().ok()?;
    let update = updater.check().await.ok()??;
    let version = update.version.clone();
    let mut pending = crate::update::PENDING_UPDATE.lock().unwrap();
    *pending = Some(version.clone());
    drop(pending);
    let status = crate::status::read_status();
    crate::tray::update_tray(&app, &status);
    Some(version)
}

// TODO(phase-2): Replace device flow with OAuth redirect flow.
// Register kraki:// deep link, add redirect URI to GitHub OAuth app,
// relay already handles code exchange via github_oauth auth method.

/// Tauri command: start GitHub device auth flow via sidecar.
/// Emits "auth-update" events as JSON lines arrive from `kraki auth`.
/// Returns the final authenticated result or an error.
#[tauri::command]
pub async fn start_github_auth(app: AppHandle, client_id: String) -> Result<String, String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("kraki")
        .map_err(|e| e.to_string())?
        .args(["auth", "--client-id", &client_id])
        .spawn()
        .map_err(|e| e.to_string())?;

    use tauri_plugin_shell::process::CommandEvent;
    let mut last_line = String::new();
    let mut stderr = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let text = String::from_utf8_lossy(&bytes).to_string();
                for line in text.lines() {
                    let line = line.trim();
                    if !line.is_empty() {
                        let _ = app.emit("auth-update", line);
                        last_line = line.to_string();
                    }
                }
            }
            CommandEvent::Stderr(bytes) => stderr.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }

    if last_line.is_empty() {
        let stderr = stderr.trim().to_string();
        return Err(if stderr.is_empty() { "Auth process produced no output".to_string() } else { stderr });
    }
    Ok(last_line)
}

/// Run a sidecar command and capture stdout.
async fn run_sidecar_stdout(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("kraki")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    use tauri_plugin_shell::process::CommandEvent;
    let mut stdout = String::new();
    let mut stderr = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Stderr(bytes) => stderr.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }

    let stderr = stderr.trim().to_string();
    if !stderr.is_empty() && stdout.trim().is_empty() {
        return Err(stderr);
    }

    let stdout = stdout.trim().to_string();
    if stdout.is_empty() {
        return Err("No output from sidecar".to_string());
    }
    Ok(stdout)
}
