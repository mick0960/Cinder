use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, State, Window};

use crate::config::{self, AppState, ModuleConfig, RunnerConfig};
use crate::menu;
use crate::metrics;
use crate::modules;

#[tauri::command]
pub fn get_config(state: State<AppState>) -> config::AppConfig {
    state.0.read().unwrap().clone()
}

#[tauri::command]
pub fn set_panel_open(app: AppHandle, open: bool) {
    metrics::set_panel_open(&app, open);
}

#[tauri::command]
pub fn popup_widget_menu(app: AppHandle, window: Window) -> Result<(), String> {
    menu::popup(&app, window).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = menu::open_settings(&handle);
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_modules(app: AppHandle, modules: Vec<ModuleConfig>) -> Result<(), String> {
    config::set_modules(&app, modules.clone());
    modules::reload(&app);
    // 通知悬浮窗刷新模块列表，无需重启
    let _ = app.emit_to("widget", "config://modules", &modules);
    Ok(())
}

#[tauri::command]
pub fn save_runners(app: AppHandle, runners: Vec<RunnerConfig>) -> Result<(), String> {
    config::set_runners(&app, runners.clone());
    let current = app.state::<AppState>().0.read().unwrap().character.clone();
    let _ = app.emit("config://runners", &runners);
    let _ = app.emit("character://changed", current);
    Ok(())
}

#[tauri::command]
pub fn set_character(app: AppHandle, character: String) {
    config::set_character(&app, &character);
}

#[tauri::command]
pub async fn test_module(cfg: ModuleConfig) -> Result<serde_json::Value, String> {
    let t = Instant::now();
    let res = modules::runner::run_command(&cfg).await;
    let ms = t.elapsed().as_millis() as u64;
    Ok(match res {
        Ok(raw) => serde_json::json!({
            "ok": true,
            "ms": ms,
            "output": modules::parse_output(&cfg, raw),
        }),
        Err(e) => serde_json::json!({
            "ok": false,
            "ms": ms,
            "error": e,
        }),
    })
}
