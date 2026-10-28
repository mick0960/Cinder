use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

use crate::config::ModuleConfig;

pub async fn run_command(cfg: &ModuleConfig) -> Result<String, String> {
    let mut cmd = build(&cfg.shell, &cfg.command)?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        // 错误信息（如“找不到 nvidia-smi”）只在命令失败时用来提示原因
        .stderr(Stdio::piped())
        // future 被丢弃（超时 / 模块重载）时兜底杀掉子进程
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let timeout = Duration::from_millis(cfg.timeout_ms.clamp(500, 60000));

    let child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;
    let pid = child.id();

    // wait_with_output 会并发读取 stdout / stderr 与等待退出，
    // 避免输出超过管道缓冲区时子进程阻塞在写入上、直到超时
    let fut = child.wait_with_output();
    tokio::pin!(fut);
    tokio::select! {
        res = &mut fut => {
            let out = res.map_err(|e| e.to_string())?;
            if !out.status.success() {
                let code = out.status.code().unwrap_or(-1);
                return Err(match first_line(&out.stderr) {
                    Some(why) => format!("退出码 {code}：{why}"),
                    None => format!("退出码 {code}"),
                });
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

/// 输出里第一行非空文本（过长截断），用于错误提示
pub fn first_line(bytes: &[u8]) -> Option<String> {
    let text = crate::modules::decode::decode(bytes);
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.chars().take(160).collect())
}

#[cfg(windows)]
pub async fn kill_tree(pid: u32) {
    let mut k = Command::new("taskkill");
    k.args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let _ = tokio::time::timeout(Duration::from_secs(3), k.status()).await;
}

#[cfg(not(windows))]
pub async fn kill_tree(_pid: u32) {}

/// 按 shell 类型构造命令。模块轮询、常驻进程和点击动作共用
pub fn build(shell: &str, command: &str) -> Result<Command, String> {
    let mut cmd = Command::new("cmd");
    match shell {
        "powershell" => {
            cmd = Command::new("powershell");
            cmd.arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-Command")
                .arg(format!(
                    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; {command}"
                ));
        }
        "pwsh" => {
            cmd = Command::new("pwsh");
            cmd.arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-Command")
                .arg(format!(
                    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; {command}"
                ));
        }
        "cmd" => {
            // cmd.exe 不遵循 CommandLineToArgvW 的转义规则：普通的 .arg() 会把命令里的引号转义成 \"，cmd 不认，
            // 带引号的路径（"C:\Program Files\..."）就会报语法错误。
            // 所以原样交给它：/S 让 cmd 只剥掉最外层的一对引号，里面的内容完全保留
            #[cfg(windows)]
            cmd.raw_arg("/S").raw_arg("/C").raw_arg(format!("\"{command}\""));
            #[cfg(not(windows))]
            cmd.arg("/C").arg(command);
        }
        "direct" => {
            let mut parts = command.split_whitespace();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd_module(command: &str) -> ModuleConfig {
        ModuleConfig { kind: "command".into(), shell: "cmd".into(), command: command.into(), ..Default::default() }
    }

    /// cmd.exe 不遵循 CommandLineToArgvW 的转义规则：带引号的命令必须原样交给它
    #[tokio::test]
    async fn cmd_shell_receives_quotes_verbatim() {
        let out = run_command(&cmd_module(r#"echo "hello world""#)).await.unwrap();
        assert_eq!(out.trim(), r#""hello world""#);
    }

    #[tokio::test]
    async fn cmd_shell_can_redirect_into_a_quoted_path_with_spaces() {
        let dir = std::env::temp_dir().join("cinder runner test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("out file.txt");
        let _ = std::fs::remove_file(&file);
        run_command(&cmd_module(&format!(r#"echo clicked> "{}""#, file.display()))).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap().trim(), "clicked");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cmd_shell_still_handles_plain_commands_and_builtins() {
        assert_eq!(run_command(&cmd_module("echo plain text here")).await.unwrap().trim(), "plain text here");
        // "echo a & echo b" 输出两行（a 后面带一个空格），逐行去掉行尾空白再比较
        let out = run_command(&cmd_module("echo a & echo b")).await.unwrap();
        assert_eq!(out.lines().map(str::trim_end).collect::<Vec<_>>(), ["a", "b"]);
    }
}
