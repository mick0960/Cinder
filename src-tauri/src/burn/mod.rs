//! 焚烧：把文件 / 文件夹拖到篝火上按住 4 秒，播放燃烧动画后移到回收站。
//!
//! 拖放由盖在图标上的原生接手窗接收（见 catcher.rs），计时和删除都在后端，
//! `burn` 覆盖窗口只负责动画。4 秒内离开或松手即取消，兼作防误删确认。

mod catcher;

pub use catcher::{install, show as catch};

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const LABEL: &str = "burn";
const BURN_MS: u64 = 4000;
/// 拒绝提示保留多久：覆盖窗口首次创建时可能错过事件，挂载后靠 `snapshot` 补上
const REFUSED_TTL: Duration = Duration::from_millis(1500);
// 覆盖窗口尺寸（逻辑像素），与 BurnWindow.tsx 保持一致
const WIN_W: f64 = 200.0;
const WIN_H: f64 = 260.0;

static NEXT: AtomicU64 = AtomicU64::new(1);
static PHASE: Mutex<Phase> = Mutex::new(Phase::Idle);

enum Phase {
    Idle,
    Burning {
        gen: u64,
        paths: Vec<PathBuf>,
        started: Instant,
    },
    Refused {
        gen: u64,
        reason: &'static str,
        at: Instant,
    },
}

impl Phase {
    fn gen(&self) -> u64 {
        match self {
            Phase::Idle => 0,
            Phase::Burning { gen, .. } | Phase::Refused { gen, .. } => *gen,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Snapshot {
    Burning {
        name: String,
        is_dir: bool,
        count: usize,
        duration_ms: u64,
        elapsed_ms: u64,
    },
    Refused {
        reason: String,
    },
}

#[derive(Serialize, Clone, Debug)]
struct Done {
    error: Option<String>,
}

/// 文件拖入图标（主线程，DragEnter 中同步调用）：立即记下状态并开始计时，满 4 秒仍未取消则移到回收站。
/// 状态必须同步写入，否则紧随其后的离开 / 松手可能先于点火生效，取消不掉。
fn begin(app: &AppHandle, paths: Vec<PathBuf>) {
    let paths: Vec<PathBuf> = paths
        .into_iter()
        .filter(|p| std::fs::symlink_metadata(p).is_ok())
        .collect();
    if paths.is_empty() {
        return;
    }
    let gen = NEXT.fetch_add(1, Ordering::Relaxed);
    if let Some(reason) = refuse_reason(&paths) {
        *PHASE.lock().unwrap() = Phase::Refused { gen, reason, at: Instant::now() };
    } else {
        *PHASE.lock().unwrap() = Phase::Burning { gen, paths, started: Instant::now() };
        spawn_timer(app.clone(), gen);
    }

    // 覆盖窗口不能在主线程同步创建（会死锁，见 toggle_panel），放到异步任务里
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if ensure_window(&app).is_err() {
            return;
        }
        // 持锁发送：建窗期间可能已被取消或被新一次拖入取代，此时不再点火；也保证“开始”不会晚于“取消”送达
        let phase = PHASE.lock().unwrap();
        if phase.gen() == gen {
            if let Some(snap) = snapshot_of(&phase) {
                let _ = app.emit("burn://start", snap);
            }
        }
    });
}

fn spawn_timer(app: AppHandle, gen: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(BURN_MS)).await;
        let paths = {
            let mut phase = PHASE.lock().unwrap();
            match &*phase {
                Phase::Burning { gen: g, .. } if *g == gen => {}
                _ => return, // 已取消，或被新一次拖入取代
            }
            match std::mem::replace(&mut *phase, Phase::Idle) {
                Phase::Burning { paths, .. } => paths,
                _ => unreachable!(),
            }
        };
        let error = tauri::async_runtime::spawn_blocking(move || recycle(&paths))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
            .err();
        let _ = app.emit("burn://done", Done { error });
    });
}

/// 离开图标或提前松手：熄火，不删除。删除完成后的离开 / 松手是空操作。
fn cancel(app: &AppHandle) {
    let mut phase = PHASE.lock().unwrap();
    if matches!(*phase, Phase::Burning { .. }) {
        *phase = Phase::Idle;
        drop(phase);
        let _ = app.emit("burn://cancel", ());
    }
}

/// 覆盖窗口挂载时补取当前状态，并按已过去的时间追上动画进度
pub fn snapshot() -> Option<Snapshot> {
    snapshot_of(&PHASE.lock().unwrap())
}

fn snapshot_of(phase: &Phase) -> Option<Snapshot> {
    match phase {
        Phase::Burning { paths, started, .. } => Some(burning_snapshot(paths, started.elapsed())),
        Phase::Refused { reason, at, .. } if at.elapsed() < REFUSED_TTL => {
            Some(Snapshot::Refused { reason: (*reason).into() })
        }
        _ => None,
    }
}

fn burning_snapshot(paths: &[PathBuf], elapsed: Duration) -> Snapshot {
    let first = &paths[0];
    Snapshot::Burning {
        name: first
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| first.to_string_lossy().into_owned()),
        is_dir: first.is_dir(),
        count: paths.len(),
        duration_ms: BURN_MS,
        elapsed_ms: elapsed.as_millis() as u64,
    }
}

/// 盘符根目录、系统目录、用户目录及它们的上级目录一律不烧
fn refuse_reason(paths: &[PathBuf]) -> Option<&'static str> {
    // Windows 路径不区分大小写，统一转小写并去掉末尾分隔符后比较
    let norm = |p: &Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase();
    let guarded: Vec<String> = ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "USERPROFILE"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|v| norm(Path::new(&v)))
        .collect();
    for p in paths {
        if p.parent().is_none() {
            return Some("整个磁盘可烧不得");
        }
        let p = norm(p);
        if guarded.iter().any(|g| *g == p || g.starts_with(&format!("{p}\\"))) {
            return Some("系统目录烧不得");
        }
    }
    None
}

/// 移到回收站。无回收站的位置（网络盘、U 盘、超大文件）由系统弹窗确认，不会静默永久删除。
fn recycle(paths: &[PathBuf]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FOF_WANTNUKEWARNING, FO_DELETE, SHFILEOPSTRUCTW,
    };

    // pFrom：各路径以 \0 分隔，整体以双 \0 结尾
    let mut from: Vec<u16> = Vec::new();
    for p in paths {
        from.extend(p.as_os_str().encode_wide());
        from.push(0);
    }
    from.push(0);

    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_WANTNUKEWARNING | FOF_SILENT | FOF_NOERRORUI)
            as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    let rc = unsafe {
        let inited =
            CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) >= 0;
        let rc = SHFileOperationW(&mut op);
        if inited {
            CoUninitialize();
        }
        rc
    };
    if rc != 0 {
        return Err(match rc {
            5 => "没有权限".into(),
            32 | 33 => "文件正被占用".into(),
            2 | 3 | 0x7C => "文件已不存在".into(),
            _ => format!("错误码 {rc:#x}"),
        });
    }
    if op.fAnyOperationsAborted != 0 {
        return Err("已取消".into());
    }
    Ok(())
}

/// 覆盖窗口：透明、置顶、鼠标穿透（盖住图标也不会抢走拖放目标），常驻隐藏
fn ensure_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let win = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html".into()))
        .title("Cinder 焚烧")
        .inner_size(WIN_W, WIN_H)
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
    let _ = win.set_ignore_cursor_events(true);
    Ok(())
}
