//! 模块行的点击动作：打开网址，或运行一条命令。
//! 动作内容由后端按模块 id 从已保存的配置里取，前端只负责说“点了哪个模块”。

use std::process::Stdio;

use super::{http, runner};
use crate::config::ClickAction;

pub async fn run(click: &ClickAction) -> Result<(), String> {
    match click.kind.as_str() {
        "url" => open_url(&click.target),
        "command" => spawn_detached(click),
        other => Err(format!("未知的点击动作: {other}")),
    }
}

/// 用系统默认浏览器打开网址。只放行 http / https：
/// 其它协议（file:、ms-msdt: 等）会交给系统里对应的程序去执行，不能由一段配置文本随意触发。
pub fn open_url(raw: &str) -> Result<(), String> {
    let url = http::parse_url(raw)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 用规范化后的网址（空格、引号等已转义）作为单个参数传给 rundll32
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url.as_str()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开网址: {e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("仅支持 Windows".into())
    }
}

/// 启动命令后不等待、不接管输出：图形程序照常弹出自己的窗口
fn spawn_detached(click: &ClickAction) -> Result<(), String> {
    let command = click.target.trim();
    if command.is_empty() {
        return Err("命令为空".into());
    }
    let mut cmd = runner::build(&click.shell, command)?;
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.spawn().map(|_| ()).map_err(|e| format!("启动失败: {e}"))
}
