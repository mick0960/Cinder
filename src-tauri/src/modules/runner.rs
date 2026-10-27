use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

use crate::config::ModuleConfig;

pub async fn run_command(cfg: &ModuleConfig) -> Result<String, String> {
    let mut cmd = build(cfg)?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // future 被丢弃（超时 / 模块重载）时兜底杀掉子进程
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let timeout = Duration::from_millis(cfg.timeout_ms.clamp(500, 60000));

    let child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;
    let pid = child.id();

    // wait_with_output 会并发读取 stdout 与等待退出，
    // 避免输出超过管道缓冲区时子进程阻塞在写入上、直到超时
    let fut = child.wait_with_output();
    tokio::pin!(fut);
    tokio::select! {
        res = &mut fut => {
            let out = res.map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(format!("退出码 {}", out.status.code().unwrap_or(-1)));
            }
            Ok(crate::modules::decode::decode(&out.stdout))
        }
        _ = tokio::time::sleep(timeout) => {
            // 必须在 fut（持有子进程）被释放之前结束整棵进程树：
            // 若 shell 先被 kill_on_drop 杀掉，taskkill /T 就找不到它的子进程了
            if let Some(pid) = pid {
                kill_tree(pid).await;
            }
            Err(format!("超时 ({} ms)", timeout.as_millis()))
        }
    }
}

#[cfg(windows)]
async fn kill_tree(pid: u32) {
    let mut k = Command::new("taskkill");
    k.args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let _ = tokio::time::timeout(Duration::from_secs(3), k.status()).await;
}

#[cfg(not(windows))]
async fn kill_tree(_pid: u32) {}

fn build(cfg: &ModuleConfig) -> Result<Command, String> {
    let mut cmd = Command::new("cmd");
    match cfg.shell.as_str() {
        "powershell" => {
            cmd = Command::new("powershell");
            cmd.arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-Command")
                .arg(format!(
                    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; {}",
                    cfg.command
                ));
        }
        "pwsh" => {
            cmd = Command::new("pwsh");
            cmd.arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-Command")
                .arg(format!(
                    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; {}",
                    cfg.command
                ));
        }
        "cmd" => {
            cmd.arg("/C").arg(&cfg.command);
        }
        "direct" => {
            let mut parts = cfg.command.split_whitespace();
            let program = parts.next().unwrap_or_default();
            if program.is_empty() {
                return Err("命令为空".into());
            }
            cmd = Command::new(program);
            for a in parts {
                cmd.arg(a);
            }
        }
        other => return Err(format!("未知 shell: {other}")),
    }
    Ok(cmd)
}
