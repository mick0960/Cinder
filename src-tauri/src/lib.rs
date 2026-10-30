mod burn;
mod commands;
mod config;
mod dock;
mod fullscreen;
mod gpu;
mod idle;
mod memclean;
mod menu;
mod metrics;
mod modules;
mod tray;
mod updater;
mod widget;

use tauri::{Emitter, Manager};

pub const REPO_URL: &str = "https://github.com/mick0960/Cinder";

pub fn run() {
    tauri::Builder::default()
        // 单实例插件必须最先注册；重复启动 = 想找回篝火，把已有的悬浮窗显示出来并拉到最上面
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            widget::show(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
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
                // 文件拖到图标上即焚烧
                if let Ok(hwnd) = win.hwnd() {
                    let _ = burn::install(app.handle(), hwnd.0 as isize);
                }
            }

            // 托盘要先于指标线程建好：指标线程每个周期都会刷新它的悬停提示
            let _ = tray::init(app.handle());
            metrics::start(app.handle().clone());
            fullscreen::start(app.handle().clone());
            idle::start(app.handle().clone());
            dock::start(app.handle().clone());
            modules::start(app.handle().clone());
            app.manage(updater::UpdateState::default());
            updater::start(app.handle().clone());

            // 全局菜单事件：右键菜单和托盘菜单共用 settings / exit
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "exit" => app.exit(0),
                "settings" => {
                    let _ = menu::open_settings(app);
                }
                "show_widget" => widget::show(app),
                "hide_widget" => widget::hide(app),
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
                // 贴边缩进去时保存探出来的位置，而不是屏幕外的坐标
                let (x, y) = dock::docked_home().unwrap_or((p.x, p.y));
                config::set_window_pos(window.app_handle(), x, y);
                // 面板窗口跟随图标
                if metrics::panel_open() {
                    let _ = window.app_handle().emit_to("panel", "panel://anchor-moved", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_panel_open,
            commands::toggle_panel,
            commands::is_panel_open,
            commands::set_widget_rect,
            commands::popup_widget_menu,
            commands::open_settings,
            commands::save_modules,
            commands::module_click,
            commands::set_driver,
            commands::save_runners,
            commands::set_character,
            commands::test_module,
            commands::get_update_status,
            commands::check_update,
            commands::download_update,
            commands::install_update,
            commands::dismiss_update,
            commands::set_update_auto,
            commands::get_autostart,
            commands::set_autostart,
            commands::set_hide_on_fullscreen,
            commands::set_edge_hide,
            commands::set_idle_ember_minutes,
            commands::is_idle,
            commands::open_repo,
            commands::clean_memory,
            commands::burn_catch,
            commands::burn_state
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
