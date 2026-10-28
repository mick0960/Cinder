//! 悬浮图标的显示 / 隐藏。
//!
//! 托盘菜单、全屏自动隐藏、重复启动都经过这里：监控面板随图标一起收起；
//! “显示”总会把图标拉到同层窗口的最上面——取消置顶后图标被别的窗口盖住时，只有这样才叫得回来。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

use crate::metrics;

pub const WIDGET_LABEL: &str = "widget";
pub const PANEL_LABEL: &str = "panel";

/// 图标是被“全屏自动隐藏”藏起来的。只有这种情况才会在全屏结束时自动恢复；
/// 用户自己从托盘隐藏的图标，全屏来去都保持隐藏。
static AUTO_HIDDEN: AtomicBool = AtomicBool::new(false);

/// 图标当前是否显示着。由下面的显示 / 隐藏函数维护，任意线程都能无阻塞地读取
/// （`is_visible` 要等主线程应答，指标线程、模块循环里不能用它）。
/// 篝火看不见时不必再为驱动它的模块和 GPU 采样取数——比如全屏游戏期间。
static SHOWN: AtomicBool = AtomicBool::new(true);

pub fn is_shown() -> bool {
    SHOWN.load(Ordering::Relaxed)
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(WIDGET_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// 用户操作：显示图标并拉到最上面（不激活，不抢键盘焦点）
pub fn show(app: &AppHandle) {
    AUTO_HIDDEN.store(false, Ordering::Relaxed);
    raise(app);
}

/// 用户操作：隐藏图标，面板一并收起
pub fn hide(app: &AppHandle) {
    AUTO_HIDDEN.store(false, Ordering::Relaxed);
    hide_window(app);
}

/// 进入全屏：图标正在显示才藏，并记下是自动藏的
pub fn hide_for_fullscreen(app: &AppHandle) {
    if is_visible(app) {
        hide_window(app);
        AUTO_HIDDEN.store(true, Ordering::Relaxed);
    }
}

/// 离开全屏：只恢复被自动隐藏的图标
pub fn restore_after_fullscreen(app: &AppHandle) {
    if AUTO_HIDDEN.swap(false, Ordering::Relaxed) {
        raise(app);
    }
}

/// 收起监控面板：隐藏面板窗口，指标恢复低频采样
pub fn close_panel(app: &AppHandle) {
    metrics::set_panel_open(app, false);
    let _ = app.emit_to(PANEL_LABEL, "panel://hide", ());
    if let Some(w) = app.get_webview_window(PANEL_LABEL) {
        let _ = w.hide();
    }
}

fn hide_window(app: &AppHandle) {
    if metrics::panel_open() {
        close_panel(app);
    }
    if let Some(w) = app.get_webview_window(WIDGET_LABEL) {
        let _ = w.hide();
    }
    SHOWN.store(false, Ordering::Relaxed);
    crate::modules::wake();
}

fn raise(app: &AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowPos, GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOPMOST,
    };
    const FLAGS: u32 = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;

    let Some(win) = app.get_webview_window(WIDGET_LABEL) else {
        return;
    };
    let _ = win.show();
    SHOWN.store(true, Ordering::Relaxed);
    crate::modules::wake();
    // 取消置顶后图标和普通窗口同层，show() 不会改变 z 序，得显式提到最上面
    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as _;
    unsafe {
        let on_top = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST != 0;
        // 先置顶、再按需取消，而不是只用 HWND_TOP：后者在没有用户输入时（如全屏结束后自动恢复）
        // 实测提不到别的窗口之上。两步都带 SWP_NOACTIVATE，不会激活窗口
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, FLAGS);
        if !on_top {
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, FLAGS);
        }
    }
}
