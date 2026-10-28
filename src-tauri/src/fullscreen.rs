//! 全屏时自动隐藏：置顶的篝火在玩游戏、看视频、演示时会挡住画面。
//!
//! 用 SHQueryUserNotificationState 判断——它与任务栏判断“有全屏程序，该让路了”是同一个信号，
//! 涵盖全屏应用、D3D 独占全屏、演示模式和全屏的商店应用。
//! 该状态是全局的，不区分显示器：副屏上有全屏程序时，主屏的篝火也会隐藏。

use std::time::Duration;

use tauri::{AppHandle, Manager};
use windows_sys::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE, QUNS_APP, QUNS_BUSY,
    QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};

use crate::config;
use crate::widget;

const POLL: Duration = Duration::from_secs(1);

fn is_fullscreen() -> bool {
    let mut state: QUERY_USER_NOTIFICATION_STATE = 0;
    // 查询失败时按“没有全屏”处理：宁可多显示，也不要把图标藏起来
    if unsafe { SHQueryUserNotificationState(&mut state) } < 0 {
        return false;
    }
    // QUNS_BUSY：全屏程序或演示设置；其余状态（离开座位、安静时间等）与全屏无关
    matches!(state, QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE | QUNS_APP)
}

/// 每秒检查一次，只在状态变化时动作：用户在全屏期间手动显示了图标，就不会再被反复藏起来。
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut was = false;
        loop {
            let enabled = app.state::<config::AppState>().0.read().unwrap().hide_on_fullscreen;
            // 关闭选项等同于“全屏结束”，已被自动隐藏的图标会随之恢复
            let now = enabled && is_fullscreen();
            if now != was {
                was = now;
                if now {
                    widget::hide_for_fullscreen(&app);
                } else {
                    widget::restore_after_fullscreen(&app);
                }
            }
            std::thread::sleep(POLL);
        }
    });
}
