use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, CONNECTION, CONTENT_LENGTH,
    CONTENT_RANGE, RANGE, TE, UPGRADE_INSECURE_REQUESTS,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::fs::{self, File, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::time::sleep;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub id: String,
    pub url: String,
    pub final_path: PathBuf,
    pub proxy_url: Option<String>,
    pub metadata_cache_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub id: String,
    pub final_path: PathBuf,
    pub bytes_written: u64,
    pub resumed_from: u64,
    pub total_bytes: Option<u64>,
    pub session_bytes_written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub bytes_received: u64,
    pub total_bytes: Option<u64>,
    pub session_bytes_received: u64,
}

#[derive(Debug, Error)]
pub enum DownloadError {
    #[error("download failed for {url}: HTTP {status}")]
    HttpStatus {
        url: String,
        status: reqwest::StatusCode,
    },
    #[error(
        "server returned 416 but partial file size {part_size} does not match known total size"
    )]
    RangeNotSatisfiable { part_size: u64 },
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("file system error: {0}")]
    Io(#[from] std::io::Error),
    #[error("download returned 0 bytes but directory metadata reports {expected_size} bytes")]
    EmptyResponseHasContent { expected_size: u64 },
    #[error(
        "download returned 0 bytes and directory metadata could not verify it as an empty file"
    )]
    EmptyResponseUnverified,
    #[error("directory metadata error: {0}")]
    DirectoryMetadata(String),
    #[error("download cancelled")]
    Cancelled,
}

#[derive(Debug, Deserialize)]
struct DirectoryListing {
    #[serde(default)]
    path: String,
    #[serde(default)]
    dirs: Vec<DirectoryDirEntry>,
    #[serde(default)]
    files: Vec<DirectoryFileEntry>,
}

#[derive(Debug, Deserialize)]
struct DirectoryFileEntry {
    name: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct DirectoryDirEntry {
    name: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct MetadataSizeCache {
    entries: HashMap<String, CachedSizeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedSizeEntry {
    kind: String,
    size: u64,
}

pub type ProgressCallback = Arc<dyn Fn(DownloadProgress) + Send + Sync>;
pub type CancellationFlag = Arc<AtomicBool>;

pub fn default_proxy_url() -> String {
    "socks5h://127.0.0.1:9150".to_string()
}

const MAX_TRANSIENT_RETRIES: usize = 12;
const MAX_METADATA_REQUESTS: usize = 6;
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(500);

pub fn part_path_for(final_path: &Path) -> PathBuf {
    let mut name = final_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    name.push_str(".part");
    final_path.with_file_name(name)
}

pub fn build_client(
    proxy_url: Option<&str>,
    accept_invalid_certs: bool,
) -> Result<reqwest::Client, DownloadError> {
    let mut builder = reqwest::Client::builder()
        .http1_only()
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
        )
        .default_headers(browser_request_headers())
        .connect_timeout(std::time::Duration::from_secs(180))
        .read_timeout(std::time::Duration::from_secs(120));
    if accept_invalid_certs {
        builder = builder.danger_accept_invalid_certs(true);
    }
    if let Some(proxy_url) = proxy_url.filter(|value| !value.trim().is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy_url)?);
    }
    Ok(builder.build()?)
}

fn browser_request_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
    );
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.5"));
    headers.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
    headers.insert(UPGRADE_INSECURE_REQUESTS, HeaderValue::from_static("1"));
    headers.insert(
        HeaderName::from_static("sec-gpc"),
        HeaderValue::from_static("1"),
    );
    headers.insert(
        HeaderName::from_static("sec-fetch-dest"),
        HeaderValue::from_static("document"),
    );
    headers.insert(
        HeaderName::from_static("sec-fetch-mode"),
        HeaderValue::from_static("navigate"),
    );
    headers.insert(
        HeaderName::from_static("sec-fetch-site"),
        HeaderValue::from_static("none"),
    );
    headers.insert(
        HeaderName::from_static("sec-fetch-user"),
        HeaderValue::from_static("?1"),
    );
    headers.insert(
        HeaderName::from_static("priority"),
        HeaderValue::from_static("u=0, i"),
    );
    headers.insert(TE, HeaderValue::from_static("trailers"));
    headers
}

pub fn build_client_for_url(
    proxy_url: Option<&str>,
    url: &str,
) -> Result<reqwest::Client, DownloadError> {
    build_client(proxy_url, should_accept_invalid_certs(url))
}

pub async fn download_file(
    request: DownloadRequest,
    progress: Option<ProgressCallback>,
    cancellation: Option<CancellationFlag>,
) -> Result<DownloadResult, DownloadError> {
    if let Some(parent) = request.final_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    let part_path = part_path_for(&request.final_path);
    let client = build_client_for_url(request.proxy_url.as_deref(), &request.url)?;
    let expected_total_bytes = match directory_metadata_file_size(
        &client,
        &request.url,
        request.metadata_cache_path.as_deref(),
    )
    .await
    {
        Ok(size) => size,
        Err(error) => {
            eprintln!(
                "[native-download] metadata size lookup failed id={} error={:?}",
                request.id, error
            );
            None
        }
    };
    emit_progress(&progress, &request.id, 0, expected_total_bytes, 0);
    let mut attempt = 0usize;
    let mut session_bytes_written = 0_u64;

    loop {
        if cancellation
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            return Err(DownloadError::Cancelled);
        }

        let resumed_from = file_size(&part_path).await.unwrap_or(0);
        let mut http_request = client.get(&request.url);
        if resumed_from > 0 {
            http_request = http_request.header(RANGE, format!("bytes={}-", resumed_from));
        }

        let response = match http_request.send().await {
            Ok(response) => response,
            Err(error) if attempt < MAX_TRANSIENT_RETRIES => {
                attempt += 1;
                eprintln!(
                    "[native-download] request retry id={} attempt={} bytes={} error={:?}",
                    request.id, attempt, resumed_from, error
                );
                sleep(retry_delay(attempt)).await;
                continue;
            }
            Err(error) => return Err(DownloadError::Network(error)),
        };
        let status = response.status();
        eprintln!(
            "[native-download] response id={} attempt={} status={} content_length={:?} content_range={:?}",
            request.id,
            attempt,
            status,
            response.headers().get(CONTENT_LENGTH),
            response.headers().get(CONTENT_RANGE)
        );

        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            if request.final_path.exists() {
                let final_size = file_size(&request.final_path).await.unwrap_or(0);
                return Ok(DownloadResult {
                    id: request.id,
                    final_path: request.final_path,
                    bytes_written: final_size,
                    resumed_from,
                    total_bytes: Some(final_size),
                    session_bytes_written,
                });
            }
            return Err(DownloadError::RangeNotSatisfiable {
                part_size: resumed_from,
            });
        }

        if !status.is_success() {
            return Err(DownloadError::HttpStatus {
                url: request.url,
                status,
            });
        }

        let append = resumed_from > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
        let base_bytes = if append { resumed_from } else { 0 };
        let total_bytes = response_total_bytes(&response, base_bytes).or(expected_total_bytes);
        let mut file = open_part_file(&part_path, append).await?;
        let mut bytes_written = base_bytes;
        emit_progress(
            &progress,
            &request.id,
            bytes_written,
            total_bytes,
            session_bytes_written,
        );
        let mut stream = response.bytes_stream();
        let mut last_progress_emit = Instant::now() - PROGRESS_EMIT_INTERVAL;
        let mut stream_error = None;

        while let Some(chunk) = stream.next().await {
            if cancellation
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Relaxed))
            {
                return Err(DownloadError::Cancelled);
            }
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    stream_error = Some(error);
                    break;
                }
            };
            file.write_all(&chunk).await?;
            bytes_written += chunk.len() as u64;
            session_bytes_written += chunk.len() as u64;
            if attempt > 0 {
                attempt = 0;
            }
            if last_progress_emit.elapsed() >= PROGRESS_EMIT_INTERVAL {
                emit_progress(
                    &progress,
                    &request.id,
                    bytes_written,
                    total_bytes,
                    session_bytes_written,
                );
                last_progress_emit = Instant::now();
            }
        }
        emit_progress(
            &progress,
            &request.id,
            bytes_written,
            total_bytes,
            session_bytes_written,
        );
        file.flush().await?;
        drop(file);

        if let Some(error) = stream_error {
            if attempt < MAX_TRANSIENT_RETRIES && bytes_written > base_bytes {
                attempt += 1;
                eprintln!(
                    "[native-download] stream retry id={} attempt={} bytes={} error={:?}",
                    request.id, attempt, bytes_written, error
                );
                sleep(retry_delay(attempt)).await;
                continue;
            }
            return Err(DownloadError::Network(error));
        }

        if bytes_written == 0 {
            match expected_total_bytes {
                Some(0) => {}
                Some(expected_size) if attempt < MAX_TRANSIENT_RETRIES => {
                    attempt += 1;
                    eprintln!(
                        "[native-download] empty retry id={} attempt={} expected_size={}",
                        request.id, attempt, expected_size
                    );
                    let _ = fs::remove_file(&part_path).await;
                    sleep(retry_delay(attempt)).await;
                    continue;
                }
                Some(expected_size) => {
                    let _ = fs::remove_file(&part_path).await;
                    return Err(DownloadError::EmptyResponseHasContent { expected_size });
                }
                None if attempt < MAX_TRANSIENT_RETRIES => {
                    attempt += 1;
                    eprintln!(
                        "[native-download] empty retry id={} attempt={} metadata_unverified=true",
                        request.id, attempt
                    );
                    let _ = fs::remove_file(&part_path).await;
                    sleep(retry_delay(attempt)).await;
                    continue;
                }
                None => {
                    let _ = fs::remove_file(&part_path).await;
                    return Err(DownloadError::EmptyResponseUnverified);
                }
            }
        }

        fs::rename(&part_path, &request.final_path).await?;
        return Ok(DownloadResult {
            id: request.id,
            final_path: request.final_path,
            bytes_written,
            resumed_from: base_bytes,
            total_bytes,
            session_bytes_written,
        });
    }
}

fn retry_delay(attempt: usize) -> Duration {
    Duration::from_millis((attempt.min(6) as u64) * 750)
}

async fn directory_metadata_file_size(
    client: &reqwest::Client,
    file_url: &str,
    cache_path: Option<&Path>,
) -> Result<Option<u64>, DownloadError> {
    let Some((base_url, file_path)) = metadata_base_url_and_file_path(file_url) else {
        return Ok(None);
    };

    let entries = [("file", file_path.as_str())];
    Ok(
        resolve_metadata_sizes(client, &base_url, cache_path, &entries)
            .await?
            .into_iter()
            .next()
            .flatten(),
    )
}

pub async fn resolve_metadata_sizes(
    client: &reqwest::Client,
    base_file_url: &str,
    cache_path: Option<&Path>,
    entries: &[(&str, &str)],
) -> Result<Vec<Option<u64>>, DownloadError> {
    let mut cache = match cache_path {
        Some(path) => read_metadata_cache(path).await,
        None => MetadataSizeCache::default(),
    };
    let mut missing_parent_paths = Vec::new();
    let mut seen_parent_paths = HashSet::new();

    for (kind, entry_path) in entries {
        let key = cache_key(kind, entry_path);
        if let Some(entry) = cache.entries.get(&key) {
            eprintln!(
                "[native-download] metadata cache hit key={} size={}",
                key, entry.size
            );
            continue;
        }
        if !matches!(*kind, "file" | "dir") {
            continue;
        }
        let parent_path = parent_storage_path(entry_path);
        if seen_parent_paths.insert(parent_path.clone()) {
            missing_parent_paths.push(parent_path);
        }
    }

    let mut requests = Vec::with_capacity(missing_parent_paths.len());
    for parent_path in missing_parent_paths {
        let dir_url = directory_metadata_url(base_file_url, &parent_path)?;
        requests.push((parent_path, dir_url));
    }

    let fetches = futures_util::stream::iter(requests)
        .map(|(parent_path, dir_url)| async move {
            eprintln!(
                "[native-download] metadata cache miss; fetching dir url={}",
                dir_url
            );
            fetch_directory_metadata(client, &dir_url)
                .await
                .map(|listing| (parent_path, listing))
        })
        .buffer_unordered(MAX_METADATA_REQUESTS);
    tokio::pin!(fetches);

    let mut cache_changed = false;
    let mut first_error = None;
    while let Some(result) = fetches.next().await {
        let (parent_path, listing) = match result {
            Ok(value) => value,
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
                continue;
            }
        };
        cache_directory_metadata(&mut cache, listing, &parent_path);
        cache_changed = true;
    }

    if cache_changed {
        if let Some(cache_path) = cache_path {
            write_metadata_cache(cache_path, &cache).await?;
        }
    }

    if let Some(error) = first_error {
        return Err(error);
    }

    Ok(entries
        .iter()
        .map(|(kind, entry_path)| {
            cache
                .entries
                .get(&cache_key(kind, entry_path))
                .map(|entry| entry.size)
        })
        .collect())
}

async fn fetch_directory_metadata(
    client: &reqwest::Client,
    dir_url: &str,
) -> Result<DirectoryListing, DownloadError> {
    let response = client.get(dir_url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(DownloadError::HttpStatus {
            url: dir_url.to_string(),
            status,
        });
    }
    let body = response.bytes().await?;
    serde_json::from_slice::<DirectoryListing>(&body)
        .map_err(|error| DownloadError::DirectoryMetadata(error.to_string()))
}

fn cache_directory_metadata(
    cache: &mut MetadataSizeCache,
    listing: DirectoryListing,
    fallback_path: &str,
) {
    let listing_base_path = if listing.path.trim().is_empty() {
        normalize_cache_path(fallback_path)
    } else {
        normalize_cache_path(&listing.path)
    };

    for entry in listing.files {
        let entry_path = join_storage_path(&listing_base_path, &entry.name);
        let key = cache_key("file", &entry_path);
        cache.entries.insert(
            key,
            CachedSizeEntry {
                kind: "file".to_string(),
                size: entry.size,
            },
        );
    }
    for entry in listing.dirs {
        let entry_path = join_storage_path(&listing_base_path, &entry.name);
        cache.entries.insert(
            cache_key("dir", &entry_path),
            CachedSizeEntry {
                kind: "dir".to_string(),
                size: entry.size,
            },
        );
    }
}

async fn read_metadata_cache(path: &Path) -> MetadataSizeCache {
    let Ok(bytes) = fs::read(path).await else {
        return MetadataSizeCache::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub async fn cached_file_sizes(path: &Path, file_paths: &[String]) -> Vec<Option<u64>> {
    let entries = file_paths
        .iter()
        .map(|file_path| ("file", file_path.as_str()))
        .collect::<Vec<_>>();
    cached_metadata_sizes(path, &entries).await
}

pub async fn cached_metadata_sizes(path: &Path, entries: &[(&str, &str)]) -> Vec<Option<u64>> {
    let cache = read_metadata_cache(path).await;
    entries
        .iter()
        .map(|(kind, entry_path)| {
            cache
                .entries
                .get(&cache_key(kind, entry_path))
                .map(|entry| entry.size)
        })
        .collect()
}

async fn write_metadata_cache(path: &Path, cache: &MetadataSizeCache) -> Result<(), DownloadError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(cache)
        .map_err(|error| DownloadError::DirectoryMetadata(error.to_string()))?;
    fs::write(&tmp_path, bytes).await?;
    fs::rename(tmp_path, path).await?;
    Ok(())
}

fn metadata_base_url_and_file_path(file_url: &str) -> Option<(String, String)> {
    let (head, encoded_path) = file_url.split_once("/storages/files/")?;
    let file_path = percent_encoding::percent_decode_str(encoded_path)
        .decode_utf8_lossy()
        .to_string();
    Some((
        format!("{head}/storages/files/"),
        normalize_cache_path(&file_path),
    ))
}

#[cfg(test)]
fn directory_metadata_url_and_file_name(file_url: &str) -> Option<(String, String, String)> {
    let (base_url, file_path) = metadata_base_url_and_file_path(file_url)?;
    let parent_path = parent_storage_path(&file_path);
    let file_name = file_path.rsplit('/').next()?.to_string();
    Some((
        directory_metadata_url(&base_url, &parent_path).ok()?,
        parent_path,
        file_name,
    ))
}

fn directory_metadata_url(base_file_url: &str, parent_path: &str) -> Result<String, DownloadError> {
    let (head, _) = base_file_url
        .split_once("/storages/files/")
        .ok_or_else(|| {
            DownloadError::DirectoryMetadata("invalid storage files base URL".to_string())
        })?;
    let mut url = reqwest::Url::parse(&format!("{head}/storages/dirs/"))
        .map_err(|error| DownloadError::DirectoryMetadata(error.to_string()))?;
    if !parent_path.is_empty() {
        let mut segments = url.path_segments_mut().map_err(|_| {
            DownloadError::DirectoryMetadata("invalid directory metadata URL".to_string())
        })?;
        segments.pop_if_empty();
        for segment in normalize_cache_path(parent_path)
            .split('/')
            .filter(|value| !value.is_empty())
        {
            segments.push(segment);
        }
    }
    Ok(url.to_string())
}

fn parent_storage_path(path: &str) -> String {
    normalize_cache_path(path)
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

fn cache_key(kind: &str, path: &str) -> String {
    format!("{kind}:{}", normalize_cache_path(path))
}

fn join_storage_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        normalize_cache_path(name)
    } else {
        normalize_cache_path(&format!("{parent}/{name}"))
    }
}

fn normalize_cache_path(path: &str) -> String {
    path.trim().trim_start_matches('/').replace('\\', "/")
}

fn emit_progress(
    progress: &Option<ProgressCallback>,
    id: &str,
    bytes_received: u64,
    total_bytes: Option<u64>,
    session_bytes_received: u64,
) {
    if let Some(progress) = progress {
        progress(DownloadProgress {
            id: id.to_string(),
            bytes_received,
            total_bytes,
            session_bytes_received,
        });
    }
}

async fn open_part_file(path: &Path, append: bool) -> Result<File, std::io::Error> {
    if append {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await
    } else {
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)
            .await
    }
}

async fn file_size(path: &Path) -> Result<u64, std::io::Error> {
    Ok(fs::metadata(path).await?.len())
}

fn response_total_bytes(response: &reqwest::Response, base_bytes: u64) -> Option<u64> {
    if let Some(total) = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range_total)
    {
        return Some(total);
    }

    response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|length| base_bytes + length)
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    let (_, total) = value.rsplit_once('/')?;
    total.parse::<u64>().ok()
}

pub(crate) fn should_accept_invalid_certs(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("onion") || host.ends_with(".onion"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    #[test]
    fn part_path_appends_part_to_leaf_name() {
        assert_eq!(
            part_path_for(Path::new("/tmp/folder/file.xlsx")),
            PathBuf::from("/tmp/folder/file.xlsx.part")
        );
    }

    #[test]
    fn content_range_total_is_parsed() {
        assert_eq!(
            parse_content_range_total("bytes 1000-106230211/106230211"),
            Some(106230211)
        );
    }

    #[test]
    fn invalid_certificates_are_only_allowed_for_https_onion_urls() {
        assert!(should_accept_invalid_certs("https://example.onion/file"));
        assert!(should_accept_invalid_certs(
            "https://worldleaksartrjm3c6vasllvgacbi5u3mgzkluehrzhk2jz4taufuid.onion/file"
        ));
        assert!(!should_accept_invalid_certs("http://example.onion/file"));
        assert!(!should_accept_invalid_certs("https://example.com/file"));
    }

    #[test]
    fn directory_metadata_url_is_derived_from_file_url() {
        assert_eq!(
            directory_metadata_url_and_file_name(
                "https://example.onion/api/companies/1/storages/files/root/folder/empty%20file.txt"
            ),
            Some((
                "https://example.onion/api/companies/1/storages/dirs/root/folder".to_string(),
                "root/folder".to_string(),
                "empty file.txt".to_string()
            ))
        );
    }

    #[tokio::test]
    async fn download_file_resumes_existing_part_with_range() {
        let tempdir = tempfile::tempdir().unwrap();
        let final_path = tempdir.path().join("file.txt");
        tokio::fs::write(part_path_for(&final_path), b"hello")
            .await
            .unwrap();
        let (url, request) = spawn_single_file_server(b"hello world".to_vec(), true).await;

        let result = download_file(
            DownloadRequest {
                id: "file-1".to_string(),
                url,
                final_path: final_path.clone(),
                proxy_url: None,
                metadata_cache_path: None,
            },
            None,
            None,
        )
        .await
        .unwrap();

        assert!(request
            .await
            .unwrap()
            .to_lowercase()
            .contains("range: bytes=5-"));
        assert_eq!(result.resumed_from, 5);
        assert_eq!(result.bytes_written, 11);
        assert_eq!(result.total_bytes, Some(11));
        assert_eq!(tokio::fs::read(&final_path).await.unwrap(), b"hello world");
        assert!(!part_path_for(&final_path).exists());
    }

    #[tokio::test]
    async fn download_file_restarts_when_server_ignores_range() {
        let tempdir = tempfile::tempdir().unwrap();
        let final_path = tempdir.path().join("file.txt");
        tokio::fs::write(part_path_for(&final_path), b"stale")
            .await
            .unwrap();
        let (url, request) = spawn_single_file_server(b"fresh".to_vec(), false).await;

        let result = download_file(
            DownloadRequest {
                id: "file-1".to_string(),
                url,
                final_path: final_path.clone(),
                proxy_url: None,
                metadata_cache_path: None,
            },
            None,
            None,
        )
        .await
        .unwrap();

        assert!(request
            .await
            .unwrap()
            .to_lowercase()
            .contains("range: bytes=5-"));
        assert_eq!(result.resumed_from, 0);
        assert_eq!(result.bytes_written, 5);
        assert_eq!(result.total_bytes, Some(5));
        assert_eq!(tokio::fs::read(&final_path).await.unwrap(), b"fresh");
    }

    #[tokio::test]
    async fn download_file_saves_empty_response() {
        let tempdir = tempfile::tempdir().unwrap();
        let final_path = tempdir.path().join("empty.txt");
        let cache_path = tempdir.path().join("metadata-size-cache.json");
        let (url, requests) = spawn_empty_file_with_dir_metadata(0).await;

        let result = download_file(
            DownloadRequest {
                id: "file-1".to_string(),
                url,
                final_path: final_path.clone(),
                proxy_url: None,
                metadata_cache_path: Some(cache_path.clone()),
            },
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.bytes_written, 0);
        assert_eq!(result.total_bytes, Some(0));
        assert_eq!(tokio::fs::read(&final_path).await.unwrap(), b"");
        assert!(!part_path_for(&final_path).exists());
        let requests = requests.await.unwrap();
        assert!(requests
            .iter()
            .any(|request| request.contains("/storages/files/dir/empty.txt")));
        assert!(requests
            .iter()
            .any(|request| request.contains("/storages/dirs/dir")));
        let cache = read_metadata_cache(&cache_path).await;
        assert_eq!(
            cache
                .entries
                .get("file:dir/empty.txt")
                .map(|entry| entry.size),
            Some(0)
        );
        assert_eq!(
            cached_file_sizes(
                &cache_path,
                &["/dir/empty.txt".to_string(), "dir/missing.txt".to_string()]
            )
            .await,
            vec![Some(0), None]
        );
    }

    #[tokio::test]
    async fn metadata_sizes_fetch_missing_entries_once_and_then_use_cache() {
        let tempdir = tempfile::tempdir().unwrap();
        let cache_path = tempdir.path().join("metadata-size-cache.json");
        let (base_url, request) = spawn_metadata_listing_server().await;
        let client = build_client_for_url(None, &base_url).unwrap();
        let entries = [
            ("file", "root/first.txt"),
            ("file", "root/second.txt"),
            ("dir", "root/child"),
        ];

        let sizes = resolve_metadata_sizes(&client, &base_url, Some(&cache_path), &entries)
            .await
            .unwrap();
        assert_eq!(sizes, vec![Some(12), Some(34), Some(56)]);
        assert!(request.await.unwrap().contains("/storages/dirs/root"));

        let cached_sizes = resolve_metadata_sizes(&client, &base_url, Some(&cache_path), &entries)
            .await
            .unwrap();
        assert_eq!(cached_sizes, sizes);
    }

    #[tokio::test]
    async fn download_file_resets_retry_count_after_successful_progress() {
        let tempdir = tempfile::tempdir().unwrap();
        let final_path = tempdir.path().join("file.txt");
        let body = b"abcdefghijklmn".to_vec();
        let (url, requests) = spawn_drip_disconnect_server(body.clone()).await;

        let result = download_file(
            DownloadRequest {
                id: "file-1".to_string(),
                url,
                final_path: final_path.clone(),
                proxy_url: None,
                metadata_cache_path: None,
            },
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.bytes_written, body.len() as u64);
        assert_eq!(result.total_bytes, Some(body.len() as u64));
        assert_eq!(tokio::fs::read(&final_path).await.unwrap(), body);
        assert!(requests.await.unwrap() > MAX_TRANSIENT_RETRIES);
    }

    async fn spawn_single_file_server(
        body: Vec<u8>,
        honor_range: bool,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request_bytes = vec![0; 4096];
            let read = socket.read(&mut request_bytes).await.unwrap();
            let request = String::from_utf8_lossy(&request_bytes[..read]).to_string();
            let range_start = request
                .lines()
                .find_map(|line| {
                    let lower = line.to_ascii_lowercase();
                    let value = lower.strip_prefix("range: bytes=")?.strip_suffix('-')?;
                    value.parse::<usize>().ok()
                })
                .filter(|start| *start <= body.len());
            let start = if honor_range {
                range_start.unwrap_or(0)
            } else {
                0
            };
            let response_body = &body[start..];
            let status = if honor_range && start > 0 {
                "HTTP/1.1 206 Partial Content"
            } else {
                "HTTP/1.1 200 OK"
            };
            let content_range = if honor_range && start > 0 {
                format!(
                    "Content-Range: bytes {}-{}/{}\r\n",
                    start,
                    body.len().saturating_sub(1),
                    body.len()
                )
            } else {
                String::new()
            };
            let headers = format!(
                "{status}\r\nContent-Length: {}\r\n{content_range}Connection: close\r\n\r\n",
                response_body.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(response_body).await.unwrap();
            request
        });
        (format!("http://{address}/file.txt"), handle)
    }

    async fn spawn_empty_file_with_dir_metadata(
        metadata_size: u64,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request_bytes = vec![0; 4096];
                let read = socket.read(&mut request_bytes).await.unwrap();
                let request = String::from_utf8_lossy(&request_bytes[..read]).to_string();
                let body = if request.contains("/storages/dirs/dir") {
                    format!(r#"{{"files":[{{"name":"empty.txt","size":{metadata_size}}}]}}"#)
                } else {
                    String::new()
                };
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(headers.as_bytes()).await.unwrap();
                socket.write_all(body.as_bytes()).await.unwrap();
                requests.push(request);
            }
            requests
        });
        (
            format!("http://{address}/api/companies/1/storages/files/dir/empty.txt"),
            handle,
        )
    }

    async fn spawn_metadata_listing_server() -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request_bytes = vec![0; 4096];
            let read = socket.read(&mut request_bytes).await.unwrap();
            let request = String::from_utf8_lossy(&request_bytes[..read]).to_string();
            let body = r#"{"path":"root","files":[{"name":"first.txt","size":12},{"name":"second.txt","size":34}],"dirs":[{"name":"child","size":56}]}"#;
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
            request
        });
        (
            format!("http://{address}/api/companies/1/storages/files/"),
            handle,
        )
    }

    async fn spawn_drip_disconnect_server(
        body: Vec<u8>,
    ) -> (String, tokio::task::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut requests = 0usize;
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests += 1;
                let mut request_bytes = vec![0; 4096];
                let read = socket.read(&mut request_bytes).await.unwrap();
                let request = String::from_utf8_lossy(&request_bytes[..read]).to_string();
                let start = request
                    .lines()
                    .find_map(|line| {
                        let lower = line.to_ascii_lowercase();
                        let value = lower.strip_prefix("range: bytes=")?.strip_suffix('-')?;
                        value.parse::<usize>().ok()
                    })
                    .unwrap_or(0)
                    .min(body.len());
                let remaining = body.len().saturating_sub(start);
                let content_range = if start > 0 {
                    format!(
                        "Content-Range: bytes {}-{}/{}\r\n",
                        start,
                        body.len().saturating_sub(1),
                        body.len()
                    )
                } else {
                    String::new()
                };
                let status = if start > 0 {
                    "HTTP/1.1 206 Partial Content"
                } else {
                    "HTTP/1.1 200 OK"
                };
                let headers = format!(
                    "{status}\r\nContent-Length: {remaining}\r\n{content_range}Connection: close\r\n\r\n"
                );
                socket.write_all(headers.as_bytes()).await.unwrap();
                let bytes_to_send = if remaining > 1 { 1 } else { remaining };
                socket
                    .write_all(&body[start..start + bytes_to_send])
                    .await
                    .unwrap();
                if remaining <= 1 {
                    return requests;
                }
            }
        });
        (format!("http://{address}/file.txt"), handle)
    }
}
