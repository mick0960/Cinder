use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

use super::{AppConfig, RunnerConfig};

/// 传输给前端（`get_runners` / `save_runners` / `config://runners`）的完整角色数据，
/// 其中的 `frames` 为从 `<app_data_dir>/runners/<id>/` 读取并水合后的 `data:<mime>;base64,...` URL。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct RunnerPayload {
    pub id: String,
    pub name: String,
    pub frames: Vec<String>,
}

const B64_TABLE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// RFC 4648 标准 Base64 编码
pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(B64_TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64_TABLE[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_TABLE[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn b64_val(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// RFC 4648 标准 Base64 解码（忽略 ASCII 空白字符）
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.len() % 4 != 0 {
        return Err("base64 长度无效".into());
    }
    let mut out = Vec::with_capacity((bytes.len() / 4) * 3);
    let num_chunks = bytes.len() / 4;
    for (ci, chunk) in bytes.chunks_exact(4).enumerate() {
        let is_last = ci + 1 == num_chunks;
        let pad2 = chunk[2] == b'=';
        let pad3 = chunk[3] == b'=';
        if (pad2 || pad3) && !is_last {
            return Err("base64 填充符位置无效".into());
        }
        if pad2 && !pad3 {
            return Err("base64 填充格式无效".into());
        }
        let v0 = b64_val(chunk[0]).ok_or_else(|| "base64 包含非法字符".to_string())?;
        let v1 = b64_val(chunk[1]).ok_or_else(|| "base64 包含非法字符".to_string())?;
        let v2 = if pad2 {
            0
        } else {
            b64_val(chunk[2]).ok_or_else(|| "base64 包含非法字符".to_string())?
        };
        let v3 = if pad3 {
            0
        } else {
            b64_val(chunk[3]).ok_or_else(|| "base64 包含非法字符".to_string())?
        };
        out.push((v0 << 2) | (v1 >> 4));
        if !pad2 {
            out.push((v1 << 4) | (v2 >> 2));
        }
        if !pad3 {
            out.push((v2 << 6) | v3);
        }
    }
    Ok(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(input: &str) -> Vec<u8> {
    let raw = input.as_bytes();
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let (Some(h), Some(l)) = (hex_val(raw[i + 1]), hex_val(raw[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

/// 校验 runner id：仅允许 `[A-Za-z0-9_-]`，非空且不超过 64 个字符，防止路径穿越
pub fn sanitize_id(id: &str) -> Option<String> {
    if id.is_empty() || id.len() > 64 {
        return None;
    }
    if id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Some(id.to_string())
    } else {
        None
    }
}

fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// 解析图片 data URL，返回 `(扩展名, 原始字节)`。
/// 支持 `data:image/<subtype>;base64,<b64>` 以及非 base64 的 URL 编码 `data:image/svg+xml,...`
pub fn parse_data_url(url: &str) -> Result<(String, Vec<u8>), String> {
    let url = url.trim();
    let prefix = url
        .get(..5)
        .ok_or_else(|| "无效的 data URL".to_string())?;
    if !prefix.eq_ignore_ascii_case("data:") {
        return Err("无效的 data URL".into());
    }
    let rest = &url[5..];
    let (meta, payload) = rest
        .split_once(',')
        .ok_or_else(|| "data URL 缺少逗号分隔符".to_string())?;

    let mut parts = meta.split(';').map(str::trim);
    let media_type = parts.next().unwrap_or("").to_ascii_lowercase();
    let subtype = media_type
        .strip_prefix("image/")
        .ok_or_else(|| format!("不支持的 MIME 类型：{media_type}"))?;

    let ext = match subtype {
        "png" => "png",
        "gif" => "gif",
        "jpeg" | "jpg" => "jpg",
        "webp" => "webp",
        "svg+xml" => "svg",
        "bmp" => "bmp",
        "x-icon" => "ico",
        other => return Err(format!("不支持的图片格式：image/{other}")),
    };

    let is_base64 = parts.any(|p| p.eq_ignore_ascii_case("base64"));
    let bytes = if is_base64 {
        base64_decode(payload)?
    } else if ext == "svg" {
        percent_decode(payload)
    } else {
        return Err("图片数据必须为 base64 编码".into());
    };

    if bytes.is_empty() {
        return Err("图片数据为空".into());
    }
    Ok((ext.to_string(), bytes))
}

pub fn ext_to_mime(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn to_data_url(ext: &str, bytes: &[u8]) -> String {
    format!("data:{};base64,{}", ext_to_mime(ext), base64_encode(bytes))
}

/// 若旧版 `config.json` 中仍有内嵌 `frames`（base64 data URL），一次性将其落盘到
/// `<app_dir>/runners/<id>/<idx:02>.<ext>` 并清空 `frames`，返回是否发生了迁移。
pub fn migrate_if_needed(app_dir: &Path, cfg: &mut AppConfig) -> bool {
    if !cfg.runners.iter().any(|r| !r.frames.is_empty()) {
        return false;
    }
    let runners_root = app_dir.join("runners");
    let mut changed = false;
    for runner in &mut cfg.runners {
        if runner.frames.is_empty() {
            continue;
        }
        changed = true;
        let Some(safe_id) = sanitize_id(&runner.id) else {
            runner.frames.clear();
            continue;
        };
        let dir = runners_root.join(&safe_id);
        if std::fs::create_dir_all(&dir).is_err() {
            runner.frames.clear();
            continue;
        }
        let mut files = Vec::with_capacity(runner.frames.len());
        for (idx, frame) in runner.frames.iter().enumerate() {
            let Ok((ext, bytes)) = parse_data_url(frame) else {
                continue;
            };
            let filename = format!("{idx:02}.{ext}");
            if std::fs::write(dir.join(&filename), &bytes).is_ok() {
                files.push(filename);
            }
        }
        runner.frame_files = files;
        runner.frames.clear();
    }
    changed
}

/// 从磁盘读取各角色的图片帧并水合为前端可直接渲染的 `RunnerPayload`。
/// 单个缺失或损坏的文件会被跳过，不影响其它帧与其它角色。
pub fn load_all(app_dir: &Path, runners: &[RunnerConfig]) -> Vec<RunnerPayload> {
    let runners_root = app_dir.join("runners");
    runners
        .iter()
        .map(|r| {
            let mut frames = Vec::new();
            if let Some(safe_id) = sanitize_id(&r.id) {
                let dir = runners_root.join(&safe_id);
                for file in &r.frame_files {
                    if !is_safe_filename(file) {
                        continue;
                    }
                    if let Ok(bytes) = std::fs::read(dir.join(file)) {
                        if bytes.is_empty() {
                            continue;
                        }
                        let ext = Path::new(file)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("");
                        frames.push(to_data_url(ext, &bytes));
                    }
                }
            }
            RunnerPayload {
                id: r.id.clone(),
                name: r.name.clone(),
                frames,
            }
        })
        .collect()
}

struct PreparedRunner {
    id: String,
    name: String,
    files: Vec<(String, String, Vec<u8>)>,
}

/// 将前端提交的角色帧写入 `<app_dir>/runners/<id>/`，清理已移除的旧帧和已删除角色的目录，
/// 并返回 `(精简元数据列表, 水合后的 RunnerPayload 列表)`。
pub fn save_all(
    app_dir: &Path,
    incoming: Vec<RunnerPayload>,
) -> Result<(Vec<RunnerConfig>, Vec<RunnerPayload>), String> {
    let mut kept_ids = HashSet::with_capacity(incoming.len());
    let mut prepared = Vec::with_capacity(incoming.len());

    for r in incoming {
        let id = sanitize_id(&r.id).ok_or_else(|| format!("无效的角色 ID：{}", r.id))?;
        if !kept_ids.insert(id.clone()) {
            return Err(format!("重复的角色 ID：{id}"));
        }
        let mut files = Vec::with_capacity(r.frames.len());
        for (idx, frame) in r.frames.iter().enumerate() {
            let (ext, bytes) = parse_data_url(frame)?;
            let filename = format!("{idx:02}.{ext}");
            files.push((filename, ext, bytes));
        }
        prepared.push(PreparedRunner {
            id,
            name: r.name,
            files,
        });
    }

    let runners_root = app_dir.join("runners");
    if !prepared.is_empty() {
        std::fs::create_dir_all(&runners_root).map_err(|e| e.to_string())?;
    }

    let mut meta_list = Vec::with_capacity(prepared.len());
    let mut hydrated = Vec::with_capacity(prepared.len());

    for p in prepared {
        let dir = runners_root.join(&p.id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        let mut expected_files = HashSet::with_capacity(p.files.len());
        let mut frame_files = Vec::with_capacity(p.files.len());
        let mut hydrated_frames = Vec::with_capacity(p.files.len());

        for (filename, ext, bytes) in p.files {
            std::fs::write(dir.join(&filename), &bytes).map_err(|e| e.to_string())?;
            hydrated_frames.push(to_data_url(&ext, &bytes));
            expected_files.insert(filename.clone());
            frame_files.push(filename);
        }

        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if !expected_files.contains(name_str.as_ref()) {
                    let path = entry.path();
                    if path.is_dir() {
                        let _ = std::fs::remove_dir_all(&path);
                    } else {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }

        meta_list.push(RunnerConfig {
            id: p.id.clone(),
            name: p.name.clone(),
            frame_files,
            frames: Vec::new(),
        });
        hydrated.push(RunnerPayload {
            id: p.id,
            name: p.name,
            frames: hydrated_frames,
        });
    }

    if runners_root.exists() {
        if let Ok(entries) = std::fs::read_dir(&runners_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if !kept_ids.contains(name_str.as_ref()) {
                        let _ = std::fs::remove_dir_all(&path);
                    }
                }
            }
        }
    }

    Ok((meta_list, hydrated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "cinder_runners_test_{}_{}_{}",
                std::process::id(),
                label,
                n
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn base64_roundtrip_and_invalid_inputs() {
        let cases: &[(&[u8], &str)] = &[
            (b"", ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ];
        for &(raw, expected) in cases {
            let enc = base64_encode(raw);
            assert_eq!(enc, expected);
            assert_eq!(base64_decode(&enc).unwrap(), raw);
        }
        let all_bytes: Vec<u8> = (0..=255).collect();
        let enc = base64_encode(&all_bytes);
        assert_eq!(base64_decode(&enc).unwrap(), all_bytes);
        assert_eq!(base64_decode("Zm9v\n YmFy ").unwrap(), b"foobar");

        assert!(base64_decode("A").is_err());
        assert!(base64_decode("AB=").is_err());
        assert!(base64_decode("A=BC").is_err());
        assert!(base64_decode("Zm=v").is_err());
        assert!(base64_decode("Zm9v====Zm9v").is_err());
        assert!(base64_decode("Zm9!").is_err());
    }

    #[test]
    fn data_url_parsing_formats() {
        let png = b"\x89PNG\r\n\x1a\npngdata";
        let gif = b"GIF89a\x01\x00";
        let jpg = b"\xff\xd8\xff\xe0jpgdata";
        let webp = b"RIFF\x00\x00\x00\x00WEBP";
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>";

        let u_png = format!("data:image/png;base64,{}", base64_encode(png));
        let u_gif = format!("data:image/gif;base64,{}", base64_encode(gif));
        let u_jpg = format!("data:image/jpeg;base64,{}", base64_encode(jpg));
        let u_jpg2 = format!("data:image/jpg;base64,{}", base64_encode(jpg));
        let u_webp = format!("data:image/webp;base64,{}", base64_encode(webp));
        let u_svg_b64 = format!("data:image/svg+xml;base64,{}", base64_encode(svg));
        let u_svg_enc =
            "data:image/svg+xml;charset=utf-8,%3Csvg%20width%3D%2210%22%20height%3D%2210%22/%3E";
        let u_bmp = format!("data:image/bmp;base64,{}", base64_encode(b"BM1234"));
        let u_ico = format!("data:image/x-icon;base64,{}", base64_encode(b"\x00\x00\x01\x00"));

        assert_eq!(parse_data_url(&u_png).unwrap(), ("png".into(), png.to_vec()));
        assert_eq!(parse_data_url(&u_gif).unwrap(), ("gif".into(), gif.to_vec()));
        assert_eq!(parse_data_url(&u_jpg).unwrap(), ("jpg".into(), jpg.to_vec()));
        assert_eq!(parse_data_url(&u_jpg2).unwrap(), ("jpg".into(), jpg.to_vec()));
        assert_eq!(parse_data_url(&u_webp).unwrap(), ("webp".into(), webp.to_vec()));
        assert_eq!(parse_data_url(&u_svg_b64).unwrap(), ("svg".into(), svg.to_vec()));
        assert_eq!(
            parse_data_url(u_svg_enc).unwrap(),
            ("svg".into(), b"<svg width=\"10\" height=\"10\"/>".to_vec())
        );
        assert_eq!(parse_data_url(&u_bmp).unwrap(), ("bmp".into(), b"BM1234".to_vec()));
        assert_eq!(
            parse_data_url(&u_ico).unwrap(),
            ("ico".into(), b"\x00\x00\x01\x00".to_vec())
        );

        assert!(parse_data_url("https://example.com/a.png").is_err());
        assert!(parse_data_url("data:text/plain;base64,SGVsbG8=").is_err());
        assert!(parse_data_url("data:image/png,not-base64").is_err());
        assert!(parse_data_url("data:image/png;base64,").is_err());
    }

    #[test]
    fn sanitize_id_rejects_traversal() {
        assert_eq!(sanitize_id("r1731987654321"), Some("r1731987654321".into()));
        assert_eq!(sanitize_id("cat_01-A"), Some("cat_01-A".into()));
        assert_eq!(sanitize_id(&"a".repeat(64)), Some("a".repeat(64)));

        assert_eq!(sanitize_id(""), None);
        assert_eq!(sanitize_id(&"a".repeat(65)), None);
        assert_eq!(sanitize_id("."), None);
        assert_eq!(sanitize_id(".."), None);
        assert_eq!(sanitize_id("../evil"), None);
        assert_eq!(sanitize_id("a/b"), None);
        assert_eq!(sanitize_id("a\\b"), None);
        assert_eq!(sanitize_id("a.b"), None);
        assert_eq!(sanitize_id("a b"), None);

        let tmp = TempDir::new("traversal");
        let err = save_all(
            &tmp.0,
            vec![RunnerPayload {
                id: "../evil".into(),
                name: "bad".into(),
                frames: vec![format!("data:image/png;base64,{}", base64_encode(b"png"))],
            }],
        );
        assert!(err.is_err());
        assert!(!tmp.0.join("runners").exists());
    }

    #[test]
    fn legacy_migration_writes_files_clears_frames_and_hydrates() {
        let tmp = TempDir::new("migrate");
        let f_png = format!("data:image/png;base64,{}", base64_encode(b"\x89PNGframe0"));
        let f_gif = format!("data:image/gif;base64,{}", base64_encode(b"GIF89aframe1"));
        let f_jpg = format!("data:image/jpeg;base64,{}", base64_encode(b"\xff\xd8jpgframe2"));
        let f_webp = format!("data:image/webp;base64,{}", base64_encode(b"RIFFWEBP3"));
        let f_svg = format!("data:image/svg+xml;base64,{}", base64_encode(b"<svg/>"));

        let legacy_json = serde_json::json!({
            "character": "custom:r1",
            "runners": [{
                "id": "r1",
                "name": "小狐狸",
                "frames": [f_png, f_gif, f_jpg, f_webp, f_svg]
            }]
        });
        let mut cfg: AppConfig = serde_json::from_value(legacy_json).unwrap();
        assert_eq!(cfg.runners[0].frames.len(), 5);

        assert!(migrate_if_needed(&tmp.0, &mut cfg));
        assert!(!migrate_if_needed(&tmp.0, &mut cfg));

        assert!(cfg.runners[0].frames.is_empty());
        assert_eq!(
            cfg.runners[0].frame_files,
            vec!["00.png", "01.gif", "02.jpg", "03.webp", "04.svg"]
        );

        // 序列化后的 slim config.json 不含 base64 或 frames 字段
        let slim = serde_json::to_string(&cfg).unwrap();
        assert!(slim.contains("frameFiles"));
        assert!(!slim.contains("\"frames\""));
        assert!(!slim.contains("data:image"));

        for f in &cfg.runners[0].frame_files {
            assert!(tmp.0.join("runners").join("r1").join(f).is_file());
        }

        // 水合结果与原始 data URL 完全一致
        let hydrated = load_all(&tmp.0, &cfg.runners);
        assert_eq!(hydrated.len(), 1);
        assert_eq!(hydrated[0].id, "r1");
        assert_eq!(hydrated[0].name, "小狐狸");
        assert_eq!(
            hydrated[0].frames,
            vec![
                f_png.clone(),
                f_gif,
                f_jpg.clone(),
                f_webp.clone(),
                f_svg.clone()
            ]
        );

        // 缺失某帧文件时跳过该帧而不是报错
        std::fs::remove_file(tmp.0.join("runners/r1/01.gif")).unwrap();
        let partial = load_all(&tmp.0, &cfg.runners);
        assert_eq!(partial[0].frames, vec![f_png, f_jpg, f_webp, f_svg]);
    }

    #[test]
    fn save_all_cleans_stale_frames_and_removes_deleted_runner_dir() {
        let tmp = TempDir::new("save_del");
        let f0 = format!("data:image/png;base64,{}", base64_encode(b"png0"));
        let f1 = format!("data:image/png;base64,{}", base64_encode(b"png1"));
        let f2 = format!("data:image/gif;base64,{}", base64_encode(b"gif0"));

        let (meta, hydrated) = save_all(
            &tmp.0,
            vec![
                RunnerPayload {
                    id: "r1".into(),
                    name: "One".into(),
                    frames: vec![f0.clone(), f1.clone()],
                },
                RunnerPayload {
                    id: "r2".into(),
                    name: "Two".into(),
                    frames: vec![f2.clone()],
                },
            ],
        )
        .unwrap();

        assert_eq!(meta.len(), 2);
        assert!(meta.iter().all(|m| m.frames.is_empty()));
        assert_eq!(meta[0].frame_files, vec!["00.png", "01.png"]);
        assert_eq!(meta[1].frame_files, vec!["00.gif"]);
        assert_eq!(hydrated[0].frames, vec![f0, f1]);
        assert!(tmp.0.join("runners/r1/00.png").is_file());
        assert!(tmp.0.join("runners/r1/01.png").is_file());
        assert!(tmp.0.join("runners/r2/00.gif").is_file());

        // 删除 r2，并把 r1 改为仅 1 帧 GIF
        let (meta2, hydrated2) = save_all(
            &tmp.0,
            vec![RunnerPayload {
                id: "r1".into(),
                name: "One".into(),
                frames: vec![f2.clone()],
            }],
        )
        .unwrap();

        assert_eq!(meta2.len(), 1);
        assert_eq!(meta2[0].frame_files, vec!["00.gif"]);
        assert_eq!(hydrated2[0].frames, vec![f2]);
        assert!(tmp.0.join("runners/r1/00.gif").is_file());
        assert!(!tmp.0.join("runners/r1/00.png").exists());
        assert!(!tmp.0.join("runners/r1/01.png").exists());
        assert!(!tmp.0.join("runners/r2").exists());

        // 清空所有角色时删除最后一个角色目录
        let (meta3, hydrated3) = save_all(&tmp.0, vec![]).unwrap();
        assert!(meta3.is_empty());
        assert!(hydrated3.is_empty());
        assert!(!tmp.0.join("runners/r1").exists());
    }
}
