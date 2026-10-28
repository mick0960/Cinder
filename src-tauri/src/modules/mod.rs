pub mod click;
mod decode;
mod http;
mod job;
mod ping;
pub mod runner;
mod stream;
mod value;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{self, AppState, ModuleConfig};
use crate::metrics;
use crate::widget;

static GEN: AtomicU64 = AtomicU64::new(0);
static WAKE: OnceLock<Notify> = OnceLock::new();

/// 面板收起后，常驻进程再保留这么久才被结束：反复展开 / 收起面板时不必每次重启进程
const STREAM_GRACE: Duration = Duration::from_secs(20);
/// 同一个常驻模块两次推送给前端的最小间隔：输出很密的进程不会拖垮前端
const MIN_EMIT_GAP: Duration = Duration::from_millis(200);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

fn wake_signal() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

/// 唤醒所有模块循环：面板展开 / 收起、驱动指标变化时立即重新判断；重载时让旧循环尽快退出
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
    /// 自然单位下的数值（73%→73、23ms→23），供阈值着色和驱动篝火使用
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
    /// 可选：自然单位下的数值；不写则按 value × 100 处理
    num: Option<f64>,
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
        if m.kind == "command" && m.persistent {
            tauri::async_runtime::spawn(async move {
                stream_loop(app, m, gen).await;
            });
        } else {
            tauri::async_runtime::spawn(async move {
                run_loop(app, m, gen).await;
            });
        }
    }
}

/// 模块当前是否需要运行：面板展开时所有模块都运行；面板收起时只有驱动篝火的那个模块继续运行，
/// 而且要篝火看得见才需要（全屏游戏时篝火被自动隐藏，就不必再为它取数）
fn demanded(app: &AppHandle, id: &str) -> bool {
    metrics::panel_open() || (config::driver_module(app).as_deref() == Some(id) && widget::is_shown())
}

/// 不需要运行时的等待：等展开 / 驱动变化的信号（1s 兜底防止错过通知）
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
        if !demanded(&app, &cfg.id) {
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

enum StreamEnd {
    /// 配置已重载，本循环作废
    Reload,
    /// 面板收起超过宽限期且不再需要，进程已结束
    Idle,
    Failed(String),
}

/// 常驻进程模块：进程只启动一次，每输出一行刷新一次。
/// 需要时才启动，面板收起 `STREAM_GRACE` 之后结束进程；进程退出或长时间无输出则退避重启。
async fn stream_loop(app: AppHandle, cfg: ModuleConfig, gen: u64) {
    let mut backoff = Duration::from_secs(2);
    loop {
        if GEN.load(Ordering::Relaxed) != gen {
            return;
        }
        if !demanded(&app, &cfg.id) {
            idle_wait().await;
            continue;
        }
        let started = Instant::now();
        match stream_once(&app, &cfg, gen).await {
            StreamEnd::Reload => return,
            StreamEnd::Idle => backoff = Duration::from_secs(2),
            StreamEnd::Failed(msg) => {
                emit(&app, &error_output(&cfg, msg));
                if started.elapsed() > Duration::from_secs(30) {
                    backoff = Duration::from_secs(2);
                }
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = wake_signal().notified() => {}
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

async fn stream_once(app: &AppHandle, cfg: &ModuleConfig, gen: u64) -> StreamEnd {
    let mut stream = match stream::LineStream::spawn(cfg) {
        Ok(s) => s,
        Err(e) => return StreamEnd::Failed(e),
    };
    // 常驻模式下“超时”表示多久没有新的一行就判定进程卡死
    let silence = Duration::from_millis(cfg.timeout_ms.clamp(500, 600_000));
    let mut last_line = Instant::now();
    let mut not_needed_since: Option<Instant> = None;
    // 最近一行解析出的输出；面板收起期间到达的先攒着，展开时立即推送
    let mut latest: Option<ModuleOutput> = None;
    let mut unsent = false;
    let mut last_emit: Option<Instant> = None;

    loop {
        if GEN.load(Ordering::Relaxed) != gen {
            return StreamEnd::Reload;
        }
        let now = Instant::now();
        let needed = demanded(app, &cfg.id);
        if needed {
            not_needed_since = None;
        } else if not_needed_since.is_none() {
            not_needed_since = Some(now);
        }
        if not_needed_since.is_some_and(|t| now.duration_since(t) >= STREAM_GRACE) {
            return StreamEnd::Idle;
        }
        if now.duration_since(last_line) >= silence {
            return StreamEnd::Failed(format!("{} 秒内没有输出，已重启", silence.as_secs()));
        }
        let gap_over = last_emit.is_none_or(|t| now.duration_since(t) >= MIN_EMIT_GAP);
        if needed && unsent && gap_over {
            if let Some(out) = &latest {
                emit(app, out);
                last_emit = Some(now);
                unsent = false;
            }
        }

        // 睡到最近的一个时间点：静默超时 / 宽限期结束 / 推送间隔结束；1s 兜底用来发现重载和展开
        let mut next = (last_line + silence).min(now + Duration::from_secs(1));
        if let Some(t) = not_needed_since {
            next = next.min(t + STREAM_GRACE);
        }
        if needed && unsent {
            if let Some(t) = last_emit {
                next = next.min(t + MIN_EMIT_GAP);
            }
        }
        tokio::select! {
            line = stream.next_line() => match line {
                Some(line) => {
                    last_line = Instant::now();
                    if !line.trim().is_empty() {
                        latest = Some(parse_output(cfg, line));
                        unsent = true;
                    }
                }
                None => return StreamEnd::Failed(stream.exit_message().await),
            },
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(next)) => {}
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

/// 设置页的“测试运行”。常驻模式只等第一行输出，然后立即结束进程
pub async fn test(cfg: &ModuleConfig) -> serde_json::Value {
    let t = Instant::now();
    let res = if cfg.kind == "command" && cfg.persistent {
        stream::first_output(cfg).await.map(|line| parse_output(cfg, line))
    } else {
        fetch(cfg).await
    };
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

/// 组装正常输出：颜色优先级为 脚本自己给的颜色 > 阈值规则 > 模块配置的颜色
fn build_output(
    cfg: &ModuleConfig,
    text: String,
    value: Option<f64>,
    num: Option<f64>,
    color: Option<String>,
    items: Option<Vec<ModuleItem>>,
) -> ModuleOutput {
    let color = color
        .or_else(|| num.and_then(|n| value::threshold_color(&cfg.thresholds, n)))
        .or_else(|| cfg.color.clone());
    // 多行条目：数值是 0~1 的比例，阈值按百分数比较
    let items = items.map(|items| {
        items
            .into_iter()
            .map(|mut it| {
                it.color = it
                    .color
                    .or_else(|| it.value.and_then(|v| value::threshold_color(&cfg.thresholds, v * 100.0)))
                    .or_else(|| cfg.color.clone());
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
                let num = v.num.or(v.value.map(|x| x * 100.0)).filter(|n| n.is_finite());
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
    use crate::config::Threshold;

    fn cfg(style: &str, format: &str) -> ModuleConfig {
        ModuleConfig { id: "m".into(), style: style.into(), format: format.into(), ..Default::default() }
    }

    fn rule(op: &str, value: f64, color: &str) -> Threshold {
        Threshold { op: op.into(), value, color: color.into() }
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
    fn json_output_keeps_script_color_over_thresholds() {
        let mut c = cfg("progress", "json");
        c.thresholds = vec![rule("gt", 80.0, "#ff0000")];
        c.color = Some("#00ff00".into());

        let o = parse_output(&c, r##"{"text":"90%","value":0.9}"##.into());
        assert_eq!((o.num, o.color.as_deref()), (Some(90.0), Some("#ff0000")));

        let o = parse_output(&c, r##"{"text":"90%","value":0.9,"color":"#123456"}"##.into());
        assert_eq!(o.color.as_deref(), Some("#123456"));

        let o = parse_output(&c, r##"{"text":"50%","value":0.5}"##.into());
        assert_eq!(o.color.as_deref(), Some("#00ff00"));

        // 自然单位的 num 优先于 value × 100
        let o = parse_output(&c, r##"{"text":"235 ms","num":235}"##.into());
        assert_eq!((o.num, o.color.as_deref()), (Some(235.0), Some("#ff0000")));

        assert_eq!(parse_output(&c, "not json".into()).kind, "error");
    }

    #[test]
    fn thresholds_color_multi_line_items() {
        let mut c = cfg("text", "json");
        c.thresholds = vec![rule("gt", 80.0, "#ff0000")];
        let o = parse_output(
            &c,
            r##"{"text":"2 项","items":[{"label":"a","text":"90%","value":0.9},{"label":"b","text":"10%","value":0.1},{"label":"c","text":"x","color":"#abcdef","value":0.99}]}"##
                .into(),
        );
        let colors: Vec<_> = o.items.unwrap().into_iter().map(|i| i.color).collect();
        assert_eq!(colors, vec![Some("#ff0000".into()), None, Some("#abcdef".into())]);
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
        assert!(!m.persistent && m.thresholds.is_empty() && m.click.is_none() && m.url.is_empty());
        let cfg: crate::config::AppConfig = serde_json::from_str(r#"{"modules":[{"id":"a"}]}"#).unwrap();
        assert_eq!(cfg.driver.source, "cpu");
        assert_eq!(cfg.modules[0].kind, "command");
    }

    #[test]
    fn driver_config_is_sanitized() {
        use crate::config::DriverConfig;
        let d = DriverConfig { source: "bogus".into(), ..Default::default() }.sanitized();
        assert_eq!(d.source, "cpu");
        let d = DriverConfig { source: "cpu".into(), module_id: Some("x".into()), ..Default::default() }.sanitized();
        assert_eq!(d.module_id, None);
        let d = DriverConfig { source: "module".into(), module_id: Some("x".into()), min: 50.0, max: 10.0 }.sanitized();
        assert_eq!((d.min, d.max, d.module_id.as_deref()), (0.0, 100.0, Some("x")));
        let d = DriverConfig { source: "net".into(), max: f64::NAN, ..Default::default() }.sanitized();
        assert_eq!(d.max, 100.0);
    }

    /// 常驻进程：一次启动，连续产出多行；丢弃 LineStream 后进程被结束
    #[tokio::test]
    async fn stream_yields_one_update_per_line() {
        let c = ModuleConfig {
            kind: "command".into(),
            shell: "cmd".into(),
            // ping -n 4 约每秒一行；输出的行数多于我们读取的行数，用来验证提前丢弃会结束进程
            command: "ping -n 6 127.0.0.1".into(),
            persistent: true,
            ..Default::default()
        };
        let mut s = stream::LineStream::spawn(&c).unwrap();
        let mut got = 0;
        while let Some(line) = tokio::time::timeout(Duration::from_secs(5), s.next_line()).await.unwrap() {
            if line.contains("127.0.0.1") {
                got += 1;
            }
            if got >= 3 {
                break;
            }
        }
        assert!(got >= 3);
    }

    #[tokio::test]
    async fn stream_reports_exit_code_and_stderr() {
        let c = ModuleConfig {
            kind: "command".into(),
            shell: "cmd".into(),
            command: "echo boom 1>&2 & exit 7".into(),
            persistent: true,
            ..Default::default()
        };
        let mut s = stream::LineStream::spawn(&c).unwrap();
        assert!(s.next_line().await.is_none());
        let msg = s.exit_message().await;
        assert!(msg.contains("退出码 7") && msg.contains("boom"), "{msg}");
    }

    #[tokio::test]
    async fn test_run_of_persistent_module_stops_at_first_line() {
        let c = ModuleConfig {
            kind: "command".into(),
            shell: "cmd".into(),
            command: "echo 42 & ping -n 30 127.0.0.1 >nul".into(),
            persistent: true,
            style: "progress".into(),
            timeout_ms: 5000,
            ..Default::default()
        };
        let t = Instant::now();
        let r = test(&c).await;
        assert!(t.elapsed() < Duration::from_secs(4), "should not wait for the whole command");
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["output"]["num"], 42.0);
        assert_eq!(r["output"]["value"], 0.42);
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
