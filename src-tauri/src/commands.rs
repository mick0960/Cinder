use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_autostart::ManagerExt;

use crate::burn;
use crate::config::{self, AppState, ModuleConfig, RunnerConfig};
use crate::memclean;
use crate::menu;
use crate::metrics;
use crate::modules;
use crate::updater::{self, UpdateStatus};
use crate::widget::{self, PANEL_LABEL};

#[tauri::command]
pub fn get_config(state: State<AppState>) -> config::AppConfig {
    state.0.read().unwrap().clone()
}

/// 一次性设置调用方窗口的位置和大小（物理像素），避免 setSize / setPosition 分步造成中间帧。
#[tauri::command]
pub fn set_widget_rect(window: Window, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
        };
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let ok = unsafe {
            SetWindowPos(hwnd.0 as _, std::ptr::null_mut(), x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE)
        };
        if ok == 0 {
            return Err("SetWindowPos failed".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        window
            .set_size(tauri::PhysicalSize::new(w as u32, h as u32))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())
    }
}

/// 监控面板是独立窗口：悬浮图标窗口永远不改变大小和位置，点击时图标不会闪动或偏移。
///
/// 必须是 async：同步命令跑在主线程上，Windows 下在其中创建窗口会死锁（整个应用无响应）。
#[tauri::command]
pub async fn toggle_panel(app: AppHandle) -> Result<(), String> {
    if metrics::panel_open() {
        widget::close_panel(&app);
        return Ok(());
    }
    metrics::set_panel_open(&app, true);
    if app.get_webview_window(PANEL_LABEL).is_some() {
        let _ = app.emit_to(PANEL_LABEL, "panel://show", ());
        return Ok(());
    }
    // 窗口先隐藏创建，由面板前端排好版、定位后再显示；新窗口挂载时自行读取 is_panel_open
    let win = tauri::WebviewWindowBuilder::new(
        &app,
        PANEL_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Cinder 面板")
    .inner_size(256.0, 64.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    // 必须与其他窗口的 WebView2 启动参数一致，见 menu::open_settings
    .additional_browser_args(crate::menu::WEBVIEW_ARGS)
    .build()
    .map_err(|e| e.to_string())?;
    let _ = win.set_focusable(false);
    Ok(())
}

#[tauri::command]
pub fn is_panel_open() -> bool {
    metrics::panel_open()
}

#[tauri::command]
pub fn set_panel_open(app: AppHandle, open: bool) {
    metrics::set_panel_open(&app, open);
}

#[tauri::command]
pub fn popup_widget_menu(app: AppHandle, window: Window) -> Result<(), String> {
    menu::popup(&app, window).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = menu::open_settings(&handle);
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_modules(app: AppHandle, modules: Vec<ModuleConfig>) -> Result<(), String> {
    config::set_modules(&app, modules.clone());
    modules::reload(&app);
    // 通知悬浮窗刷新模块列表，无需重启
    let _ = app.emit_to("widget", "config://modules", &modules);
    Ok(())
}

#[tauri::command]
pub fn save_runners(app: AppHandle, runners: Vec<RunnerConfig>) -> Result<(), String> {
    config::set_runners(&app, runners.clone());
    let current = app.state::<AppState>().0.read().unwrap().character.clone();
    let _ = app.emit("config://runners", &runners);
    let _ = app.emit("character://changed", current);
    Ok(())
}

#[tauri::command]
pub fn set_character(app: AppHandle, character: String) {
    config::set_character(&app, &character);
}

#[tauri::command]
pub async fn test_module(cfg: ModuleConfig) -> Result<serde_json::Value, String> {
    Ok(modules::test(&cfg).await)
}

/// 枚举并裁剪几百个进程可能耗时数百毫秒，放到阻塞线程池里，不占主线程
#[tauri::command]
pub async fn clean_memory() -> Result<memclean::CleanResult, String> {
    tauri::async_runtime::spawn_blocking(memclean::clean)
        .await
        .map_err(|e| e.to_string())?
}

/// 图标网页收到文件 dragenter：盖上原生接手窗，由它拿到文件路径并开始焚烧（见 burn/catcher.rs）
#[tauri::command]
pub fn burn_catch(app: AppHandle) {
    burn::catch(&app);
}

#[tauri::command]
pub fn burn_state() -> Option<burn::Snapshot> {
    burn::snapshot()
}

#[tauri::command]
pub fn get_update_status(app: AppHandle) -> UpdateStatus {
    updater::status(&app)
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> UpdateStatus {
    updater::check(&app, true).await
}

#[tauri::command]
pub async fn download_update(app: AppHandle) -> UpdateStatus {
    updater::download(&app).await
}

#[tauri::command]
pub fn install_update(app: AppHandle) -> Result<(), String> {
    updater::install(&app)
}

#[tauri::command]
pub fn dismiss_update(app: AppHandle) {
    updater::dismiss(&app);
}

#[tauri::command]
pub fn set_update_auto(app: AppHandle, auto: bool) {
    config::set_update(&app, |u| u.auto = auto);
}

/// 开机自启以系统里的实际状态为准：用户可能在任务管理器的“启动应用”里把它关掉了
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launch = app.autolaunch();
    let result = if enabled { launch.enable() } else { launch.disable() };
    result.map_err(|e| e.to_string())?;
    // 写完回读一次：启动项还留在别处（比如以管理员身份写进 HKLM 的）时，不能谎称已经关闭
    if launch.is_enabled().map_err(|e| e.to_string())? != enabled {
        return Err(if enabled {
            "未能开启开机自启".into()
        } else {
            "未能关闭：启动项由管理员权限创建，请以管理员身份运行 Cinder 后再关闭".into()
        });
    }
    Ok(())
}

#[tauri::command]
pub fn set_hide_on_fullscreen(app: AppHandle, enabled: bool) {
    config::set_hide_on_fullscreen(&app, enabled);
}

#[tauri::command]
pub fn open_repo() {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", crate::REPO_URL])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn();
}
