//! 用户离开时篝火变成余烬：用 GetLastInputInfo 取得最后一次键盘 / 鼠标输入的时间，
//! 超过设定时长就通知前端切换成余烬，一有操作立刻恢复。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

use crate::config;

const POLL: Duration = Duration::from_secs(1);

static IDLE: AtomicBool = AtomicBool::new(false);

pub fn is_idle() -> bool {
    IDLE.load(Ordering::Relaxed)
}

/// 距离最后一次输入过去了多久；查询失败时按“刚刚有过操作”处理，宁可不变余烬
fn idle_for() -> Duration {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return Duration::ZERO;
    }
    // 两者都是 32 位毫秒计数，约 49 天回绕一次，用回绕减法
    let ms = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
    Duration::from_millis(ms as u64)
}

/// 每秒检查一次，只在状态变化时通知前端。时长设为 0 表示关闭，已进入的余烬状态随之恢复。
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        let minutes = app.state::<config::AppState>().0.read().unwrap().idle_ember_minutes;
        let now = minutes > 0 && idle_for() >= Duration::from_secs(minutes as u64 * 60);
        if IDLE.swap(now, Ordering::Relaxed) != now {
            let _ = app.emit_to(crate::widget::WIDGET_LABEL, "idle://changed", now);
        }
        std::thread::sleep(POLL);
    });
}
