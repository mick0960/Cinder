//! 系统托盘。
//!
//! 取消“置顶”后篝火可能被别的窗口盖住，托盘是唤回它的可靠入口：
//! 左键单击 = 显示并拉到最上面；右键菜单：显示 / 隐藏 / 设置 / 退出；鼠标悬停显示当前 CPU 与内存。
//! 菜单事件由 lib.rs 里的全局菜单处理统一分发（与右键菜单共用 settings / exit）。

use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::metrics::MetricsSnapshot;
use crate::widget;

const ID: &str = "main";

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show_widget", "显示篝火")
        .text("hide_widget", "隐藏篝火")
        .separator()
        .text("settings", "设置...")
        .text("exit", "退出")
        .build()?;
    TrayIconBuilder::with_id(ID)
        .icon(Image::from_bytes(include_bytes!("../../assets/tray.png"))?)
        .tooltip("Cinder")
        .menu(&menu)
        // 左键留给“唤回篝火”，菜单只在右键弹出
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                widget::show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 更新悬停提示。由指标线程每个采样周期调用；文本没变就不刷新。
pub fn update_tooltip(app: &AppHandle, snap: &MetricsSnapshot) {
    static LAST: Mutex<String> = Mutex::new(String::new());

    let mem_pct = if snap.mem_total_mb > 0.0 {
        snap.mem_used_mb / snap.mem_total_mb * 100.0
    } else {
        0.0
    };
    let text = format!(
        "Cinder\nCPU {:.0}%\n内存 {:.0}%（{:.1} / {:.1} GB）",
        snap.cpu_percent,
        mem_pct,
        snap.mem_used_mb / 1024.0,
        snap.mem_total_mb / 1024.0,
    );
    {
        let mut last = LAST.lock().unwrap();
        if *last == text {
            return;
        }
        last.clone_from(&text);
    }
    // 托盘操作要在主线程执行；这里只投递，不让指标线程等主线程
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(tray) = handle.tray_by_id(ID) {
            let _ = tray.set_tooltip(Some(text));
        }
    });
}
