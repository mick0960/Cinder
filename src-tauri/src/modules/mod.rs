mod decode;
pub mod runner;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Notify;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{AppState, ModuleConfig};
use crate::metrics;

static GEN: AtomicU64 = AtomicU64::new(0);
static WAKE: OnceLock<Notify> = OnceLock::new();

fn wake_signal() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

/// 唤醒所有模块循环：面板展开时立即刷新一次；重载时让旧循环尽快退出
pub fn wake() {
    wake_signal().notify_waiters();
}

#[derive(Serialize, Clone, Debug)]
pub struct ModuleOutput {
    pub id: String,
    pub kind: String, // "ok" | "error"
    pub text: String,
    pub value: Option<f64>,
    pub color: Option<String>,
    /// JSON 输出可带多行条目（如多个账号的多个用量窗口），组件逐条渲染
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<ModuleItem>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ModuleItem {
    pub group: Option<String>,
    pub label: String,
    pub text: String,
    pub value: Option<f64>,
    pub color: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct JsonOut {
    text: String,
    value: Option<f64>,
    color: Option<String>,
    items: Option<Vec<ModuleItem>>,
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut spawned = GEN.load(Ordering::Relaxed);
        spawn_all(&app, spawned);
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let cur = GEN.load(Ordering::Relaxed);
            if cur != spawned {
                spawn_all(&app, cur);
                spawned = cur;
            }
        }
    });
}

pub fn reload(_app: &AppHandle) {
    GEN.fetch_add(1, Ordering::Relaxed);
    wake();
}

fn spawn_all(app: &AppHandle, gen: u64) {
    let modules: Vec<ModuleConfig> = {
        let state = app.state::<AppState>();
        let mods = state.0.read().unwrap().modules.clone();
        mods
    };
    for m in modules {
        if m.kind != "command" || m.command.trim().is_empty() {
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_loop(app, m, gen).await;
        });
    }
}

async fn run_loop(app: AppHandle, cfg: ModuleConfig, gen: u64) {
    let base = Duration::from_millis(cfg.interval_ms.max(500));
    let mut failures: u32 = 0;
    loop {
        if GEN.load(Ordering::Relaxed) != gen {
            return;
        }
        if !metrics::panel_open() {
            // 面板收起：不执行命令，等待展开信号（1s 兜底防止错过通知）
            tokio::select! {
                _ = wake_signal().notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
            continue;
        }

        let out = match runner::run_command(&cfg).await {
            Ok(raw) => {
                failures = 0;
                parse_output(&cfg, raw)
            }
            Err(e) => {
                failures = failures.saturating_add(1);
                ModuleOutput {
                    id: cfg.id.clone(),
                    kind: "error".into(),
                    text: e,
                    value: None,
                    color: cfg.color.clone(),
                    items: None,
                }
            }
        };
        if GEN.load(Ordering::Relaxed) != gen {
            return;
        }
        let _ = app.emit_to("widget", "module://output", &out);

        let delay = base * if failures >= 3 { 4 } else { 1 };
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            // 面板收起后再展开 / 配置重载时立即进入下一轮
            _ = wake_signal().notified() => {}
        }
    }
}

pub fn parse_output(cfg: &ModuleConfig, raw: String) -> ModuleOutput {
    if cfg.format == "json" {
        match serde_json::from_str::<JsonOut>(&raw) {
            Ok(v) => {
                return ModuleOutput {
                    id: cfg.id.clone(),
                    kind: "ok".into(),
                    text: v.text,
                    value: v.value,
                    color: v.color.or_else(|| cfg.color.clone()),
                    items: v.items.map(|items| {
                        items
                            .into_iter()
                            .map(|mut it| {
                                it.color = it.color.or_else(|| cfg.color.clone());
                                it
                            })
                            .collect()
                    }),
                }
            }
            Err(_) => {
                return ModuleOutput {
                    id: cfg.id.clone(),
                    kind: "error".into(),
                    text: "JSON 解析失败".into(),
                    value: None,
                    color: cfg.color.clone(),
                    items: None,
                }
            }
        }
    }

    let text = raw.trim().to_string();
    let value = if cfg.style == "progress" || cfg.style == "sparkline" {
        parse_value(&text)
    } else {
        None
    };
    ModuleOutput {
        id: cfg.id.clone(),
        kind: "ok".into(),
        text,
        value,
        color: cfg.color.clone(),
        items: None,
    }
}

fn parse_value(s: &str) -> Option<f64> {
    let s = s.trim().trim_end_matches('%');
    if let Some((a, b)) = s.split_once('/') {
        let a: f64 = a.trim().parse().ok()?;
        let b: f64 = b.trim().parse().ok()?;
        if b > 0.0 {
            return Some((a / b).clamp(0.0, 1.0));
        }
        return None;
    }
    s.parse::<f64>().ok().map(|v| (v / 100.0).clamp(0.0, 1.0))
}
