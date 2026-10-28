//! 原生 HTTP 模块：GET 一个网址，按 JSON 字段路径取值。不经过 shell，所有 HTTP 模块共用一个连接池。

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;

use super::value::extract_num;
use super::Reading;
use crate::config::ModuleConfig;

/// 响应正文上限，防止误填了下载地址
const MAX_BODY: usize = 1024 * 1024;
/// 没有填 JSON 路径时，直接显示响应文本的最大长度
const MAX_TEXT_CHARS: usize = 200;

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // 与更新插件共用进程级的加密提供者：谁先用到谁安装
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                let _ = rustls::crypto::ring::default_provider().install_default();
            }
            reqwest::Client::builder()
                .user_agent(concat!("Cinder/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| format!("无法初始化 HTTP 客户端: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub async fn fetch(cfg: &ModuleConfig) -> Result<Reading, String> {
    let url = parse_url(&cfg.url)?;
    let timeout = Duration::from_millis(cfg.timeout_ms.clamp(500, 60_000));
    let client = client()?;

    let request = async {
        let mut resp = client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
            .send()
            .await
            .map_err(describe)?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(describe)? {
            if body.len() + chunk.len() > MAX_BODY {
                return Err("响应超过 1 MB".to_string());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    };
    // 整个请求（含读取正文）共用一个超时
    let body = match tokio::time::timeout(timeout, request).await {
        Ok(res) => res?,
        Err(_) => return Err(format!("超时 ({} ms)", timeout.as_millis())),
    };
    reading_from_body(&super::decode::decode(&body), &cfg.json_path)
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
