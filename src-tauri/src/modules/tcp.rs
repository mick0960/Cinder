//! 原生 TCP 模块：建立一次 TCP 连接测量握手延迟（支持 IPv4 / IPv6 / 域名），不经过 shell。

use std::io::ErrorKind;
use std::time::{Duration, Instant};

use tokio::net::TcpStream;

use super::Reading;
use crate::config::ModuleConfig;

pub async fn fetch(cfg: &ModuleConfig) -> Result<Reading, String> {
    let raw = cfg.host.trim();
    let host = raw
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .filter(|s| s.parse::<std::net::Ipv6Addr>().is_ok())
        .unwrap_or(raw);
    if host.is_empty() {
        return Err("主机为空".into());
    }
    if cfg.port == 0 {
        return Err("端口无效（需为 1~65535）".into());
    }
    let timeout = Duration::from_millis(cfg.timeout_ms.clamp(200, 60_000));
    let started = Instant::now();
    match tokio::time::timeout(timeout, TcpStream::connect((host, cfg.port))).await {
        Ok(Ok(stream)) => {
            drop(stream);
            let ms = started.elapsed().as_millis() as u64;
            let text = if ms == 0 { "<1".into() } else { ms.to_string() };
            Ok(Reading { text, num: Some(ms as f64) })
        }
        Err(_) => Err(format!("连接超时 ({} ms)", timeout.as_millis())),
        Ok(Err(e)) => Err(match e.kind() {
            ErrorKind::ConnectionRefused => "端口未监听（连接被拒绝）".into(),
            ErrorKind::HostUnreachable => "目标主机不可达".into(),
            ErrorKind::NetworkUnreachable => "网络不可达".into(),
            ErrorKind::TimedOut => "连接超时".into(),
            _ => format!("连接失败：{e}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connects_to_local_listener() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accept = tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        let cfg = ModuleConfig {
            kind: "tcp".into(),
            host: "127.0.0.1".into(),
            port,
            timeout_ms: 2000,
            ..Default::default()
        };
        let r = fetch(&cfg).await.unwrap();
        let _ = accept.await;
        assert!(r.num.is_some());
        assert!(r.text == "<1" || r.text.parse::<u64>().is_ok(), "{}", r.text);
    }

    #[tokio::test]
    async fn rejects_empty_host_and_zero_port() {
        let empty_host = ModuleConfig {
            kind: "tcp".into(),
            host: "   ".into(),
            port: 80,
            ..Default::default()
        };
        assert_eq!(fetch(&empty_host).await.unwrap_err(), "主机为空");

        let zero_port = ModuleConfig {
            kind: "tcp".into(),
            host: "127.0.0.1".into(),
            port: 0,
            ..Default::default()
        };
        assert!(fetch(&zero_port).await.unwrap_err().contains("端口无效"));
    }

    #[tokio::test]
    async fn closed_localhost_port_reports_connection_refused() {
        // Windows 上拒绝本机端口要约 2 秒才返回，超时要给足
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let cfg = ModuleConfig {
            kind: "tcp".into(),
            host: "127.0.0.1".into(),
            port,
            timeout_ms: 8000,
            ..Default::default()
        };
        let err = fetch(&cfg).await.unwrap_err();
        assert!(err.contains("端口未监听"), "{err}");
    }
}
