use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

static DIRTY: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowConfig {
    pub x: i32,
    pub y: i32,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self { x: 100, y: 100 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct MetricsConfig {
    pub panel_interval_ms: u64,
    pub idle_interval_ms: u64,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            panel_interval_ms: 1000,
            idle_interval_ms: 2000,
        }
    }
}

/// 数值阈值着色规则：数值 `op`（gt 高于 / lt 低于）`value` 时使用 `color`
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Threshold {
    pub op: String,
    pub value: f64,
    pub color: String,
}

impl Default for Threshold {
    fn default() -> Self {
        Self {
            op: "gt".into(),
            value: 80.0,
            color: "#ff5d5d".into(),
        }
    }
}

/// 点击模块行时的动作：打开网址（url）或运行命令（command）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ClickAction {
    pub kind: String,
    pub target: String,
    /// 仅 command 使用，含义同模块的 shell
    pub shell: String,
}

impl Default for ClickAction {
    fn default() -> Self {
        Self {
            kind: "url".into(),
            target: String::new(),
            shell: "powershell".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct ModuleConfig {
    pub id: String,
    /// command：运行命令；http：请求网址；ping：ICMP 延迟；gpu：所有显卡的占用率。后三种不经过 shell
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub command: String,
    pub shell: String,
    pub interval_ms: u64,
    /// command 轮询：执行超时；command 常驻：多久没有输出就判定卡死并重启；http / ping：请求超时
    pub timeout_ms: u64,
    pub style: String,
    pub format: String,
    pub color: Option<String>,
    pub unit: Option<String>,
    /// http：请求地址
    pub url: String,
    /// http：JSON 字段路径（如 data.items[0].value）；留空则把响应正文当作文本
    pub json_path: String,
    /// ping：主机名或 IPv4 地址
    pub host: String,
    /// command：只启动一次，每输出一行刷新一次
    pub persistent: bool,
    pub thresholds: Vec<Threshold>,
    pub click: Option<ClickAction>,
}

impl Default for ModuleConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: "command".into(),
            name: String::new(),
            command: String::new(),
            shell: "powershell".into(),
            interval_ms: 5000,
            timeout_ms: 3000,
            style: "text".into(),
            format: "plain".into(),
            color: None,
            unit: None,
            url: String::new(),
            json_path: String::new(),
            host: String::new(),
            persistent: false,
            thresholds: Vec::new(),
            click: None,
        }
    }
}

/// 篝火动画速度由哪个指标驱动
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct DriverConfig {
    /// cpu / mem / gpu / net_down / net_up / net / module
    pub source: String,
    /// source 为 module 时的模块 id
    pub module_id: Option<String>,
    /// 数值范围：net* 只用 max（MB/s，达到时动画最快）；module 用 min~max 映射到 0~100%；其余固定按 0~100%
    pub min: f64,
    pub max: f64,
}

impl Default for DriverConfig {
    fn default() -> Self {
        Self {
            source: "cpu".into(),
            module_id: None,
            min: 0.0,
            max: 100.0,
        }
    }
}

impl DriverConfig {
    const SOURCES: [&'static str; 7] = ["cpu", "mem", "gpu", "net_down", "net_up", "net", "module"];

    /// 丢弃不合法的取值，保证前端拿到的永远是可用配置
    pub fn sanitized(mut self) -> Self {
        if !Self::SOURCES.contains(&self.source.as_str()) {
            return Self::default();
        }
        if self.source != "module" {
            self.module_id = None;
        }
        if !self.min.is_finite() || !self.max.is_finite() || self.max <= self.min {
            let d = Self::default();
            self.min = d.min;
            self.max = d.max;
        }
        self
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateConfig {
    /// true：发现新版本后静默下载；false：仅提示，由用户手动下载
    pub auto: bool,
    /// 用户选择“下次再说”的版本，后台检查时不再提示（手动检查不受影响）
    pub skipped_version: Option<String>,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self { auto: true, skipped_version: None }
    }
}

/// 自定义角色（runner）：一组按顺序循环播放的图片帧（data URL）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RunnerConfig {
    pub id: String,
    pub name: String,
    pub frames: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    pub window: WindowConfig,
    pub character: String,
    pub metrics: MetricsConfig,
    pub modules: Vec<ModuleConfig>,
    pub runners: Vec<RunnerConfig>,
    pub update: UpdateConfig,
    /// 有全屏程序 / 演示模式时自动隐藏图标，结束后恢复（见 fullscreen.rs）
    pub hide_on_fullscreen: bool,
    /// 拖到屏幕边缘后缩进去一半，鼠标靠近再探出来（见 dock.rs）
    pub edge_hide: bool,
    /// 用户这么多分钟没有键鼠操作，篝火变成余烬；0 为关闭（见 idle.rs）
    pub idle_ember_minutes: u32,
    /// 篝火动画速度的驱动指标，默认 CPU
    pub driver: DriverConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            window: WindowConfig::default(),
            character: "bonfire".into(),
            metrics: MetricsConfig::default(),
            modules: Vec::new(),
            runners: Vec::new(),
            update: UpdateConfig::default(),
            hide_on_fullscreen: true,
            edge_hide: true,
            idle_ember_minutes: 5,
            driver: DriverConfig::default(),
        }
    }
}

pub struct AppState(pub std::sync::RwLock<AppConfig>);

fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("config.json")
}

pub fn load_or_default(app: &AppHandle) -> AppConfig {
    let path = config_path(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // 从旧名称 catfloat 迁移配置
    if !path.exists() {
        if let Some(old) = path.parent().and_then(|d| d.parent()).map(|d| d.join("com.catfloat.app").join("config.json")) {
            let _ = std::fs::copy(old, &path);
        }
    }
    match std::fs::read(&path) {
        Ok(bytes) => {
            // 兼容带 BOM 的 UTF-8（PowerShell 等工具写入）
            let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&bytes);
            match serde_json::from_slice::<AppConfig>(bytes) {
                Ok(mut cfg) => {
                    // 旧版内置的猫 / 狗已移除
                    if cfg.character == "cat" || cfg.character == "dog" {
                        cfg.character = "bonfire".into();
                    }
                    // 配置文件可能被手工编辑过
                    cfg.driver = cfg.driver.clone().sanitized();
                    cfg
                }
                Err(_) => {
                    let _ = std::fs::rename(&path, path.with_extension("json.bak"));
                    AppConfig::default()
                }
            }
        }
        Err(_) => AppConfig::default(),
    }
}

pub fn save(app: &AppHandle, cfg: &AppConfig) {
    let path = config_path(app);
    let tmp = path.with_extension("json.tmp");
    if let Ok(json) = serde_json::to_vec_pretty(cfg) {
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

pub fn set_window_pos(app: &AppHandle, x: i32, y: i32) {
    let state = app.state::<AppState>();
    let mut cfg = state.0.write().unwrap();
    cfg.window.x = x;
    cfg.window.y = y;
    drop(cfg);
    DIRTY.store(true, Ordering::Relaxed);
}

/// 保存模块列表。若驱动指标指向的模块已被删除，驱动回退到 CPU，并返回回退后的驱动配置供调用方通知前端
pub fn set_modules(app: &AppHandle, modules: Vec<ModuleConfig>) -> Option<DriverConfig> {
    let state = app.state::<AppState>();
    let mut cfg = state.0.write().unwrap();
    cfg.modules = modules;
    let orphaned = cfg.driver.source == "module"
        && !cfg.driver.module_id.as_ref().is_some_and(|id| cfg.modules.iter().any(|m| &m.id == id));
    if orphaned {
        cfg.driver = DriverConfig::default();
    }
    let reset = orphaned.then(|| cfg.driver.clone());
    let snapshot = cfg.clone();
    drop(cfg);
    save(app, &snapshot);
    reset
}

/// 保存驱动指标，返回实际生效的配置（不合法的取值会被修正）
pub fn set_driver(app: &AppHandle, driver: DriverConfig) -> DriverConfig {
    let (applied, snapshot) = {
        let state = app.state::<AppState>();
        let mut cfg = state.0.write().unwrap();
        let mut driver = driver.sanitized();
        if driver.source == "module"
            && !driver.module_id.as_ref().is_some_and(|id| cfg.modules.iter().any(|m| &m.id == id))
        {
            driver = DriverConfig::default();
        }
        cfg.driver = driver.clone();
        (driver, cfg.clone())
    };
    save(app, &snapshot);
    applied
}

/// 驱动指标当前指向的模块 id（仅 source 为 module 时有值）
pub fn driver_module(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let cfg = state.0.read().unwrap();
    if cfg.driver.source == "module" {
        cfg.driver.module_id.clone()
    } else {
        None
    }
}

pub fn driver_source(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let source = state.0.read().unwrap().driver.source.clone();
    source
}

pub fn set_runners(app: &AppHandle, runners: Vec<RunnerConfig>) {
    let snapshot = {
        let state = app.state::<AppState>();
        let mut cfg = state.0.write().unwrap();
        cfg.runners = runners;
        // 当前选中的自定义角色被删除时回退到默认猫
        if let Some(id) = cfg.character.strip_prefix("custom:") {
            if !cfg.runners.iter().any(|r| r.id == id) {
                cfg.character = "bonfire".into();
            }
        }
        cfg.clone()
    };
    save(app, &snapshot);
}

pub fn set_character(app: &AppHandle, character: &str) {
    // 先释放写锁再保存：同一线程持有写锁时再取读锁会死锁（曾导致切换角色后程序卡死）
    let snapshot = {
        let state = app.state::<AppState>();
        let mut cfg = state.0.write().unwrap();
        cfg.character = character.to_string();
        cfg.clone()
    };
    save(app, &snapshot);
    use tauri::Emitter;
    let _ = app.emit("character://changed", character);
}

pub fn set_update(app: &AppHandle, f: impl FnOnce(&mut UpdateConfig)) {
    let snapshot = {
        let state = app.state::<AppState>();
        let mut cfg = state.0.write().unwrap();
        f(&mut cfg.update);
        cfg.clone()
    };
    save(app, &snapshot);
}

pub fn set_hide_on_fullscreen(app: &AppHandle, enabled: bool) {
    let snapshot = {
        let state = app.state::<AppState>();
        let mut cfg = state.0.write().unwrap();
        cfg.hide_on_fullscreen = enabled;
        cfg.clone()
    };
    save(app, &snapshot);
}

pub fn set_edge_hide(app: &AppHandle, enabled: bool) {
    let snapshot = {
        let state = app.state::<AppState>();
        let mut cfg = state.0.write().unwrap();
        cfg.edge_hide = enabled;
        cfg.clone()
    };
    save(app, &snapshot);
}

pub fn set_idle_ember_minutes(app: &AppHandle, minutes: u32) {
    let snapshot = {
        let state = app.state::<AppState>();
        let mut cfg = state.0.write().unwrap();
        cfg.idle_ember_minutes = minutes;
        cfg.clone()
    };
    save(app, &snapshot);
}

pub fn save_if_dirty(app: &AppHandle) {
    if DIRTY.swap(false, Ordering::Relaxed) {
        let cfg = app.state::<AppState>().0.read().unwrap().clone();
        save(app, &cfg);
    }
}
