//! 原生 Ping 模块：通过 Windows 的 ICMP 接口（IcmpSendEcho）测量到主机的往返延迟。
//! 不启动 ping.exe / PowerShell，也不需要管理员权限；目前只支持 IPv4。

use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::ptr::null;
use std::time::Duration;

use windows_sys::Win32::Foundation::{GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY,
};

use super::Reading;
use crate::config::ModuleConfig;

const PAYLOAD: [u8; 32] = [b'a'; 32];

pub async fn fetch(cfg: &ModuleConfig) -> Result<Reading, String> {
    let host = cfg.host.trim().to_string();
    if host.is_empty() {
        return Err("主机为空".into());
    }
    let timeout_ms = cfg.timeout_ms.clamp(500, 60_000) as u32;
    // 域名解析和 ICMP 都是阻塞调用：放到阻塞线程里，外层再套一层超时，
    // 解析卡住时也不会拖住模块循环（被放弃的线程自己会在系统超时后退出）
    let job = tauri::async_runtime::spawn_blocking(move || ping(&host, timeout_ms));
    let rtt = match tokio::time::timeout(Duration::from_millis(timeout_ms as u64 + 1500), job).await {
        Ok(Ok(res)) => res?,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err("请求超时".into()),
    };
    // 不足 1 毫秒时系统返回 0
    let text = if rtt == 0 { "<1".to_string() } else { rtt.to_string() };
    Ok(Reading { text, num: Some(rtt as f64) })
}

fn resolve_v4(host: &str) -> Result<Ipv4Addr, String> {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Ok(ip);
    }
    if host.parse::<std::net::Ipv6Addr>().is_ok() {
        return Err("暂不支持 IPv6 地址".into());
    }
    (host, 0u16)
        .to_socket_addrs()
        .map_err(|_| format!("无法解析主机 {host}"))?
        .find_map(|a| match a.ip() {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        })
        .ok_or_else(|| format!("{host} 没有 IPv4 地址"))
}

/// 发送一个 ICMP 回显请求，返回往返毫秒数
fn ping(host: &str, timeout_ms: u32) -> Result<u32, String> {
    let dest = resolve_v4(host)?;
    // in_addr 在内存里是网络字节序，即 a.b.c.d 依次排列
    let addr = u32::from_ne_bytes(dest.octets());
    // 文档要求回复缓冲区容纳 ICMP_ECHO_REPLY + 载荷 + 8 字节 ICMP 错误 + IO_STATUS_BLOCK；
    // 用 u64 保证 8 字节对齐
    let mut reply = vec![0u64; 128];
    unsafe {
        let handle = IcmpCreateFile();
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!("无法创建 ICMP 句柄（错误 {}）", GetLastError()));
        }
        let n = IcmpSendEcho(
            handle,
            addr,
            PAYLOAD.as_ptr().cast(),
            PAYLOAD.len() as u16,
            null(),
            reply.as_mut_ptr().cast(),
            (reply.len() * size_of::<u64>()) as u32,
            timeout_ms,
        );
        let last_error = GetLastError();
        IcmpCloseHandle(handle);
        if n == 0 {
            return Err(status_text(last_error));
        }
        let echo = &*(reply.as_ptr() as *const ICMP_ECHO_REPLY);
        if echo.Status != 0 {
            return Err(status_text(echo.Status));
        }
        Ok(echo.RoundTripTime)
    }
}

/// IP_STATUS 常量（ipexport.h）
fn status_text(code: u32) -> String {
    match code {
        11002 => "目标网络不可达".into(),
        11003 => "目标主机不可达".into(),
        11004 | 11005 => "目标端口不可达".into(),
        11010 => "请求超时".into(),
        11013 | 11014 => "TTL 已过期".into(),
        11050 => "常规故障".into(),
        other => format!("Ping 失败（错误 {other}）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_literals() {
        assert_eq!(resolve_v4("127.0.0.1"), Ok(Ipv4Addr::LOCALHOST));
        assert!(resolve_v4("::1").unwrap_err().contains("IPv6"));
        assert!(resolve_v4("definitely-not-a-real-host.invalid").is_err());
    }

    #[test]
    fn pings_loopback() {
        let rtt = ping("127.0.0.1", 2000).expect("loopback should answer");
        assert!(rtt < 100, "loopback rtt {rtt} ms");
    }

    #[tokio::test]
    async fn fetch_formats_sub_millisecond_replies() {
        let cfg = ModuleConfig { kind: "ping".into(), host: "127.0.0.1".into(), timeout_ms: 2000, ..Default::default() };
        let r = fetch(&cfg).await.unwrap();
        assert!(r.num.is_some());
        assert!(r.text == "<1" || r.text.parse::<u32>().is_ok(), "{}", r.text);
    }

    #[tokio::test]
    async fn fetch_rejects_empty_host() {
        let cfg = ModuleConfig { kind: "ping".into(), host: "  ".into(), ..Default::default() };
        assert!(fetch(&cfg).await.is_err());
    }
}
