use tauri::menu::{CheckMenuItemBuilder, ContextMenu, MenuBuilder, SubmenuBuilder};
use tauri::Manager;

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
    let cat = CheckMenuItemBuilder::with_id("char:cat", "猫")
        .checked(cur_char == "cat")
        .build(app)?;
    let dog = CheckMenuItemBuilder::with_id("char:dog", "狗")
        .checked(cur_char == "dog")
        .build(app)?;
    let chars = SubmenuBuilder::new(app, "角色").item(&cat).item(&dog).build()?;

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
    .build()?;
    Ok(())
}
