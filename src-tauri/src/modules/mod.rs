mod decode;
mod http;
mod ping;
pub mod runner;
mod value;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
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

/// 原生模块（http / ping / gpu）一次取值的结果：显示文本，以及自然单位下的数值（毫秒、百分比等）
#[derive(Debug)]
pub struct Reading {
    pub text: String,
    pub num: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ModuleOutput {
    pub id: String,
    pub kind: String, // "ok" | "error"
    pub text: String,
    /// 0~1 的比例，供进度条 / 折线使用（折线不截断）
    pub value: Option<f64>,
    /// 自然单位下的数值（73%→73、23ms→23）
    pub num: Option<f64>,
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
        let configured = match m.kind.as_str() {
            "command" => !m.command.trim().is_empty(),
            "http" => !m.url.trim().is_empty(),
            "ping" => !m.host.trim().is_empty(),
            "gpu" => true,
            _ => false,
        };
        if !configured {
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_loop(app, m, gen).await;
        });
    }
}

/// 面板收起时的等待：等展开信号（1s 兜底防止错过通知）
async fn idle_wait() {
    tokio::select! {
        _ = wake_signal().notified() => {}
        _ = tokio::time::sleep(Duration::from_secs(1)) => {}
    }
}

fn emit(app: &AppHandle, out: &ModuleOutput) {
    let _ = app.emit_to("widget", "module://output", out);
}

/// 轮询模块（命令 / HTTP / Ping / GPU）：按刷新间隔取值，面板收起时暂停
async fn run_loop(app: AppHandle, cfg: ModuleConfig, gen: u64) {
    // 请求外部服务的模块不允许过于频繁
    let min_ms = if cfg.kind == "http" { 1000 } else { 500 };
    let base = Duration::from_millis(cfg.interval_ms.max(min_ms));
    let mut failures: u32 = 0;
    loop {
        if GEN.load(Ordering::Relaxed) != gen {
            return;
        }
        if !metrics::panel_open() {
            idle_wait().await;
            continue;
        }

        let out = match fetch(&cfg).await {
            Ok(out) => {
                failures = if out.kind == "ok" { 0 } else { failures.saturating_add(1) };
                out
            }
            Err(e) => {
                failures = failures.saturating_add(1);
                error_output(&cfg, e)
            }
        };
        if GEN.load(Ordering::Relaxed) != gen {
            return;
        }
        emit(&app, &out);

        let delay = base * if failures >= 3 { 4 } else { 1 };
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            // 面板收起后再展开 / 配置重载时立即进入下一轮
            _ = wake_signal().notified() => {}
        }
    }
}

/// 执行一次取值。轮询模块与“测试运行”共用；命令型走 shell，原生类型不经过 shell
async fn fetch(cfg: &ModuleConfig) -> Result<ModuleOutput, String> {
    match cfg.kind.as_str() {
        "command" => runner::run_command(cfg).await.map(|raw| parse_output(cfg, raw)),
        "http" => http::fetch(cfg).await.map(|r| reading_output(cfg, r)),
        "ping" => ping::fetch(cfg).await.map(|r| reading_output(cfg, r)),
        "gpu" => fetch_gpu(cfg).await.map(|r| reading_output(cfg, r)),
        other => Err(format!("未知的模块类型: {other}")),
    }
}

/// GPU 采样线程刚启动时还没有第一个有效值（约 2 秒），在超时范围内等一等，免得第一次刷新必然显示失败
async fn fetch_gpu(cfg: &ModuleConfig) -> Result<Reading, String> {
    let deadline = Instant::now() + Duration::from_millis(cfg.timeout_ms.clamp(500, 60_000));
    loop {
        if let Some(p) = crate::gpu::percent()? {
            let p = p as f64;
            return Ok(Reading { text: format!("{p:.0}"), num: Some(p) });
        }
        if Instant::now() >= deadline {
            return Err("GPU 计数器初始化超时".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 设置页的“测试运行”
pub async fn test(cfg: &ModuleConfig) -> serde_json::Value {
    let t = Instant::now();
    let res = fetch(cfg).await;
    let ms = t.elapsed().as_millis() as u64;
    match res {
        Ok(out) if out.kind == "error" => serde_json::json!({ "ok": false, "ms": ms, "error": out.text }),
        Ok(out) => serde_json::json!({ "ok": true, "ms": ms, "output": out }),
        Err(e) => serde_json::json!({ "ok": false, "ms": ms, "error": e }),
    }
}

fn error_output(cfg: &ModuleConfig, text: String) -> ModuleOutput {
    ModuleOutput {
        id: cfg.id.clone(),
        kind: "error".into(),
        text,
        value: None,
        num: None,
        color: cfg.color.clone(),
        items: None,
    }
}

/// 组装正常输出：脚本自己给的颜色优先于模块配置的颜色
fn build_output(
    cfg: &ModuleConfig,
    text: String,
    value: Option<f64>,
    num: Option<f64>,
    color: Option<String>,
    items: Option<Vec<ModuleItem>>,
) -> ModuleOutput {
    let color = color.or_else(|| cfg.color.clone());
    let items = items.map(|items| {
        items
            .into_iter()
            .map(|mut it| {
                it.color = it.color.or_else(|| cfg.color.clone());
                it
            })
            .collect()
    });
    ModuleOutput { id: cfg.id.clone(), kind: "ok".into(), text, value, num, color, items }
}

/// 把 num 换算成进度条 / 折线用的比例。进度条限制在 0~1，折线只看相对起伏所以不截断
fn ratio(style: &str, num: Option<f64>) -> Option<f64> {
    let n = num?;
    match style {
        "progress" => Some((n / 100.0).clamp(0.0, 1.0)),
        "sparkline" => Some(n / 100.0),
        _ => None,
    }
}

fn reading_output(cfg: &ModuleConfig, r: Reading) -> ModuleOutput {
    build_output(cfg, r.text, ratio(&cfg.style, r.num), r.num, None, None)
}

/// 解析命令的一段输出（轮询模式是整段输出，常驻模式是一行）
fn parse_output(cfg: &ModuleConfig, raw: String) -> ModuleOutput {
    if cfg.format == "json" {
        return match serde_json::from_str::<JsonOut>(&raw) {
            Ok(v) => {
                let num = v.value.map(|x| x * 100.0).filter(|n| n.is_finite());
                build_output(cfg, v.text, v.value, num, v.color, v.items)
            }
            Err(_) => error_output(cfg, "JSON 解析失败".into()),
        };
    }

    let text = raw.trim().to_string();
    let strict = value::whole_number(&text);
    // 进度条要求整段文本就是数字，避免把“8.8 / 512 GB”误读成 8.8%；折线、阈值、驱动则取文本里的第一个数
    let num = strict.or_else(|| value::first_number(&text));
    let value = ratio(&cfg.style, if cfg.style == "progress" { strict } else { num });
    build_output(cfg, text, value, num, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(style: &str, format: &str) -> ModuleConfig {
        ModuleConfig { id: "m".into(), style: style.into(), format: format.into(), ..Default::default() }
    }

    #[test]
    fn plain_text_numbers_for_each_style() {
        let o = parse_output(&cfg("progress", "plain"), "73%\n".into());
        assert_eq!((o.value, o.num), (Some(0.73), Some(73.0)));
        let o = parse_output(&cfg("progress", "plain"), "150".into());
        assert_eq!((o.value, o.num), (Some(1.0), Some(150.0)));
        // 进度条不从文字里摘数字，但阈值 / 驱动仍可以
        let o = parse_output(&cfg("progress", "plain"), "8.8 / 512 GB".into());
        assert_eq!((o.value, o.num), (None, Some(8.8)));
        // 折线不截断：延迟超过 100ms 时曲线不应被压平
        let o = parse_output(&cfg("sparkline", "plain"), "230ms".into());
        assert_eq!((o.value, o.num), (Some(2.3), Some(230.0)));
        let o = parse_output(&cfg("text", "plain"), "23".into());
        assert_eq!((o.value, o.num), (None, Some(23.0)));
        let o = parse_output(&cfg("text", "plain"), "运行中".into());
        assert_eq!((o.value, o.num), (None, None));
    }

    #[test]
    fn native_readings_feed_style_ratio() {
        let c = cfg("sparkline", "plain");
        let o = reading_output(&c, Reading { text: "23".into(), num: Some(23.0) });
        assert_eq!((o.value, o.num), (Some(0.23), Some(23.0)));
        let c = cfg("text", "plain");
        let o = reading_output(&c, Reading { text: "23".into(), num: Some(23.0) });
        assert_eq!((o.value, o.num), (None, Some(23.0)));
    }

    #[test]
    fn old_config_files_still_load() {
        // 0.2.0 及以前保存的模块没有新增的字段
        let old = r#"{"id":"m1","type":"command","name":"x","command":"echo 1","shell":"powershell","intervalMs":5000,"timeoutMs":3000,"style":"text","format":"plain","color":null,"unit":null}"#;
        let m: ModuleConfig = serde_json::from_str(old).unwrap();
        assert!(m.url.is_empty() && m.host.is_empty());
        let cfg: crate::config::AppConfig = serde_json::from_str(r#"{"modules":[{"id":"a"}]}"#).unwrap();
        assert_eq!(cfg.modules[0].kind, "command");
    }

    #[tokio::test]
    async fn failing_command_reports_stderr_reason() {
        let c = ModuleConfig {
            kind: "command".into(),
            shell: "cmd".into(),
            command: "echo no such thing 1>&2 & exit 3".into(),
            ..Default::default()
        };
        let r = test(&c).await;
        assert_eq!(r["ok"], false);
        let e = r["error"].as_str().unwrap();
        assert!(e.contains("退出码 3") && e.contains("no such thing"), "{e}");
    }

    #[tokio::test]
    async fn unknown_type_is_an_error() {
        let c = ModuleConfig { kind: "carrier-pigeon".into(), ..Default::default() };
        assert_eq!(test(&c).await["ok"], false);
    }
}
