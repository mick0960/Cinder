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
        }
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

pub fn set_modules(app: &AppHandle, modules: Vec<ModuleConfig>) {
    let state = app.state::<AppState>();
    let mut cfg = state.0.write().unwrap();
    cfg.modules = modules;
    let snapshot = cfg.clone();
    drop(cfg);
    save(app, &snapshot);
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

pub fn save_if_dirty(app: &AppHandle) {
    if DIRTY.swap(false, Ordering::Relaxed) {
        let cfg = app.state::<AppState>().0.read().unwrap().clone();
        save(app, &cfg);
    }
}
