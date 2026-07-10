use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use url::Url;

const URL_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    pub url: String,
    pub path: String,
    pub filename: String,
    pub label: String,
    pub source_type: SourceType,
    pub source_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceType {
    PathList,
    AbsoluteUrl,
}

pub fn normalize_base_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let url = Url::parse(trimmed).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    let mut href = url.to_string();
    if !href.ends_with('/') {
        href.push('/');
    }
    Some(href)
}

pub fn parse_path_line(line: &str) -> Option<String> {
    let raw_line = line.trim();
    let path = raw_line.trim_matches(['"', '\'']);
    if raw_line.is_empty()
        || raw_line.starts_with('#')
        || raw_line.starts_with("//")
        || path.is_empty()
    {
        return None;
    }
    Some(path.to_string())
}

pub fn path_to_item(raw_line: &str, base_url: &str, output_root: &Path) -> Option<QueueItem> {
    let path = parse_path_line(raw_line)?;
    let source_key = format!("path-list:{}", raw_line.trim());

    if path.starts_with("http://") || path.starts_with("https://") {
        let storage_path = path_from_url(&path);
        let filename = output_root.join(sanitize_download_path(&storage_path));
        return Some(QueueItem {
            id: stable_item_id(&source_key),
            url: path.clone(),
            path: storage_path.clone(),
            filename: filename.to_string_lossy().to_string(),
            label: path,
            source_type: SourceType::AbsoluteUrl,
            source_key,
        });
    }

    let decoded_path = decode_path(&path);
    if has_parent_path_segment(&decoded_path) {
        return None;
    }

    let clean_path = normalize_storage_path(&decoded_path);
    if clean_path.is_empty() || clean_path.split('/').any(|part| part == "..") {
        return None;
    }

    let normalized_base = normalize_base_url(base_url)?;
    let url = join_url(&normalized_base, &clean_path);
    let filename = output_root.join(sanitize_download_path(&clean_path));
    Some(QueueItem {
        id: stable_item_id(&source_key),
        url,
        path: clean_path.clone(),
        filename: filename.to_string_lossy().to_string(),
        label: clean_path,
        source_type: SourceType::PathList,
        source_key,
    })
}

pub fn normalize_storage_path(value: &str) -> String {
    let path = sanitize_path(value);
    let marker = "/api/companies/";
    if let Some(marker_start) = path.to_lowercase().find(marker.trim_start_matches('/')) {
        let tail = &path[marker_start..];
        let parts: Vec<&str> = tail.split('/').collect();
        if let Some(files_index) = parts
            .iter()
            .position(|part| part.eq_ignore_ascii_case("files"))
        {
            return sanitize_path(&parts[files_index + 1..].join("/"));
        }
    }
    path
}

pub fn sanitize_path(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_start_matches('/')
        .split('/')
        .filter_map(|segment| {
            let clean = sanitize_path_segment(segment, false);
            if clean.is_empty() {
                None
            } else {
                Some(clean)
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub fn sanitize_download_path(value: &str) -> PathBuf {
    let parts = sanitize_path(value)
        .split('/')
        .map(|segment| sanitize_path_segment(segment, true))
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    parts.iter().collect()
}

fn sanitize_path_segment(segment: &str, for_download: bool) -> String {
    let mut clean = segment
        .trim()
        .chars()
        .map(|ch| match ch {
            '\u{0000}'..='\u{001f}'
            | '\u{007f}'..='\u{009f}'
            | '<'
            | '>'
            | ':'
            | '"'
            | '|'
            | '?'
            | '*' => '_',
            '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => '\0',
            other => other,
        })
        .filter(|ch| *ch != '\0')
        .collect::<String>();
    if for_download {
        clean = clean.trim_matches(['.', ' ']).to_string();
    }
    if clean.is_empty() || clean == "." || clean == ".." {
        clean = "_".to_string();
    }
    if is_windows_reserved_name(&clean) {
        clean = format!("_{}", clean);
    }
    clean
}

fn is_windows_reserved_name(value: &str) -> bool {
    let base = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    matches!(
        base.as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

fn has_parent_path_segment(value: &str) -> bool {
    value
        .replace('\\', "/")
        .split('/')
        .any(|segment| segment.trim() == "..")
}

fn join_url(base_url: &str, path: &str) -> String {
    let encoded = sanitize_path(path)
        .split('/')
        .map(encode_url_path_segment)
        .collect::<Vec<_>>()
        .join("/");
    format!("{}{}", base_url, encoded)
}

fn encode_url_path_segment(segment: &str) -> String {
    utf8_percent_encode(segment, URL_SEGMENT_ENCODE_SET)
        .to_string()
        .replace("%21", "!")
        .replace("%24", "$")
        .replace("%26", "&")
        .replace("%27", "'")
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%2A", "*")
        .replace("%2B", "+")
        .replace("%2C", ",")
        .replace("%3A", ":")
        .replace("%3B", ";")
        .replace("%3D", "=")
        .replace("%40", "@")
}

fn decode_path(path: &str) -> String {
    percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .map(|value| value.to_string())
        .unwrap_or_else(|_| path.to_string())
}

fn path_from_url(url: &str) -> String {
    Url::parse(url)
        .ok()
        .map(|parsed| normalize_storage_path(&decode_path(parsed.path())))
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| "download".to_string())
}

fn stable_item_id(source_key: &str) -> String {
    let mut hash = 2166136261u32;
    for byte in source_key.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("{:08x}", hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_to_item_encodes_path_like_extension() {
        let item = path_to_item(
            "/TATAELECTRONICS.CO.IN/TSATFS01/E/FC Equip/EQUIPMENT DOCUMENT & PM ACTIVITY/Laser Groove.xlsx",
            "https://host.test/api/companies/8541753929/storages/files",
            Path::new("/downloads"),
        )
        .unwrap();

        assert_eq!(item.path, "TATAELECTRONICS.CO.IN/TSATFS01/E/FC Equip/EQUIPMENT DOCUMENT & PM ACTIVITY/Laser Groove.xlsx");
        assert_eq!(item.url, "https://host.test/api/companies/8541753929/storages/files/TATAELECTRONICS.CO.IN/TSATFS01/E/FC%20Equip/EQUIPMENT%20DOCUMENT%20&%20PM%20ACTIVITY/Laser%20Groove.xlsx");
        assert!(item.filename.ends_with("TATAELECTRONICS.CO.IN/TSATFS01/E/FC Equip/EQUIPMENT DOCUMENT & PM ACTIVITY/Laser Groove.xlsx"));
    }

    #[test]
    fn path_to_item_rejects_parent_path_segments() {
        assert!(path_to_item(
            "../secret.txt",
            "https://host.test/files/",
            Path::new("/downloads")
        )
        .is_none());
    }
}
