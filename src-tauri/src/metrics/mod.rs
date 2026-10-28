use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use sysinfo::{Disks, Networks, System};
use tauri::{AppHandle, Emitter, Manager};

use crate::config;

static PANEL_OPEN: AtomicBool = AtomicBool::new(false);
static EMIT_MS: AtomicU64 = AtomicU64::new(1000);

// 与 Windows 任务管理器 / 资源管理器一致，使用二进制单位
const MIB: f64 = 1024.0 * 1024.0;
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

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
        if open { panel_ms.max(1000) } else { idle_ms.max(2000) },
        Ordering::Relaxed,
    );
    if open {
        crate::modules::wake();
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let mut nets = Networks::new_with_refreshed_list();
        let mut disks = Disks::new_with_refreshed_list();
        let battery_mgr = starship_battery::Manager::new().ok();

        let mut last_net: Option<(u64, u64, Instant)> = None;
        let mut cached_disks: Vec<DiskInfo> = Vec::new();
        let mut cached_battery: Option<BatteryInfo> = None;
        let mut last_slow: Option<Instant> = None;

        loop {
            let now = Instant::now();

            sys.refresh_cpu_usage();
            sys.refresh_memory();
            nets.refresh(true);

            let (recv, sent): (u64, u64) = nets
                .iter()
                .fold((0, 0), |(r, t), (_, d)| (r + d.received(), t + d.transmitted()));

            let (up, down) = match last_net {
                Some((r, s, t)) if now > t => {
                    let dt = (now - t).as_secs_f64();
                    let up = sent.saturating_sub(s) as f64 / dt;
                    let down = recv.saturating_sub(r) as f64 / dt;
                    (up as u64, down as u64)
                }
                _ => (0, 0),
            };
            last_net = Some((recv, sent, now));

            if last_slow.is_none() || now - last_slow.unwrap() >= Duration::from_secs(30) {
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
                    .map(|b| BatteryInfo {
                        percent: b.state_of_charge().get::<starship_battery::units::ratio::ratio>() as f64,
                        charging: b.state() == starship_battery::State::Charging,
                        secs_left: b
                            .time_to_empty()
                            .map(|d| d.get::<starship_battery::units::time::second>() as u64),
                    });
                last_slow = Some(now);
            }

            let snap = MetricsSnapshot {
                cpu_percent: sys.global_cpu_usage(),
                mem_used_mb: sys.used_memory() as f64 / MIB,
                mem_total_mb: sys.total_memory() as f64 / MIB,
                disks: cached_disks.clone(),
                net_up_bps: up,
                net_down_bps: down,
                battery: cached_battery.clone(),
                ts: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            };
            crate::tray::update_tooltip(&app, &snap);
            let _ = app.emit_to("widget", "metrics://snapshot", &snap);

            config::save_if_dirty(&app);

            let ms = EMIT_MS.load(Ordering::Relaxed).max(1000);
            std::thread::sleep(Duration::from_millis(ms));
        }
    });
}
