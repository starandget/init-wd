mod commands;
mod models;

use commands::{catalog, dock, env, installer, profile, proxy, tweaks};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(pop) = app.get_webview_window("tray-popover") {
        let _ = pop.hide();
    }
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
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Create hidden macOS menu-bar popover window
            let popover = WebviewWindowBuilder::new(
                app,
                "tray-popover",
                WebviewUrl::App("index.html#tray".into()),
            )
            .title("Star Box Clock")
            .inner_size(340.0, 326.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()?;

            let pop_for_blur = popover.clone();
            popover.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let _ = pop_for_blur.hide();
                }
            });

            // Right-click context menu on tray icon
            let open_item = MenuItem::with_id(app, "open", "打开 Star Box", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 Star Box", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &sep, &quit_item])?;

            let mut builder = TrayIconBuilder::with_id("starbox-tray")
                .tooltip("Star Box — 点击查看世界时间")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(pop) = app.get_webview_window("tray-popover") {
                            if pop.is_visible().unwrap_or(false) {
                                let _ = pop.hide();
                                return;
                            }

                            let scale = pop.scale_factor().unwrap_or(2.0);
                            let tray_pos = rect.position.to_physical::<f64>(scale);
                            let tray_size = rect.size.to_physical::<f64>(scale);
                            let pop_size = pop
                                .outer_size()
                                .unwrap_or(tauri::PhysicalSize::new(
                                    (340.0 * scale) as u32,
                                    (326.0 * scale) as u32,
                                ));

                            let mut x = tray_pos.x + (tray_size.width / 2.0)
                                - (pop_size.width as f64 / 2.0);
                            let y = tray_pos.y + tray_size.height + (6.0 * scale);

                            // Keep popover cleanly inside monitor right edge
                            if let Ok(Some(monitor)) = pop.current_monitor() {
                                let m_pos = monitor.position();
                                let m_size = monitor.size();
                                let max_x = (m_pos.x + m_size.width as i32) as f64
                                    - pop_size.width as f64
                                    - (8.0 * scale);
                                let min_x = m_pos.x as f64 + (8.0 * scale);
                                x = x.clamp(min_x, max_x.max(min_x));
                            }

                            let _ = pop.set_position(PhysicalPosition::new(x as i32, y as i32));
                            let _ = pop.show();
                            let _ = pop.set_focus();
                        }
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
            tweaks::get_mac_tweaks,
            tweaks::set_mac_tweak,
            tweaks::open_system_pane,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Star Box");
}
