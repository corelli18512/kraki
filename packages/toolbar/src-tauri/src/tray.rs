use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Manager,
};

use crate::status::DaemonStatus;

const ICON_CONNECTED: &[u8] = include_bytes!("../icons/tray-connected.png");
const ICON_CONNECTING: &[u8] = include_bytes!("../icons/tray-connecting.png");
const ICON_DISCONNECTED: &[u8] = include_bytes!("../icons/tray-disconnected.png");

/// Return the display version. In dev builds, use the tentacle version
/// injected by build.rs; in release builds, use CARGO_PKG_VERSION.
pub fn effective_version() -> &'static str {
    let v = env!("CARGO_PKG_VERSION");
    if v.contains("dev") {
        option_env!("KRAKI_DEV_VERSION").unwrap_or(v)
    } else {
        v
    }
}

pub fn setup_tray(app: &mut App) -> tauri::Result<()> {
    let handle = app.handle();
    let menu = build_menu(handle, &DaemonStatus::default(), None)?;
    let icon = Image::from_bytes(ICON_DISCONNECTED)?;

    TrayIconBuilder::with_id("kraki-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Kraki")
        .menu(&menu)
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .build(app)?;

    Ok(())
}

fn build_menu(
    app: &AppHandle,
    status: &DaemonStatus,
    pending_update: Option<&str>,
) -> tauri::Result<Menu<tauri::Wry>> {
    let version = effective_version();
    let toggle_label = if status.daemon_running && status.relay_state == "connected" {
        "Disconnect"
    } else {
        "Connect"
    };

    let toggle = MenuItem::with_id(app, "toggle", toggle_label, true, None::<&str>)?;
    let pair = MenuItem::with_id(app, "pair", "Pair new device\u{2026}", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let version_item = MenuItem::with_id(app, "header", format!("Kraki v{version}"), false, None::<&str>)?;
    let check_updates = MenuItem::with_id(app, "check_updates", "Check for updates\u{2026}", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit Kraki"))?;

    if let Some(ver) = pending_update {
        let update_item = MenuItem::with_id(
            app,
            "do_update",
            format!("\u{2b06}  Update available: v{ver}"),
            true,
            None::<&str>,
        )?;
        Menu::with_items(
            app,
            &[
                &toggle,
                &pair,
                &sep1,
                &version_item,
                &update_item,
                &sep2,
                &quit,
            ],
        )
    } else {
        Menu::with_items(
            app,
            &[
                &toggle,
                &pair,
                &sep1,
                &version_item,
                &check_updates,
                &sep2,
                &quit,
            ],
        )
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "toggle" => {
            let status = crate::status::read_status();
            if status.daemon_running && status.relay_state == "connected" {
                let _ = tauri::async_runtime::block_on(crate::commands::stop_daemon_inner(app));
            } else {
                let _ = tauri::async_runtime::block_on(crate::commands::start_daemon_inner(app));
            }
        }
        "pair" => open_qr_window(app),
        "do_update" | "check_updates" => {
            let is_check = id == "check_updates";
            let app = app.clone();
            if is_check {
                // Immediately show "Checking…" in the menu for next open
                set_check_updates_label(&app, "Checking for updates…");
            }
            std::thread::spawn(move || {
                if is_check {
                    let current = effective_version();
                    if let Some(latest) = crate::update::fetch_latest_version() {
                        if crate::update::is_newer(&latest, current) {
                            let mut pending = crate::update::PENDING_UPDATE.lock().unwrap();
                            *pending = Some(latest);
                            drop(pending);
                        }
                    }
                    // Rebuild menu (shows update banner or resets to "Check for updates…")
                    let status = crate::status::read_status();
                    update_tray(&app, &status);
                } else {
                    crate::update::open_releases_page();
                }
            });
        }
        _ => {}
    }
}

fn open_qr_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("qr") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn set_check_updates_label(app: &AppHandle, label: &str) {
    let Some(tray) = app.tray_by_id("kraki-tray") else { return; };
    let status = crate::status::read_status();
    let version = effective_version();
    let toggle_label = if status.daemon_running && status.relay_state == "connected" {
        "Disconnect"
    } else {
        "Connect"
    };

    // Rebuild menu with custom check_updates label (disabled)
    if let Ok(menu) = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "toggle", toggle_label, true, None::<&str>).unwrap(),
            &MenuItem::with_id(app, "pair", "Pair new device\u{2026}", true, None::<&str>).unwrap(),
            &PredefinedMenuItem::separator(app).unwrap(),
            &MenuItem::with_id(app, "header", format!("Kraki v{version}"), false, None::<&str>).unwrap(),
            &MenuItem::with_id(app, "check_updates", label, false, None::<&str>).unwrap(),
            &PredefinedMenuItem::separator(app).unwrap(),
            &PredefinedMenuItem::quit(app, Some("Quit Kraki")).unwrap(),
        ],
    ) {
        let _ = tray.set_menu(Some(menu));
    }
}

pub fn update_tray(app: &AppHandle, status: &DaemonStatus) {
    let Some(tray) = app.tray_by_id("kraki-tray") else {
        return;
    };

    let pending = crate::update::PENDING_UPDATE.lock().unwrap();
    let pending_version = pending.as_deref();

    let icon_bytes = match status.relay_state.as_str() {
        "connected" => ICON_CONNECTED,
        "connecting" | "authenticating" => ICON_CONNECTING,
        _ => ICON_DISCONNECTED,
    };
    if let Ok(icon) = Image::from_bytes(icon_bytes) {
        let _ = tray.set_icon(Some(icon));
    }

    if let Ok(menu) = build_menu(app, status, pending_version) {
        let _ = tray.set_menu(Some(menu));
    }

    let tip = match (pending_version, status.relay_state.as_str()) {
        (Some(v), _) => format!("Kraki — Update available: v{v}"),
        (None, "connected") => "Kraki \u{2014} Connected".to_string(),
        (None, "connecting") | (None, "authenticating") => "Kraki \u{2014} Connecting\u{2026}".to_string(),
        _ => "Kraki \u{2014} Disconnected".to_string(),
    };
    let _ = tray.set_tooltip(Some(&tip));
}
