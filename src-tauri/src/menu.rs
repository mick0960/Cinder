use tauri::menu::{CheckMenuItemBuilder, ContextMenu, MenuBuilder, SubmenuBuilder};
use tauri::Manager;

/// 与 tauri.conf.json 里 widget 窗口的 additionalBrowserArgs 保持同步
pub const WEBVIEW_ARGS: &str =
    "--disable-gpu --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

pub fn popup(app: &tauri::AppHandle, window: tauri::Window) -> tauri::Result<()> {
    let on_top = window.is_always_on_top().unwrap_or(true);
    let top = CheckMenuItemBuilder::with_id("toggle_top", "置顶")
        .checked(on_top)
        .build(app)?;

    let cur_char = {
        let state = app.state::<crate::config::AppState>();
        let ch = state.0.read().unwrap().character.clone();
        ch
    };
    let mut entries = vec![
        ("char:cat".to_string(), "猫".to_string()),
        ("char:dog".to_string(), "狗".to_string()),
    ];
    {
        let state = app.state::<crate::config::AppState>();
        let cfg = state.0.read().unwrap();
        for r in &cfg.runners {
            entries.push((format!("char:custom:{}", r.id), r.name.clone()));
        }
    }
    let mut chars = SubmenuBuilder::new(app, "角色");
    for (id, name) in &entries {
        let checked = id.strip_prefix("char:") == Some(cur_char.as_str());
        let item = CheckMenuItemBuilder::with_id(id.as_str(), name.as_str())
            .checked(checked)
            .build(app)?;
        chars = chars.item(&item);
    }
    let chars = chars.build()?;

    let menu = MenuBuilder::new(app)
        .item(&top)
        .item(&chars)
        .separator()
        .text("settings", "设置...")
        .text("exit", "退出")
        .build()?;
    menu.popup(window)?;
    Ok(())
}

pub fn open_settings(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("catfloat 设置")
    .inner_size(720.0, 520.0)
    .min_inner_size(560.0, 400.0)
    .resizable(true)
    // 深色标题栏 + 首帧背景色，避免打开时先闪一下白屏
    .theme(Some(tauri::Theme::Dark))
    .background_color(tauri::webview::Color(0x1e, 0x1e, 0x22, 0xff))
    // 必须与 tauri.conf.json 中悬浮窗的 additionalBrowserArgs 完全一致：
    // 同一进程内共用 WebView2 用户数据目录，启动参数不同会导致环境创建失败，设置窗口无法打开
    .additional_browser_args(WEBVIEW_ARGS)
    .build()?;
    Ok(())
}
