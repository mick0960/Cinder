use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::config;

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
const TOAST_LABEL: &str = "update-toast";

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// idle | checking | available | downloading | ready | uptodate | error
    pub state: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    /// 下载进度 0~100
    pub progress: u8,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct UpdateState {
    status: Mutex<UpdateStatus>,
    pending: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
    busy: AtomicBool,
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut UpdateStatus)) -> UpdateStatus {
    let st = app.state::<UpdateState>();
    let snapshot = {
        let mut s = st.status.lock().unwrap();
        f(&mut s);
        s.clone()
    };
    let _ = app.emit("update://status", &snapshot);
    snapshot
}

pub fn status(app: &AppHandle) -> UpdateStatus {
    let st = app.state::<UpdateState>();
    let mut s = st.status.lock().unwrap().clone();
    if s.state.is_empty() {
        s.state = "idle".into();
    }
    s
}

/// 检查更新。`manual` 为 true 时忽略“已跳过版本”，并且不论自动/手动模式都会给出明确结果。
pub async fn check(app: &AppHandle, manual: bool) -> UpdateStatus {
    let st = app.state::<UpdateState>();
    if st.busy.swap(true, Ordering::SeqCst) {
        return status(app);
    }
    let result = do_check(app, manual).await;
    st.busy.store(false, Ordering::SeqCst);
    result
}

async fn do_check(app: &AppHandle, manual: bool) -> UpdateStatus {
    // 已经下载好或在下载中的不再重复检查
    let cur = status(app);
    if matches!(cur.state.as_str(), "ready" | "downloading") {
        return cur;
    }
    if manual {
        set_status(app, |s| *s = UpdateStatus { state: "checking".into(), ..Default::default() });
    }
    let found = match app.updater() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    let update = match found {
        Ok(Some(u)) => u,
        Ok(None) => {
            return set_status(app, |s| {
                *s = UpdateStatus { state: if manual { "uptodate" } else { "idle" }.into(), ..Default::default() }
            });
        }
        Err(e) => {
            return set_status(app, |s| {
                *s = if manual {
                    UpdateStatus { state: "error".into(), error: Some(e), ..Default::default() }
                } else {
                    UpdateStatus { state: "idle".into(), ..Default::default() }
                }
            });
        }
    };

    let (auto, skipped) = {
        let state = app.state::<config::AppState>();
        let cfg = state.0.read().unwrap();
        (cfg.update.auto, cfg.update.skipped_version.clone())
    };
    if !manual && skipped.as_deref() == Some(update.version.as_str()) {
        return status(app);
    }

    let version = update.version.clone();
    let notes = update.body.clone();
    *app.state::<UpdateState>().pending.lock().unwrap() = Some(update);
    let snap = set_status(app, |s| {
        *s = UpdateStatus {
            state: "available".into(),
            version: Some(version),
            notes,
            ..Default::default()
        }
    });

    if auto {
        // 静默下载，完成后才打扰用户
        return download_inner(app).await;
    }
    show_toast(app);
    snap
}

/// 下载已发现的更新（不安装）。
pub async fn download(app: &AppHandle) -> UpdateStatus {
    let st = app.state::<UpdateState>();
    if st.busy.swap(true, Ordering::SeqCst) {
        return status(app);
    }
    let r = download_inner(app).await;
    st.busy.store(false, Ordering::SeqCst);
    r
}

async fn download_inner(app: &AppHandle) -> UpdateStatus {
    let Some(update) = app.state::<UpdateState>().pending.lock().unwrap().clone() else {
        return status(app);
    };
    set_status(app, |s| {
        s.state = "downloading".into();
        s.progress = 0;
        s.error = None;
    });

    let mut got: u64 = 0;
    let mut last_pct: u8 = 0;
    let handle = app.clone();
    let res = update
        .download(
            move |chunk, total| {
                got += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let pct = (got * 100 / total).min(100) as u8;
                    if pct != last_pct {
                        last_pct = pct;
                        set_status(&handle, |s| s.progress = pct);
                    }
                }
            },
            || {},
        )
        .await;

    match res {
        Ok(bytes) => {
            *app.state::<UpdateState>().bytes.lock().unwrap() = Some(bytes);
            let snap = set_status(app, |s| {
                s.state = "ready".into();
                s.progress = 100;
            });
            show_toast(app);
            snap
        }
        Err(e) => {
            let snap = set_status(app, |s| {
                s.state = "error".into();
                s.error = Some(e.to_string());
            });
            // 下载失败时保留 pending，让用户可以重试
            show_toast(app);
            snap
        }
    }
}

/// 安装已下载的更新。Windows 上安装器会接管并结束当前进程，随后自动重启新版本。
pub fn install(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<UpdateState>();
    let update = st.pending.lock().unwrap().clone().ok_or("没有可用的更新")?;
    let bytes = st.bytes.lock().unwrap().take().ok_or("更新尚未下载完成")?;
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

/// “下次再说”：记住该版本，后台不再为它打扰用户；更高版本发布后会再次提示。
pub fn dismiss(app: &AppHandle) {
    let version = status(app).version;
    if let Some(v) = version {
        config::set_update(app, |u| u.skipped_version = Some(v));
    }
    let st = app.state::<UpdateState>();
    *st.pending.lock().unwrap() = None;
    *st.bytes.lock().unwrap() = None;
    set_status(app, |s| *s = UpdateStatus { state: "idle".into(), ..Default::default() });
    close_toast(app);
}

pub fn close_toast(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(TOAST_LABEL) {
        let _ = w.close();
    }
}

/// 在屏幕右下角弹出小气泡窗口。
pub fn show_toast(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window(TOAST_LABEL) {
            let _ = w.show();
            return;
        }
        const W: f64 = 320.0;
        const H: f64 = 132.0;
        const MARGIN: i32 = 16;
        let built = tauri::WebviewWindowBuilder::new(
            &handle,
            TOAST_LABEL,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Cinder 更新")
        .inner_size(W, H)
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
        .build();
        let Ok(win) = built else { return };
        let _ = win.set_focusable(false);
        if let Ok(Some(m)) = win.primary_monitor() {
            let sf = win.scale_factor().unwrap_or(1.0);
            let area = m.work_area();
            let w = (W * sf) as i32;
            let h = (H * sf) as i32;
            let x = area.position.x + area.size.width as i32 - w - MARGIN;
            let y = area.position.y + area.size.height as i32 - h - MARGIN;
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let _ = win.show();
    });
}

/// 启动后台检查：启动后稍等片刻先查一次，之后每隔数小时再查。
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            check(&app, false).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}
