//! 常驻进程模式：命令只启动一次，每输出一行就是一次更新。
//! 避免每次刷新都新启动一个 shell —— 进程启动造成的 CPU 尖峰正好会出现在面板的 CPU 曲线上。

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc;

use super::decode::decode;
use super::job::Job;
use super::runner;
use crate::config::ModuleConfig;

/// 单行输出的上限；超出部分丢弃，防止一直不换行的进程撑爆内存
const MAX_LINE: usize = 64 * 1024;
const STDERR_TAIL: usize = 2048;

/// 一个正在运行的常驻进程。丢弃它即结束整棵进程树。
pub struct LineStream {
    rx: mpsc::Receiver<String>,
    child: Child,
    /// 把进程树关在一起；创建 / 加入失败时退化为按 PID 结束进程树
    job: Option<Job>,
    pid: Option<u32>,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
    tasks: Vec<JoinHandle<()>>,
}

impl LineStream {
    pub fn spawn(cfg: &ModuleConfig) -> Result<Self, String> {
        let mut cmd = runner::build(&cfg.shell, &cfg.command)?;
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;
        let pid = child.id();
        let job = Job::new().filter(|j| j.assign(&child));

        let stdout = child.stdout.take().ok_or("无法读取进程输出")?;
        let stderr = child.stderr.take();

        let (tx, rx) = mpsc::channel::<String>(256);
        let mut tasks = Vec::new();
        tasks.push(tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                match read_line_bounded(&mut reader, &mut line, MAX_LINE).await {
                    Ok(true) => {
                        let text = decode(&line);
                        line.clear();
                        if tx.send(text).await.is_err() {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        }));

        // 必须有人读 stderr：管道写满后子进程会卡死在写入上
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut stderr) = stderr {
            let tail = stderr_tail.clone();
            tasks.push(tauri::async_runtime::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let mut t = tail.lock().unwrap();
                    t.extend_from_slice(&buf[..n]);
                    if t.len() > STDERR_TAIL {
                        let cut = t.len() - STDERR_TAIL;
                        t.drain(..cut);
                    }
                }
            }));
        }

        Ok(Self { rx, child, job, pid, stderr_tail, tasks })
    }

    /// 等待下一行输出；进程关闭了 stdout（通常是已退出）时返回 None
    pub async fn next_line(&mut self) -> Option<String> {
        self.rx.recv().await
    }

    /// 进程结束后的说明：退出码，以及 stderr 里最后一段有意义的文字
    pub async fn exit_message(&mut self) -> String {
        let code = match tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await {
            Ok(Ok(status)) => status.code().map_or_else(|| "?".to_string(), |c| c.to_string()),
            _ => "?".to_string(),
        };
        let tail = self.stderr_tail.lock().unwrap().clone();
        // PowerShell 的错误常是多行，头一行才是原因
        let why = runner::first_line(&tail);
        match why {
            Some(why) => format!("进程已退出（退出码 {code}）：{why}"),
            None => format!("进程已退出（退出码 {code}）"),
        }
    }
}

impl Drop for LineStream {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
        // 作业对象会在随后被丢弃时带走整棵进程树；没有作业对象时按 PID 结束进程树
        if self.job.is_none() {
            if let Some(pid) = self.pid {
                kill_tree_detached(pid);
            }
        }
        let _ = self.child.start_kill();
    }
}

#[cfg(windows)]
fn kill_tree_detached(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn();
}

#[cfg(not(windows))]
fn kill_tree_detached(_pid: u32) {}

/// 读一行（不含换行符）。返回 false 表示流已结束且没有残留内容。
/// 单行超过 `max` 字节时后面的部分被丢弃，但仍读到换行为止。
async fn read_line_bounded<R: AsyncBufRead + Unpin>(
    r: &mut R,
    out: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<bool> {
    let push = |out: &mut Vec<u8>, bytes: &[u8]| {
        let room = max.saturating_sub(out.len());
        out.extend_from_slice(&bytes[..bytes.len().min(room)]);
    };
    loop {
        let chunk = r.fill_buf().await?;
        if chunk.is_empty() {
            return Ok(!out.is_empty());
        }
        match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => {
                push(out, &chunk[..i]);
                r.consume(i + 1);
                if out.last() == Some(&b'\r') {
                    out.pop();
                }
                return Ok(true);
            }
            None => {
                let n = chunk.len();
                push(out, chunk);
                r.consume(n);
            }
        }
    }
}

/// 测试运行：启动进程，等第一行输出后立即结束它。返回原始的第一行文本。
pub async fn first_output(cfg: &ModuleConfig) -> Result<String, String> {
    let timeout = Duration::from_millis(cfg.timeout_ms.clamp(500, 600_000));
    let mut stream = LineStream::spawn(cfg)?;
    let wait = async {
        loop {
            match stream.next_line().await {
                Some(line) if line.trim().is_empty() => continue,
                Some(line) => return Ok(line),
                None => return Err(stream.exit_message().await),
            }
        }
    };
    match tokio::time::timeout(timeout, wait).await {
        Ok(res) => res,
        Err(_) => Err(format!("{} ms 内没有输出", timeout.as_millis())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running_pids() -> std::collections::HashSet<u32> {
        let out = std::process::Command::new("tasklist").args(["/FO", "CSV", "/NH"]).output().unwrap();
        // "ping.exe","1234","Console","1","4,000 K"
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.split("\",\"").nth(1)?.parse().ok())
            .collect()
    }

    fn child_pids(parent: u32) -> Vec<u32> {
        let script = format!("(Get-CimInstance Win32_Process -Filter 'ParentProcessId={parent}').ProcessId");
        let out = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &script]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect()
    }

    #[tokio::test]
    async fn dropping_the_stream_ends_the_whole_process_tree() {
        let cfg = ModuleConfig {
            shell: "cmd".into(),
            command: "ping -n 120 127.0.0.1".into(),
            persistent: true,
            ..Default::default()
        };
        let mut s = LineStream::spawn(&cfg).unwrap();
        assert!(s.job.is_some(), "the process should have been put into a job object");
        let pid = s.pid.unwrap();
        // 收到第一行时 ping.exe 已经在运行
        assert!(s.next_line().await.is_some());
        let kids = child_pids(pid);
        assert!(!kids.is_empty(), "cmd.exe should have started ping.exe");
        let alive = running_pids();
        assert!(alive.contains(&pid) && kids.iter().all(|k| alive.contains(k)));

        drop(s);
        tokio::time::sleep(Duration::from_millis(800)).await;
        let alive = running_pids();
        assert!(!alive.contains(&pid), "shell survived");
        for k in kids {
            assert!(!alive.contains(&k), "child process {k} survived");
        }
    }

    #[tokio::test]
    async fn bounded_line_reader_handles_crlf_eof_and_overlong_lines() {
        let data: &[u8] = b"one\r\ntwo\nlast-without-newline";
        let mut r = BufReader::new(data);
        let mut line = Vec::new();
        assert!(read_line_bounded(&mut r, &mut line, 64).await.unwrap());
        assert_eq!(line, b"one");
        line.clear();
        assert!(read_line_bounded(&mut r, &mut line, 64).await.unwrap());
        assert_eq!(line, b"two");
        line.clear();
        assert!(read_line_bounded(&mut r, &mut line, 64).await.unwrap());
        assert_eq!(line, b"last-without-newline");
        line.clear();
        assert!(!read_line_bounded(&mut r, &mut line, 64).await.unwrap());

        let long: &[u8] = b"abcdefghij\nnext\n";
        let mut r = BufReader::new(long);
        line.clear();
        assert!(read_line_bounded(&mut r, &mut line, 4).await.unwrap());
        assert_eq!(line, b"abcd");
        line.clear();
        assert!(read_line_bounded(&mut r, &mut line, 4).await.unwrap());
        assert_eq!(line, b"next");
    }
}
