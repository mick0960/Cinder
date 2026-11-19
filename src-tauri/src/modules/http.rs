//! 原生 HTTP 模块：支持 GET / HEAD / POST、自定义请求头、响应头提取与直连/跳过 TLS 校验。不经过 shell，按连接选项共用连接池。

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::Value;

use super::value::extract_num;
use super::Reading;
use crate::config::ModuleConfig;

/// 响应正文上限，防止误填了下载地址
const MAX_BODY: usize = 1024 * 1024;
/// 没有填 JSON 路径时，直接显示响应文本的最大长度
const MAX_TEXT_CHARS: usize = 200;

fn client(no_proxy: bool, insecure: bool) -> Result<&'static reqwest::Client, String> {
    static NORMAL: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    static NO_PROXY: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    static INSECURE: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    static NO_PROXY_INSECURE: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

    let slot = match (no_proxy, insecure) {
        (false, false) => &NORMAL,
        (true, false) => &NO_PROXY,
        (false, true) => &INSECURE,
        (true, true) => &NO_PROXY_INSECURE,
    };

    slot.get_or_init(|| {
        // 与更新插件共用进程级的加密提供者：谁先用到谁安装
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let mut builder = reqwest::Client::builder()
            .user_agent(concat!("Cinder/", env!("CARGO_PKG_VERSION")));
        if no_proxy {
            builder = builder.no_proxy();
        }
        if insecure {
            builder = builder.tls_danger_accept_invalid_certs(true);
        }
        builder
            .build()
            .map_err(|e| format!("无法初始化 HTTP 客户端: {e}"))
    })
    .as_ref()
    .map_err(Clone::clone)
}

fn parse_method(raw: &str) -> Result<reqwest::Method, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(reqwest::Method::GET);
    }
    match trimmed.to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "HEAD" => Ok(reqwest::Method::HEAD),
        "POST" => Ok(reqwest::Method::POST),
        other => Err(format!("不支持的请求方法：{other}")),
    }
}

fn build_headers(cfg: &ModuleConfig, method: &reqwest::Method) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    for row in &cfg.http_headers {
        let name_raw = row.name.trim();
        if name_raw.is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(name_raw.as_bytes())
            .map_err(|_| format!("请求头名称无效：{name_raw}"))?;
        // 绝不在错误消息中回显请求头的值，避免面板或日志泄露密钥
        let value = HeaderValue::from_str(&row.value)
            .map_err(|_| format!("请求头 {name_raw} 的值格式无效"))?;
        headers.insert(name, value);
    }
    if !headers.contains_key(ACCEPT) {
        headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/plain, */*"));
    }
    if *method == reqwest::Method::POST
        && !cfg.http_body.is_empty()
        && !headers.contains_key(CONTENT_TYPE)
    {
        let trimmed = cfg.http_body.trim();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
    }
    Ok(headers)
}

fn parse_response_header(raw: &str) -> Result<Option<(&str, HeaderName)>, String> {
    let target = raw.trim();
    if target.is_empty() {
        return Ok(None);
    }
    let name = HeaderName::from_bytes(target.as_bytes())
        .map_err(|_| format!("响应头名称无效：{target}"))?;
    Ok(Some((target, name)))
}

pub async fn fetch(cfg: &ModuleConfig) -> Result<Reading, String> {
    let url = parse_url(&cfg.url)?;
    let method = parse_method(&cfg.http_method)?;
    let headers = build_headers(cfg, &method)?;
    let resp_header = parse_response_header(&cfg.http_response_header)?;
    let timeout = Duration::from_millis(cfg.timeout_ms.clamp(500, 60_000));
    let client = client(cfg.http_no_proxy, cfg.http_insecure)?;

    let mut req = client.request(method.clone(), url).headers(headers);
    if method == reqwest::Method::POST && !cfg.http_body.is_empty() {
        req = req.body(cfg.http_body.clone());
    }

    let request = async {
        let mut resp = req.send().await.map_err(describe)?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        if let Some((target, header_name)) = resp_header {
            let val = resp
                .headers()
                .get(&header_name)
                .ok_or_else(|| format!("响应头缺少 {target}"))?;
            let header_text = super::decode::decode(val.as_bytes());
            return reading_from_body(&header_text, &cfg.json_path);
        }
        if method == reqwest::Method::HEAD {
            let code = status.as_u16();
            return Ok(Reading {
                text: code.to_string(),
                num: Some(code as f64),
            });
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(describe)? {
            if body.len() + chunk.len() > MAX_BODY {
                return Err("响应超过 1 MB".to_string());
            }
            body.extend_from_slice(&chunk);
        }
        reading_from_body(&super::decode::decode(&body), &cfg.json_path)
    };
    // 整个请求（含读取正文）共用一个超时
    match tokio::time::timeout(timeout, request).await {
        Ok(res) => res,
        Err(_) => Err(format!("超时 ({} ms)", timeout.as_millis())),
    }
}

/// 校验并解析网址；点击动作的“打开网址”也用同一套规则
pub fn parse_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "网址格式不正确".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("网址必须以 http:// 或 https:// 开头".into());
    }
    Ok(url)
}

/// 把 reqwest 的错误整理成一句中文。错误里的网址（可能带密钥参数）一律去掉，因为它会显示在面板的提示里
fn describe(e: reqwest::Error) -> String {
    use std::error::Error;
    let e = e.without_url();
    if e.is_timeout() {
        return "请求超时".into();
    }
    let mut parts = vec![e.to_string()];
    let mut source = e.source();
    while let Some(s) = source {
        parts.push(s.to_string());
        source = s.source();
    }
    // 最深一层通常是真正的原因（DNS 失败、证书无效、连接被拒绝……）
    let cause = parts.last().cloned().unwrap_or_default();
    if e.is_connect() {
        format!("无法连接：{cause}")
    } else {
        format!("请求失败：{cause}")
    }
}

fn reading_from_body(body: &str, json_path: &str) -> Result<Reading, String> {
    let path = json_path.trim();
    if path.is_empty() {
        let text: String = body.trim().chars().take(MAX_TEXT_CHARS).collect();
        if text.is_empty() {
            return Err("响应为空".into());
        }
        let num = extract_num(&text);
        return Ok(Reading { text, num });
    }
    let json: Value = serde_json::from_str(body.trim_start_matches('\u{feff}').trim())
        .map_err(|_| "响应不是有效的 JSON".to_string())?;
    let segs = parse_path(path)?;
    let found = lookup(&json, &segs).ok_or_else(|| format!("找不到字段 {path}"))?;
    scalar(found, path)
}

fn scalar(v: &Value, path: &str) -> Result<Reading, String> {
    match v {
        Value::Number(n) => {
            let f = n.as_f64().filter(|f| f.is_finite()).ok_or_else(|| format!("字段 {path} 不是有效的数字"))?;
            Ok(Reading { text: fmt_num(f), num: Some(f) })
        }
        Value::String(s) => {
            let text: String = s.trim().chars().take(MAX_TEXT_CHARS).collect();
            let num = extract_num(&text);
            Ok(Reading { text, num })
        }
        Value::Bool(b) => Ok(Reading { text: b.to_string(), num: None }),
        Value::Null => Err(format!("字段 {path} 的值为 null")),
        Value::Array(_) | Value::Object(_) => Err(format!("字段 {path} 是对象或数组，请把路径写到具体的值")),
    }
}

/// 整数不带小数点；小数最多保留 2 位（绝对值小于 1 时 3 位），去掉末尾的 0
pub fn fmt_num(n: f64) -> String {
    if n == n.trunc() && n.abs() < 1e15 {
        return format!("{}", n as i64);
    }
    let digits = if n.abs() < 1.0 { 3 } else { 2 };
    let s = format!("{n:.digits$}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" || s == "-0" { "0".into() } else { s.to_string() }
}

#[derive(Debug, PartialEq)]
enum Seg {
    Key(String),
    Index(i64),
}

/// 解析字段路径：`a.b[0].c`、`$.data.items[-1]`、`["key.with.dots"]`、`items.0.name`
fn parse_path(path: &str) -> Result<Vec<Seg>, String> {
    let p = path.trim();
    let p = p.strip_prefix('$').unwrap_or(p);
    let chars: Vec<char> = p.chars().collect();
    let mut segs = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '.' => i += 1,
            '[' => {
                i += 1;
                if matches!(chars.get(i), Some('"' | '\'')) {
                    let quote = chars[i];
                    i += 1;
                    let start = i;
                    while i < chars.len() && chars[i] != quote {
                        i += 1;
                    }
                    if i >= chars.len() {
                        return Err("路径里的引号没有闭合".into());
                    }
                    segs.push(Seg::Key(chars[start..i].iter().collect()));
                    i += 1;
                    if chars.get(i) != Some(&']') {
                        return Err("路径里缺少 ]".into());
                    }
                    i += 1;
                } else {
                    let start = i;
                    while i < chars.len() && chars[i] != ']' {
                        i += 1;
                    }
                    if i >= chars.len() {
                        return Err("路径里缺少 ]".into());
                    }
                    let text: String = chars[start..i].iter().collect();
                    let idx = text.trim().parse::<i64>().map_err(|_| format!("[{text}] 不是有效的数组下标"))?;
                    segs.push(Seg::Index(idx));
                    i += 1;
                }
            }
            _ => {
                let start = i;
                while i < chars.len() && chars[i] != '.' && chars[i] != '[' {
                    i += 1;
                }
                let key: String = chars[start..i].iter().collect();
                segs.push(Seg::Key(key.trim().to_string()));
            }
        }
    }
    if segs.is_empty() {
        return Err("字段路径为空".into());
    }
    Ok(segs)
}

fn lookup<'a>(root: &'a Value, segs: &[Seg]) -> Option<&'a Value> {
    let mut cur = root;
    for seg in segs {
        cur = match (seg, cur) {
            (Seg::Key(k), Value::Object(m)) => m.get(k)?,
            // 对数组写数字键（items.0.name）等同于下标
            (Seg::Key(k), Value::Array(a)) => a.get(k.parse::<usize>().ok()?)?,
            (Seg::Index(i), Value::Array(a)) => {
                let idx = if *i < 0 { a.len() as i64 + *i } else { *i };
                a.get(usize::try_from(idx).ok()?)?
            }
            _ => return None,
        };
    }
    Some(cur)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(body: &str, path: &str) -> Result<(String, Option<f64>), String> {
        reading_from_body(body, path).map(|r| (r.text, r.num))
    }

    #[test]
    fn paths() {
        assert_eq!(parse_path("a.b[0].c"), Ok(vec![Seg::Key("a".into()), Seg::Key("b".into()), Seg::Index(0), Seg::Key("c".into())]));
        assert_eq!(parse_path("$.data.items[-1]"), Ok(vec![Seg::Key("data".into()), Seg::Key("items".into()), Seg::Index(-1)]));
        assert_eq!(parse_path("$['a.b'][\"c d\"]"), Ok(vec![Seg::Key("a.b".into()), Seg::Key("c d".into())]));
        assert!(parse_path("a[x]").is_err());
        assert!(parse_path("a['b").is_err());
        assert!(parse_path("a[1").is_err());
        assert!(parse_path("$").is_err());
    }

    #[test]
    fn extracts_scalars() {
        let body = r#"{"ip":"1.2.3.4","data":{"items":[{"v":12.5},{"v":7}],"ok":true,"temp":"61 °C","n":null,"deep":{"a":1}}}"#;
        assert_eq!(read(body, "ip"), Ok(("1.2.3.4".into(), Some(1.2))));
        assert_eq!(read(body, "data.items[0].v"), Ok(("12.5".into(), Some(12.5))));
        assert_eq!(read(body, "data.items[-1].v"), Ok(("7".into(), Some(7.0))));
        assert_eq!(read(body, "data.items.1.v"), Ok(("7".into(), Some(7.0))));
        assert_eq!(read(body, "$.data.ok"), Ok(("true".into(), None)));
        assert_eq!(read(body, "data.temp"), Ok(("61 °C".into(), Some(61.0))));
        assert!(read(body, "data.n").unwrap_err().contains("null"));
        assert!(read(body, "data.deep").unwrap_err().contains("对象或数组"));
        assert!(read(body, "data.missing").unwrap_err().contains("找不到字段"));
        assert!(read(body, "data.items[9]").unwrap_err().contains("找不到字段"));
        assert!(read("<html>", "a").unwrap_err().contains("JSON"));
    }

    #[test]
    fn plain_text_body_when_no_path() {
        assert_eq!(read("  203.0.113.7\n", ""), Ok(("203.0.113.7".into(), Some(203.0))));
        assert!(read("   ", "").is_err());
        let long = "x".repeat(500);
        assert_eq!(read(&long, "").unwrap().0.chars().count(), MAX_TEXT_CHARS);
    }

    #[test]
    fn bom_is_tolerated() {
        assert_eq!(read("\u{feff}{\"a\":3}", "a"), Ok(("3".into(), Some(3.0))));
    }

    #[test]
    fn number_formatting() {
        assert_eq!(fmt_num(23.0), "23");
        assert_eq!(fmt_num(23.456), "23.46");
        assert_eq!(fmt_num(23.5), "23.5");
        assert_eq!(fmt_num(0.0004), "0");
        assert_eq!(fmt_num(0.1234), "0.123");
        assert_eq!(fmt_num(-5.0), "-5");
        assert_eq!(fmt_num(-0.0001), "0");
    }

    #[test]
    fn url_validation() {
        assert!(parse_url("https://api.example.com/x?y=1").is_ok());
        assert!(parse_url(" http://127.0.0.1:8080/ ").is_ok());
        assert!(parse_url("file:///c:/windows/system32/calc.exe").is_err());
        assert!(parse_url("ms-msdt:/id").is_err());
        assert!(parse_url("javascript:alert(1)").is_err());
        assert!(parse_url("example.com").is_err());
        assert!(parse_url("").is_err());
    }

    /// 起一个只应答一次的本地 HTTP 服务，走完整的 reqwest 请求路径
    #[tokio::test]
    async fn fetches_json_from_local_server() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let n = sock.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = r#"{"data":{"value":42.5}}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
            req
        });
        let cfg = ModuleConfig {
            kind: "http".into(),
            url: format!("http://127.0.0.1:{port}/metrics?token=secret"),
            json_path: "data.value".into(),
            timeout_ms: 3000,
            ..Default::default()
        };
        let r = fetch(&cfg).await.unwrap();
        assert_eq!((r.text.as_str(), r.num), ("42.5", Some(42.5)));
        let req = server.await.unwrap();
        assert!(req.starts_with("GET /metrics?token=secret HTTP/1.1"), "{req}");
        assert!(req.to_lowercase().contains("user-agent: cinder/"), "{req}");
    }

    async fn spawn_server(response: impl Into<String>) -> (u16, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = response.into();
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 2048];
            loop {
                let n = sock.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                    let content_len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + content_len {
                        break;
                    }
                }
            }
            sock.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf).into_owned()
        });
        (port, handle)
    }

    #[tokio::test]
    async fn head_custom_ua_and_response_header_extraction() {
        use crate::config::HttpHeader;
        let (port, server) = spawn_server(
            "HTTP/1.1 200 OK\r\nsubscription-userinfo: upload=1024; download=2048; total=4096\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let cfg = ModuleConfig {
            kind: "http".into(),
            url: format!("http://127.0.0.1:{port}/sub"),
            http_method: " head ".into(),
            http_headers: vec![HttpHeader {
                name: "User-Agent".into(),
                value: "CustomProbe/2.0".into(),
            }],
            http_response_header: "Subscription-Userinfo".into(),
            timeout_ms: 3000,
            ..Default::default()
        };
        let r = fetch(&cfg).await.unwrap();
        assert_eq!(r.text, "upload=1024; download=2048; total=4096");
        assert_eq!(r.num, Some(1024.0));
        let req = server.await.unwrap();
        let lower = req.to_ascii_lowercase();
        assert!(req.starts_with("HEAD /sub HTTP/1.1"), "{req}");
        assert!(lower.contains("user-agent: customprobe/2.0\r\n"), "{req}");
        assert!(!lower.contains("cinder/"), "{req}");
    }

    #[tokio::test]
    async fn head_without_response_header_returns_status_code() {
        let (port, server) = spawn_server("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await;
        let cfg = ModuleConfig {
            kind: "http".into(),
            url: format!("http://127.0.0.1:{port}/health"),
            http_method: "HEAD".into(),
            timeout_ms: 3000,
            ..Default::default()
        };
        let r = fetch(&cfg).await.unwrap();
        assert_eq!((r.text.as_str(), r.num), ("204", Some(204.0)));
        let req = server.await.unwrap();
        assert!(req.starts_with("HEAD /health HTTP/1.1"), "{req}");
    }

    #[tokio::test]
    async fn post_json_body_with_custom_header_and_json_path() {
        use crate::config::HttpHeader;
        let resp_body = r#"{"result":{"count":7}}"#;
        let (port, server) = spawn_server(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
            resp_body.len()
        ))
        .await;
        let req_body = r#"{"query":"status"}"#;
        let cfg = ModuleConfig {
            kind: "http".into(),
            url: format!("http://127.0.0.1:{port}/api"),
            http_method: "POST".into(),
            http_headers: vec![
                HttpHeader { name: "  ".into(), value: "ignored".into() },
                HttpHeader { name: "x-api-key".into(), value: "secret-key-999".into() },
            ],
            http_body: req_body.into(),
            json_path: "result.count".into(),
            timeout_ms: 3000,
            ..Default::default()
        };
        let r = fetch(&cfg).await.unwrap();
        assert_eq!((r.text.as_str(), r.num), ("7", Some(7.0)));
        let req = server.await.unwrap();
        let lower = req.to_ascii_lowercase();
        assert!(req.starts_with("POST /api HTTP/1.1"), "{req}");
        assert!(lower.contains("x-api-key: secret-key-999\r\n"), "{req}");
        assert!(lower.contains("content-type: application/json\r\n"), "{req}");
        assert!(req.ends_with(req_body), "{req}");
    }

    #[tokio::test]
    async fn missing_response_header_returns_clear_error() {
        let (port, _server) =
            spawn_server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await;
        let cfg = ModuleConfig {
            kind: "http".into(),
            url: format!("http://127.0.0.1:{port}/"),
            http_response_header: "X-Missing-Header".into(),
            timeout_ms: 3000,
            ..Default::default()
        };
        let err = fetch(&cfg).await.unwrap_err();
        assert!(err.contains("响应头缺少 X-Missing-Header"), "{err}");
    }

    #[tokio::test]
    async fn invalid_header_value_does_not_leak_secret() {
        use crate::config::HttpHeader;
        let cfg = ModuleConfig {
            kind: "http".into(),
            url: "http://127.0.0.1:1/unused".into(),
            http_headers: vec![HttpHeader {
                name: "Authorization".into(),
                value: "Bearer super-secret-value\n".into(),
            }],
            ..Default::default()
        };
        let err = fetch(&cfg).await.unwrap_err();
        assert!(err.contains("Authorization"), "{err}");
        assert!(!err.contains("super-secret-value"), "{err}");
    }

    #[tokio::test]
    async fn no_proxy_client_reaches_local_server() {
        let (port, _server) =
            spawn_server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n42").await;
        let cfg = ModuleConfig {
            kind: "http".into(),
            url: format!("http://127.0.0.1:{port}/local"),
            http_no_proxy: true,
            timeout_ms: 3000,
            ..Default::default()
        };
        let r = fetch(&cfg).await.unwrap();
        assert_eq!((r.text.as_str(), r.num), ("42", Some(42.0)));
    }

    #[tokio::test]
    async fn unsupported_method_returns_chinese_error() {
        let cfg = ModuleConfig {
            kind: "http".into(),
            url: "http://127.0.0.1:1/unused".into(),
            http_method: "DELETE".into(),
            ..Default::default()
        };
        let err = fetch(&cfg).await.unwrap_err();
        assert!(err.contains("不支持的请求方法：DELETE"), "{err}");
    }

    #[tokio::test]
    async fn reports_http_errors_without_leaking_the_url() {
        // 没有任何服务监听的端口：连接被拒绝。Windows 上拒绝本机端口要约 2 秒才返回，超时要给足
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let cfg = ModuleConfig {
            kind: "http".into(),
            url: format!("http://127.0.0.1:{port}/secret-path?token=abc"),
            timeout_ms: 8000,
            ..Default::default()
        };
        let err = fetch(&cfg).await.unwrap_err();
        assert!(!err.contains("secret-path") && !err.contains("token"), "{err}");
        assert!(err.contains("无法连接") || err.contains("请求失败"), "{err}");
    }
}
