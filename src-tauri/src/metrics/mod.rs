mod net;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::{Disks, System};
use tauri::{AppHandle, Emitter, Manager};

use crate::config;

static PANEL_OPEN: AtomicBool = AtomicBool::new(false);
static EMIT_MS: AtomicU64 = AtomicU64::new(2000);
static WAKE: OnceLock<(Mutex<u64>, Condvar)> = OnceLock::new();

// 与 Windows 任务管理器 / 资源管理器一致，使用二进制单位
const MIB: f64 = 1024.0 * 1024.0;
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

fn wake_signal() -> &'static (Mutex<u64>, Condvar) {
    WAKE.get_or_init(|| (Mutex::new(0), Condvar::new()))
}

pub fn wake() {
    let (lock, cv) = wake_signal();
    let mut seq = lock.lock().unwrap();
    *seq = seq.wrapping_add(1);
    cv.notify_all();
}

#[derive(Serialize, Clone, Debug)]
pub struct DiskInfo {
    pub mount: String,
    pub used_gb: f64,
    pub total_gb: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct BatteryInfo {
    pub percent: f64,
    pub charging: bool,
    pub secs_left: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct MetricsSnapshot {
    pub cpu_percent: f32,
    pub mem_used_mb: f64,
    pub mem_total_mb: f64,
    pub disks: Vec<DiskInfo>,
    pub net_up_bps: u64,
    pub net_down_bps: u64,
    pub battery: Option<BatteryInfo>,
    /// GPU 占用率。只在篝火动画选了 GPU 驱动时才采样，其余时候为 None（采样线程刚启动的头几秒也是 None）
    pub gpu_percent: Option<f32>,
    pub ts: u64,
}

pub fn panel_open() -> bool {
    PANEL_OPEN.load(Ordering::Relaxed)
}

pub fn set_panel_open(app: &AppHandle, open: bool) {
    let (panel_ms, idle_ms) = {
        let state = app.state::<config::AppState>();
        let cfg = state.0.read().unwrap();
        (cfg.metrics.panel_interval_ms, cfg.metrics.idle_interval_ms)
    };
    PANEL_OPEN.store(open, Ordering::Relaxed);
    EMIT_MS.store(
        if open {
            panel_ms.clamp(250, 60_000)
        } else {
            idle_ms.clamp(500, 60_000)
        },
        Ordering::Relaxed,
    );
    wake();
    // 展开：模块立即刷新；收起：常驻进程开始计时，到期后结束
    crate::modules::wake();
}

pub fn start(app: AppHandle) {
    let (panel_ms, idle_ms) = {
        let state = app.state::<config::AppState>();
        let cfg = state.0.read().unwrap();
        (cfg.metrics.panel_interval_ms, cfg.metrics.idle_interval_ms)
    };
    EMIT_MS.store(
        if panel_open() {
            panel_ms.clamp(250, 60_000)
        } else {
            idle_ms.clamp(500, 60_000)
        },
        Ordering::Relaxed,
    );

    std::thread::spawn(move || {
        let mut sys = System::new();
        let mut net = net::NetSampler::new();
        let mut disks = Disks::new_with_refreshed_list();
        let battery_mgr = starship_battery::Manager::new().ok();

        let mut cached_disks: Vec<DiskInfo> = Vec::new();
        let mut cached_battery: Option<BatteryInfo> = None;
        let mut last_slow: Option<Instant> = None;

        loop {
            let seen = *wake_signal().0.lock().unwrap();
            let now = Instant::now();
            let shown = crate::widget::is_shown();
            let open = panel_open();
            let active = shown || open;

            sys.refresh_cpu_usage();
            sys.refresh_memory();
            let (up, down) = net.sample();

            if active
                && (last_slow.is_none()
                    || (open && now.duration_since(last_slow.unwrap()) >= Duration::from_secs(30)))
            {
                disks.refresh(true);
                cached_disks = disks
                    .list()
                    .iter()
                    .filter(|d| d.total_space() > 0)
                    .map(|d| {
                        let total = d.total_space();
                        let avail = d.available_space();
                        DiskInfo {
                            mount: d.mount_point().to_string_lossy().to_string(),
                            used_gb: (total.saturating_sub(avail)) as f64 / GIB,
                            total_gb: total as f64 / GIB,
                        }
                    })
                    .collect();
                cached_battery = battery_mgr
                    .as_ref()
                    .and_then(|m| m.batteries().ok())
                    .and_then(|mut it| it.next())
                    .and_then(|b| b.ok())
                    .map(|b| {
                        let charging = b.state() == starship_battery::State::Charging;
                        let time = if charging {
                            b.time_to_full()
                        } else {
                            b.time_to_empty()
                        };
                        BatteryInfo {
                            percent: b
                                .state_of_charge()
                                .get::<starship_battery::units::ratio::ratio>()
                                as f64,
                            charging,
                            secs_left: time.map(|d| {
                                d.get::<starship_battery::units::time::second>().max(0.0) as u64
                            }),
                        }
                    });
                last_slow = Some(now);
            }

            // 篝火被隐藏（如全屏游戏期间）时不采样，GPU 采样线程会在闲置后自行退出
            let gpu_percent = if active && shown && config::driver_source(&app) == "gpu" {
                crate::gpu::percent().ok().flatten()
            } else {
                None
            };

            let snap = MetricsSnapshot {
                cpu_percent: sys.global_cpu_usage(),
                mem_used_mb: sys.used_memory() as f64 / MIB,
                mem_total_mb: sys.total_memory() as f64 / MIB,
                disks: cached_disks.clone(),
                net_up_bps: up,
                net_down_bps: down,
                battery: cached_battery.clone(),
                gpu_percent,
                ts: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            };
            crate::tray::update_tooltip(&app, &snap);
            let _ = app.emit_to("widget", "metrics://snapshot", &snap);

            config::save_if_dirty(&app);

            let wait = if active {
                Duration::from_millis(EMIT_MS.load(Ordering::Relaxed).clamp(250, 60_000))
            } else {
                Duration::from_secs(5)
            };
            let (lock, cv) = wake_signal();
            let guard = lock.lock().unwrap();
            drop(cv.wait_timeout_while(guard, wait, |s| *s == seen).unwrap());
        }
    });
}
