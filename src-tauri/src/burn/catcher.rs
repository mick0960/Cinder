//! 接住拖到图标上的文件。
//!
//! 光标下方是 WebView2 浏览器进程的子窗口，OLE 拖放找不到我们进程里注册的拖放目标——
//! Tauri 自带的拖放处理（onDragDropEvent）在图标上只会显示禁止光标，事件也不触发；
//! 而网页自己的拖放事件拿不到文件路径。所以图标窗口关掉了 Tauri 的拖放处理
//! （tauri.conf.json 中 dragDropEnabled: false），让 WebView2 照常把 dragenter 交给网页，
//! 网页再调用 `burn_catch`：这里把一个几乎全透明、注册了我们自己拖放目标的原生“接手窗”
//! 盖到图标上，光标一动 OLE 就把拖放交给它，DragEnter 里即可拿到路径。拖放结束立刻收起，不影响点击图标。

use std::cell::Cell;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::time::Duration;

use tauri::AppHandle;
use windows::core::{implement, w, Ref, Result};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINTL, RECT, WPARAM};
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, CF_HDROP, DROPEFFECT,
    DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetWindowRect, IsWindowVisible, RegisterClassW,
    SetLayeredWindowAttributes, SetWindowPos, ShowWindow, ShowWindowAsync, HWND_TOPMOST,
    LWA_ALPHA, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, WNDCLASSW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

static WIDGET: AtomicIsize = AtomicIsize::new(0);
static CATCHER: AtomicIsize = AtomicIsize::new(0);
/// 接手窗显示期间的看门狗是否在运行
static WATCHING: AtomicBool = AtomicBool::new(false);
/// 拖放目标已收到 DragEnter、尚未离开 / 放下
static INSIDE: AtomicBool = AtomicBool::new(false);

#[implement(IDropTarget)]
struct Target {
    app: AppHandle,
    effect: Cell<DROPEFFECT>,
}

impl IDropTarget_Impl for Target_Impl {
    fn DragEnter(
        &self,
        data: Ref<'_, IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> Result<()> {
        let paths = data.as_ref().map(read_paths).unwrap_or_default();
        let e = if paths.is_empty() { DROPEFFECT_NONE } else { DROPEFFECT_COPY };
        self.effect.set(e);
        unsafe { *effect = e };
        INSIDE.store(true, Ordering::Relaxed);
        if !paths.is_empty() {
            super::begin(&self.app, paths);
        }
        Ok(())
    }

    fn DragOver(&self, _keys: MODIFIERKEYS_FLAGS, _pt: &POINTL, effect: *mut DROPEFFECT) -> Result<()> {
        unsafe { *effect = self.effect.get() };
        Ok(())
    }

    fn DragLeave(&self) -> Result<()> {
        self.finish();
        Ok(())
    }

    fn Drop(
        &self,
        _data: Ref<'_, IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> Result<()> {
        // 松手即取消；满 4 秒后的松手只是空操作。返回“复制”，资源管理器不会对源文件做任何事
        unsafe { *effect = self.effect.get() };
        self.finish();
        Ok(())
    }
}

impl Target_Impl {
    fn finish(&self) {
        INSIDE.store(false, Ordering::Relaxed);
        super::cancel(&self.app);
        hide();
    }
}

fn read_paths(data: &IDataObject) -> Vec<PathBuf> {
    let fmt = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    // 拖的不是文件（文字、链接等）时没有 CF_HDROP
    let Ok(mut medium) = (unsafe { data.GetData(&fmt) }) else {
        return Vec::new();
    };
    let hdrop = HDROP(unsafe { medium.u.hGlobal.0 });
    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) };
    let paths = (0..count)
        .map(|i| {
            let len = unsafe { DragQueryFileW(hdrop, i, None) } as usize;
            let mut buf = vec![0u16; len + 1];
            unsafe { DragQueryFileW(hdrop, i, Some(&mut buf)) };
            PathBuf::from(OsString::from_wide(&buf[..len]))
        })
        .collect();
    unsafe { ReleaseStgMedium(&mut medium) };
    paths
}

unsafe extern "system" fn catcher_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// 创建接手窗并注册拖放目标。必须在主线程调用（拖放回调会在注册线程上执行）。
pub fn install(app: &AppHandle, widget: isize) -> Result<()> {
    WIDGET.store(widget, Ordering::Relaxed);
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(catcher_proc),
            hInstance: instance.into(),
            lpszClassName: w!("CinderDropCatcher"),
            ..Default::default()
        };
        RegisterClassW(&class);
        // 属于图标窗口（owner），z 序始终在它上面；alpha=1 肉眼不可见，但仍能被命中测试
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
            w!("CinderDropCatcher"),
            w!(""),
            WS_POPUP,
            0,
            0,
            1,
            1,
            Some(HWND(widget as _)),
            None,
            Some(instance.into()),
            None,
        )?;
        SetLayeredWindowAttributes(hwnd, Default::default(), 1, LWA_ALPHA)?;
        let target: IDropTarget = Target { app: app.clone(), effect: Cell::new(DROPEFFECT_NONE) }.into();
        RegisterDragDrop(hwnd, &target)?;
        CATCHER.store(hwnd.0 as isize, Ordering::Relaxed);
    }
    Ok(())
}

/// 网页收到文件 dragenter：把接手窗盖到图标上，让 OLE 改把拖放交给我们
pub fn show(app: &AppHandle) {
    let (catcher, widget) = (CATCHER.load(Ordering::Relaxed), WIDGET.load(Ordering::Relaxed));
    if catcher == 0 || widget == 0 {
        return;
    }
    let mut r = RECT::default();
    unsafe {
        if GetWindowRect(HWND(widget as _), &mut r).is_err() {
            return;
        }
        let _ = SetWindowPos(
            HWND(catcher as _),
            Some(HWND_TOPMOST),
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
    if !WATCHING.swap(true, Ordering::AcqRel) {
        let app = app.clone();
        std::thread::spawn(move || watch(app));
    }
}

fn hide() {
    let catcher = CATCHER.load(Ordering::Relaxed);
    if catcher != 0 {
        unsafe {
            let _ = ShowWindow(HWND(catcher as _), SW_HIDE);
        }
    }
}

/// 接手窗显示期间每 100ms 检查一次：鼠标键都已松开（拖放已结束，或在接手前就放下了）就收起，
/// 免得它留在图标上挡住点击
fn watch(app: AppHandle) {
    let catcher = HWND(CATCHER.load(Ordering::Relaxed) as _);
    let visible = || unsafe { IsWindowVisible(catcher) }.as_bool();
    loop {
        std::thread::sleep(Duration::from_millis(100));
        let pressed = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 || GetAsyncKeyState(VK_RBUTTON.0 as i32) < 0 };
        if visible() && !pressed {
            if INSIDE.swap(false, Ordering::Relaxed) {
                super::cancel(&app);
            }
            unsafe {
                let _ = ShowWindowAsync(catcher, SW_HIDE);
            }
        }
        if visible() && pressed {
            continue;
        }
        WATCHING.store(false, Ordering::Release);
        // 退出前恰好又被显示、而 show() 以为看门狗还在：接着看
        if !(visible() && !WATCHING.swap(true, Ordering::AcqRel)) {
            break;
        }
    }
}
