mod commands;
mod models;

use commands::{catalog, dock, env, installer, lan_server, profile, proxy, tweaks};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};

fn fit_main_window_height(win: &WebviewWindow) {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let work = monitor.work_area();
        if let (Ok(inner), Ok(outer)) = (win.inner_size(), win.outer_size()) {
            let chrome_h = outer.height.saturating_sub(inner.height);
            let target_inner_h = work.size.height.saturating_sub(chrome_h).max(1);
            let x = work.position.x + ((work.size.width as i32 - outer.width as i32) / 2).max(0);
            let y = work.position.y;

            let _ = win.set_position(PhysicalPosition::new(x, y));
            let _ = win.set_size(PhysicalSize::new(inner.width, target_inner_h));

            let outer_w = win.outer_size().map(|s| s.width).unwrap_or(outer.width);
            let final_x =
                work.position.x + ((work.size.width as i32 - outer_w as i32) / 2).max(0);
            let _ = win.set_position(PhysicalPosition::new(final_x, y));
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn open_main_window(app: tauri::AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    lan_server::shutdown_if_running();
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                fit_main_window_height(&win);
                let _ = win.show();
                let _ = win.set_focus();
            }

            // Right-click context menu on tray icon
            let open_item = MenuItem::with_id(app, "open", "打开 Star Box", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 Star Box", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &sep, &quit_item])?;

            let mut builder = TrayIconBuilder::with_id("starbox-tray")
                .tooltip("Star Box — 点击打开主界面")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => {
                        lan_server::shutdown_if_running();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }

            let _ = builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_main_window,
            quit_app,
            env::get_env_status,
            env::set_brew_mirror,
            env::install_homebrew,
            env::cancel_homebrew_install,
            env::get_autostart_enabled,
            env::set_autostart_enabled,
            env::check_app_update,
            env::install_app_update,
            env::init_workspace_folders,
            catalog::search_brew_catalog,
            catalog::inspect_github_repo,
            catalog::fetch_featured_catalog,
            installer::scan_installed_apps,
            installer::install_app,
            installer::upgrade_app,
            installer::uninstall_app,
            installer::cancel_install_task,
            installer::open_installed_app,
            installer::discover_local_apps,
            dock::list_dock_backups,
            dock::apply_dock_layout,
            dock::restore_dock_backup,
            profile::load_profile,
            profile::save_profile,
            profile::reset_default_profile,
            profile::export_profile_to_path,
            profile::import_profile_from_path,
            profile::sync_profile_icloud,
            proxy::get_proxy_config,
            proxy::set_proxy_config,
            proxy::test_proxy,
            proxy::discover_lan_proxies,
            lan_server::get_lan_server_status,
            lan_server::start_lan_server,
            lan_server::stop_lan_server,
            lan_server::update_lan_server_config,
            lan_server::clear_lan_server_logs,
            lan_server::add_lan_note,
            lan_server::clear_lan_notes,
            lan_server::open_folder_in_finder,
            tweaks::get_mac_tweaks,
            tweaks::set_mac_tweak,
            tweaks::open_system_pane,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Star Box");
}
