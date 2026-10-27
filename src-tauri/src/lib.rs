mod commands;
mod config;
mod menu;
mod metrics;
mod modules;
mod updater;

use tauri::Manager;

pub const REPO_URL: &str = "https://github.com/mick0960/Cinder";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let cfg = config::load_or_default(app.handle());
            app.manage(config::AppState(std::sync::RwLock::new(cfg)));

            if let Some(win) = app.get_webview_window("widget") {
                let (x, y) = {
                    let state = app.state::<config::AppState>();
                    let cfg = state.0.read().unwrap();
                    (cfg.window.x, cfg.window.y)
                };
                let (cx, cy) = clamp_to_screen(&win, x, y);
                let _ = win.set_position(tauri::PhysicalPosition::new(cx, cy));
                // Windows 创建窗口时会把宽度钳到系统最小值(~136)，这里显式收缩回 64
                let _ = win.set_size(tauri::LogicalSize::new(64.0, 64.0));
                // 悬浮窗不抢键盘焦点（WS_EX_NOACTIVATE）
                let _ = win.set_focusable(false);
                let _ = win.show();
            }

            metrics::start(app.handle().clone());
            modules::start(app.handle().clone());
            app.manage(updater::UpdateState::default());
            updater::start(app.handle().clone());

            app.on_menu_event(|app, event| match event.id().as_ref() {
                "exit" => app.exit(0),
                "settings" => {
                    let _ = menu::open_settings(app);
                }
                "toggle_top" => {
                    if let Some(w) = app.get_webview_window("widget") {
                        let cur = w.is_always_on_top().unwrap_or(true);
                        let _ = w.set_always_on_top(!cur);
                    }
                }
                id if id.starts_with("char:") => {
                    let ch = &id[5..];
                    config::set_character(app, ch);
                }
                _ => {}
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "widget" {
                return;
            }
            if let tauri::WindowEvent::Moved(p) = event {
                // 面板展开时窗口可能为避开屏幕边缘而偏移，此时的坐标不是猫的位置，
                // 收起后前端会把窗口放回猫的位置，届时再保存
                if !metrics::panel_open() {
                    config::set_window_pos(window.app_handle(), p.x, p.y);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_panel_open,
            commands::popup_widget_menu,
            commands::open_settings,
            commands::save_modules,
            commands::save_runners,
            commands::set_character,
            commands::test_module,
            commands::get_update_status,
            commands::check_update,
            commands::download_update,
            commands::install_update,
            commands::dismiss_update,
            commands::set_update_auto,
            commands::open_repo
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cinder");
}

/// 把保存的位置限制在某个显示器内。
/// 多显示器时坐标可能为负或位于副屏，需按各显示器的实际矩形判断，
/// 而不是只按主屏尺寸从 (0,0) 起算。
fn clamp_to_screen(
    win: &tauri::WebviewWindow,
    x: i32,
    y: i32,
) -> (i32, i32) {
    const SIZE: i32 = 64;
    let monitors = win.available_monitors().unwrap_or_default();
    let rect = |m: &tauri::Monitor| {
        let p = m.position();
        let s = m.size();
        (p.x, p.y, s.width as i32, s.height as i32)
    };
    // 猫的中心点落在哪个显示器上，就限制在哪个显示器内
    let (cx, cy) = (x + SIZE / 2, y + SIZE / 2);
    if let Some((mx, my, mw, mh)) = monitors.iter().map(rect).find(|&(mx, my, mw, mh)| {
        cx >= mx && cx < mx + mw && cy >= my && cy < my + mh
    }) {
        return (
            x.clamp(mx, (mx + mw - SIZE).max(mx)),
            y.clamp(my, (my + mh - SIZE).max(my)),
        );
    }
    // 原显示器已不存在（拔掉了副屏等）：放回主屏左上角附近
    let (mx, my) = win
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
        .map(|m| (m.position().x, m.position().y))
        .unwrap_or((0, 0));
    (mx + 100, my + 100)
}
