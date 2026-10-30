//! 贴边隐藏：图标被拖到屏幕边缘并停住后，缩进去一半；鼠标靠近时探出来，离开后再缩回去。
//!
//! 全程由一个轮询线程驱动（鼠标是否靠近没有可用的窗口事件——图标缩进去后只剩一半在屏幕里）：
//! - 未停靠：图标贴着某条屏幕边缘、左键松开、且位置稳定一小段时间，就停靠到那条边。
//! - 已停靠：鼠标进入图标范围就探出来；离开后（监控面板没开、没在拖动）延迟缩回。
//! - 停靠时图标位置与预期不符，说明用户拖走了它，取消停靠。
//!
//! 缩进去的那一半不一定在屏幕外：与别的显示器相邻的边上，它会落到隔壁屏幕里。
//! 所以每次移动都用窗口区域（SetWindowRgn）把窗口裁剪到所在显示器内，裁掉的部分既看不见也点不到。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    CreateRectRgn, GetMonitorInfoW, MonitorFromWindow, SetWindowRgn, MONITORINFO,
    MONITOR_DEFAULTTONEAREST,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
};

use crate::{config, metrics, widget};

const POLL: Duration = Duration::from_millis(50);
/// 距屏幕边缘多近算“贴边”（物理像素）
const SNAP: i32 = 16;
/// 位置稳定多久才停靠：拖动过程中路过边缘不算
const SETTLE: Duration = Duration::from_millis(400);
/// 鼠标离开多久后缩回去
const LEAVE_DELAY: Duration = Duration::from_millis(500);
/// 鼠标离开图标多远才算“离开”
const LEAVE_MARGIN: i32 = 12;
const ANIM_STEPS: i32 = 8;
const ANIM_FRAME: Duration = Duration::from_millis(14);

#[derive(Clone, Copy, PartialEq)]
enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone, Copy)]
struct Docked {
    edge: Edge,
    /// 完全探出来时的位置
    home: (i32, i32),
    peeked: bool,
    /// 停靠所在显示器的矩形，窗口始终被裁剪在它之内
    mon: RECT,
}

impl Docked {
    /// 缩进去一半时的位置
    fn hidden_pos(&self, w: i32, h: i32) -> (i32, i32) {
        let (x, y) = self.home;
        match self.edge {
            Edge::Left => (x - w / 2, y),
            Edge::Right => (x + w / 2, y),
            Edge::Top => (x, y - h / 2),
            Edge::Bottom => (x, y + h / 2),
        }
    }

    fn pos(&self, w: i32, h: i32) -> (i32, i32) {
        if self.peeked {
            self.home
        } else {
            self.hidden_pos(w, h)
        }
    }
}

/// 当前停靠的“探出来”位置。窗口位移事件保存配置时用它代替缩进去的屏幕外坐标——
/// 否则下次启动时位置会被判成不在任何显示器上。
static HOME: Mutex<Option<(i32, i32)>> = Mutex::new(None);

pub fn docked_home() -> Option<(i32, i32)> {
    *HOME.lock().unwrap()
}

fn set_home(home: Option<(i32, i32)>) {
    *HOME.lock().unwrap() = home;
}

fn window_rect(hwnd: isize) -> Option<RECT> {
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    (unsafe { GetWindowRect(hwnd as _, &mut r) } != 0).then_some(r)
}

fn monitor_rect(hwnd: isize) -> Option<RECT> {
    let mut mi: MONITORINFO = unsafe { std::mem::zeroed() };
    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    let mon = unsafe { MonitorFromWindow(hwnd as _, MONITOR_DEFAULTTONEAREST) };
    (unsafe { GetMonitorInfoW(mon, &mut mi) } != 0).then_some(mi.rcMonitor)
}

/// 把窗口裁剪到显示器矩形内（窗口左上角在 x, y，大小 w × h）；完全在内部时取消裁剪
fn clip(hwnd: isize, x: i32, y: i32, w: i32, h: i32, mon: &RECT) {
    let (l, t) = (x.max(mon.left), y.max(mon.top));
    let (rt, b) = ((x + w).min(mon.right), (y + h).min(mon.bottom));
    unsafe {
        if l <= x && t <= y && rt >= x + w && b >= y + h {
            unclip(hwnd);
        } else {
            // 区域坐标相对窗口左上角；区域的所有权随调用转给系统
            SetWindowRgn(hwnd as _, CreateRectRgn(l - x, t - y, (rt - l).max(0) + l - x, (b - t).max(0) + t - y), 1);
        }
    }
}

fn unclip(hwnd: isize) {
    unsafe {
        SetWindowRgn(hwnd as _, std::ptr::null_mut(), 1);
    }
}

fn move_to(hwnd: isize, x: i32, y: i32, mon: &RECT) {
    if let Some(r) = window_rect(hwnd) {
        clip(hwnd, x, y, r.right - r.left, r.bottom - r.top, mon);
    }
    unsafe {
        SetWindowPos(hwnd as _, std::ptr::null_mut(), x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

fn animate(hwnd: isize, from: (i32, i32), to: (i32, i32), mon: &RECT) {
    for i in 1..=ANIM_STEPS {
        let t = i as f32 / ANIM_STEPS as f32;
        let e = 1.0 - (1.0 - t).powi(3); // ease-out
        let x = from.0 + ((to.0 - from.0) as f32 * e).round() as i32;
        let y = from.1 + ((to.1 - from.1) as f32 * e).round() as i32;
        move_to(hwnd, x, y, mon);
        std::thread::sleep(ANIM_FRAME);
    }
    move_to(hwnd, to.0, to.1, mon);
}

fn cursor() -> Option<POINT> {
    let mut p = POINT { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut p) } != 0).then_some(p)
}

fn button_down() -> bool {
    (unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16 & 0x8000) != 0
}

/// 贴着哪条屏幕边缘，并返回贴齐边缘后的位置
fn snap_target(r: &RECT, m: &RECT) -> Option<Docked> {
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    let candidates = [
        (r.left - m.left, Edge::Left, (m.left, r.top)),
        (m.right - r.right, Edge::Right, (m.right - w, r.top)),
        (r.top - m.top, Edge::Top, (r.left, m.top)),
        (m.bottom - r.bottom, Edge::Bottom, (r.left, m.bottom - h)),
    ];
    candidates
        .into_iter()
        .filter(|&(dist, ..)| dist <= SNAP)
        .min_by_key(|&(dist, ..)| dist)
        .map(|(_, edge, home)| Docked { edge, home, peeked: true, mon: *m })
}

fn near(p: POINT, x: i32, y: i32, w: i32, h: i32, margin: i32) -> bool {
    p.x >= x - margin && p.x < x + w + margin && p.y >= y - margin && p.y < y + h + margin
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut docked: Option<Docked> = None;
        let mut last_pos: Option<(i32, i32)> = None;
        let mut stable_since = Instant::now();
        let mut left_at: Option<Instant> = None;

        loop {
            std::thread::sleep(POLL);
            let enabled = app.state::<config::AppState>().0.read().unwrap().edge_hide;
            let Some(win) = app.get_webview_window(widget::WIDGET_LABEL) else { continue };
            let Ok(hwnd) = win.hwnd() else { continue };
            let hwnd = hwnd.0 as isize;
            let Some(r) = window_rect(hwnd) else { continue };
            let (w, h) = (r.right - r.left, r.bottom - r.top);

            if let Some(mut d) = docked {
                // 关闭选项：探出来并取消停靠
                if !enabled {
                    if !d.peeked {
                        animate(hwnd, (r.left, r.top), d.home, &d.mon);
                    }
                    clip(hwnd, d.home.0, d.home.1, w, h, &d.mon);
                    docked = None;
                    set_home(None);
                    last_pos = None;
                    continue;
                }
                // 位置和预期不符：用户把它拖走了
                let expected = d.pos(w, h);
                if (r.left - expected.0).abs() > 2 || (r.top - expected.1).abs() > 2 {
                    // 彻底取消裁剪：拖动中的图标可能已经到了别的显示器，不能再按原显示器裁
                    unclip(hwnd);
                    docked = None;
                    set_home(None);
                    last_pos = None;
                    continue;
                }
                let Some(c) = cursor() else { continue };
                if near(c, expected.0, expected.1, w, h, 0) {
                    left_at = None;
                    if !d.peeked {
                        animate(hwnd, expected, d.home, &d.mon);
                        d.peeked = true;
                        docked = Some(d);
                    }
                } else if d.peeked {
                    let busy = metrics::panel_open()
                        || button_down()
                        || near(c, d.home.0, d.home.1, w, h, LEAVE_MARGIN);
                    if busy {
                        left_at = None;
                    } else if left_at.get_or_insert_with(Instant::now).elapsed() >= LEAVE_DELAY {
                        animate(hwnd, d.home, d.hidden_pos(w, h), &d.mon);
                        d.peeked = false;
                        docked = Some(d);
                        left_at = None;
                    }
                }
                continue;
            }

            // 未停靠：等位置稳定下来再判断是否贴边
            if !enabled || !widget::is_shown() || button_down() {
                last_pos = None;
                continue;
            }
            if last_pos != Some((r.left, r.top)) {
                last_pos = Some((r.left, r.top));
                stable_since = Instant::now();
                continue;
            }
            if stable_since.elapsed() < SETTLE {
                continue;
            }
            let Some(m) = monitor_rect(hwnd) else { continue };
            if let Some(d) = snap_target(&r, &m) {
                // 先贴齐边缘并记下位置；缩进去由上面的“已停靠”分支在鼠标离开后完成
                animate(hwnd, (r.left, r.top), d.home, &d.mon);
                set_home(Some(d.home));
                docked = Some(d);
                left_at = None;
            }
        }
    });
}
