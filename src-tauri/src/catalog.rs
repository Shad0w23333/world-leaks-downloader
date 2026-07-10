use crate::downloader::{build_client_for_url, default_proxy_url, should_accept_invalid_certs};
use crate::native_download::ensure_proxy_reachable;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};
use url::Url;

static CATALOG_CACHE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCatalogRequest {
    pub base_url: String,
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub force_refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCompanyDataRequest {
    pub base_url: String,
    pub company_id: String,
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub force_refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Company {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub revenue: Option<u64>,
    #[serde(default)]
    pub employees: Option<u64>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub public_views: Option<u64>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StorageDirectoryListing {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub total_files: u64,
    #[serde(default)]
    pub total_size: u64,
    #[serde(default)]
    pub dirs: Vec<StorageDirectoryEntry>,
    #[serde(default)]
    pub files: Vec<StorageFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageDirectoryEntry {
    pub name: String,
    #[serde(default)]
    pub files: u64,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageFileEntry {
    pub name: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCompanyData {
    pub dirs: StorageDirectoryListing,
    pub listing: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCatalogProgress {
    company_id: String,
    received_bytes: u64,
    total_bytes: Option<u64>,
}

#[tauri::command]
pub async fn native_companies_load(
    app: AppHandle,
    request: NativeCatalogRequest,
) -> Result<Vec<Company>, String> {
    let _guard = catalog_cache_lock().lock().await;
    let api_root = normalize_api_root(&request.base_url)?;
    let cache_path = catalog_cache_root(&app, &api_root)?.join("companies.json");
    if !request.force_refresh {
        if let Some(companies) = read_json_cache::<Vec<Company>>(&cache_path).await? {
            return Ok(companies);
        }
    }

    let endpoint = format!("{api_root}/api/companies");
    eprintln!("[native-catalog] companies request url={endpoint}");
    let payload = fetch_text(&endpoint, request.proxy_url.as_deref()).await?;
    let companies = parse_companies(&payload)?;
    write_cache(
        &cache_path,
        serde_json::to_vec(&companies).map_err(|e| e.to_string())?,
    )
    .await?;
    Ok(companies)
}

#[tauri::command]
pub async fn native_company_data_load(
    app: AppHandle,
    request: NativeCompanyDataRequest,
) -> Result<NativeCompanyData, String> {
    let _guard = catalog_cache_lock().lock().await;
    let api_root = normalize_api_root(&request.base_url)?;
    let company_id = sanitize_company_id(&request.company_id)?;
    let cache_root = catalog_cache_root(&app, &api_root)?.join(&company_id);
    let dirs_path = cache_root.join("dirs.json");
    let listing_path = cache_root.join("listing.txt");

    let (cached_dirs, cached_listing) = if request.force_refresh {
        (None, None)
    } else {
        (
            read_json_cache::<StorageDirectoryListing>(&dirs_path).await?,
            read_text_cache(&listing_path).await?,
        )
    };
    if let (Some(dirs), Some(listing)) = (&cached_dirs, &cached_listing) {
        eprintln!(
            "[native-catalog] company data cache hit id={} dirs={} listing={} bytes={}",
            company_id,
            dirs_path.display(),
            listing_path.display(),
            listing.len()
        );
        emit_catalog_progress(
            &app,
            &company_id,
            listing.len() as u64,
            Some(listing.len() as u64),
        );
        return Ok(NativeCompanyData {
            dirs: dirs.clone(),
            listing: listing.clone(),
        });
    }

    let company_root = format!("{api_root}/api/companies/{company_id}/storages");
    let dirs_endpoint = format!("{company_root}/dirs");
    let listing_endpoint = format!("{company_root}/listing");
    eprintln!(
        "[native-catalog] company data request id={} dirs_url={} listing_url={} dirs_cache={} listing_cache={}",
        company_id,
        dirs_endpoint,
        listing_endpoint,
        dirs_path.display(),
        listing_path.display()
    );
    let proxy_url = request.proxy_url.as_deref();
    let dirs = if let Some(dirs) = cached_dirs {
        eprintln!(
            "[native-catalog] dirs cache hit path={}",
            dirs_path.display()
        );
        dirs
    } else {
        let payload = fetch_text(&dirs_endpoint, proxy_url).await?;
        let dirs: StorageDirectoryListing =
            serde_json::from_str(&payload).map_err(|error| error.to_string())?;
        write_cache(
            &dirs_path,
            serde_json::to_vec(&dirs).map_err(|error| error.to_string())?,
        )
        .await?;
        dirs
    };
    let listing = if let Some(listing) = cached_listing {
        eprintln!(
            "[native-catalog] listing cache hit path={} bytes={}",
            listing_path.display(),
            listing.len()
        );
        emit_catalog_progress(
            &app,
            &company_id,
            listing.len() as u64,
            Some(listing.len() as u64),
        );
        listing
    } else {
        let listing = fetch_listing_text(&app, &company_id, &listing_endpoint, proxy_url).await?;
        write_cache(&listing_path, listing.as_bytes().to_vec()).await?;
        listing
    };
    Ok(NativeCompanyData { dirs, listing })
}

fn catalog_cache_lock() -> &'static Mutex<()> {
    CATALOG_CACHE_LOCK.get_or_init(|| Mutex::new(()))
}

fn normalize_api_root(base_url: &str) -> Result<String, String> {
    let mut url = Url::parse(base_url.trim()).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只支持 HTTP 或 HTTPS 地址。".to_string());
    }
    let path = url.path().to_string();
    let root_path = path
        .find("/api/companies")
        .map(|index| &path[..index])
        .unwrap_or(path.trim_end_matches('/'));
    url.set_path(root_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn sanitize_company_id(company_id: &str) -> Result<String, String> {
    let value = company_id.trim();
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("公司 ID 无效。".to_string());
    }
    Ok(value.to_string())
}

fn catalog_cache_root(app: &AppHandle, api_root: &str) -> Result<PathBuf, String> {
    let url = Url::parse(api_root).map_err(|error| error.to_string())?;
    let mut key = format!(
        "{}{}{}",
        url.host_str().unwrap_or("catalog"),
        url.port()
            .map(|port| format!("_{port}"))
            .unwrap_or_default(),
        url.path()
    );
    key = key
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    app.path()
        .app_data_dir()
        .map(|path| path.join("catalog-cache").join(key))
        .map_err(|error| error.to_string())
}

async fn fetch_text(endpoint: &str, proxy_url: Option<&str>) -> Result<String, String> {
    let proxy_url = proxy_url
        .map(str::to_string)
        .unwrap_or_else(default_proxy_url);
    ensure_proxy_reachable(&proxy_url).await?;
    eprintln!(
        "[native-catalog] GET url={} onion_tls_bypass={} proxy={}",
        endpoint,
        should_accept_invalid_certs(endpoint),
        proxy_url
    );
    let response = send_with_retries(&proxy_url, endpoint).await?;
    if !response.status().is_success() {
        return Err(format!("请求失败：HTTP {} ({endpoint})", response.status()));
    }
    response.text().await.map_err(|error| error.to_string())
}

async fn fetch_listing_text(
    app: &AppHandle,
    company_id: &str,
    endpoint: &str,
    proxy_url: Option<&str>,
) -> Result<String, String> {
    let proxy_url = proxy_url
        .map(str::to_string)
        .unwrap_or_else(default_proxy_url);
    ensure_proxy_reachable(&proxy_url).await?;
    eprintln!(
        "[native-catalog] GET url={} onion_tls_bypass={} proxy={}",
        endpoint,
        should_accept_invalid_certs(endpoint),
        proxy_url
    );
    eprintln!("[native-catalog] listing request id={company_id} url={endpoint}");
    emit_catalog_progress(app, company_id, 0, None);
    let response = send_with_retries(&proxy_url, endpoint).await?;
    if !response.status().is_success() {
        return Err(format!("请求失败：HTTP {} ({endpoint})", response.status()));
    }

    let total_bytes = response.content_length();
    eprintln!(
        "[native-catalog] listing response id={} url={} total_bytes={:?}",
        company_id, endpoint, total_bytes
    );
    let mut received_bytes = 0_u64;
    let mut bytes = Vec::with_capacity(total_bytes.unwrap_or(0).min(usize::MAX as u64) as usize);
    let mut stream = response.bytes_stream();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    emit_catalog_progress(app, company_id, 0, total_bytes);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        received_bytes = received_bytes.saturating_add(chunk.len() as u64);
        bytes.extend_from_slice(&chunk);
        if last_emit.elapsed() >= Duration::from_millis(100) {
            eprintln!(
                "[native-catalog] listing progress id={} received_bytes={} total_bytes={:?}",
                company_id, received_bytes, total_bytes
            );
            emit_catalog_progress(app, company_id, received_bytes, total_bytes);
            last_emit = Instant::now();
        }
    }
    emit_catalog_progress(
        app,
        company_id,
        received_bytes,
        total_bytes.or(Some(received_bytes)),
    );
    eprintln!(
        "[native-catalog] listing complete id={} url={} received_bytes={}",
        company_id, endpoint, received_bytes
    );
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

async fn send_with_retries(proxy_url: &str, endpoint: &str) -> Result<reqwest::Response, String> {
    const MAX_ATTEMPTS: usize = 4;
    for attempt in 1..=MAX_ATTEMPTS {
        let client =
            build_client_for_url(Some(proxy_url), endpoint).map_err(|error| error.to_string())?;
        match timeout(Duration::from_secs(20), client.get(endpoint).send()).await {
            Ok(Ok(response)) => return Ok(response),
            Ok(Err(error)) => {
                eprintln!(
                    "[native-catalog] request error attempt={}/{} url={} error={:#?}",
                    attempt, MAX_ATTEMPTS, endpoint, error
                );
                if attempt == MAX_ATTEMPTS {
                    return Err(format!("请求失败 ({endpoint})：{error:#?}"));
                }
            }
            Err(_) => {
                eprintln!(
                    "[native-catalog] request timeout attempt={}/{} url={} timeout_seconds=20",
                    attempt, MAX_ATTEMPTS, endpoint
                );
                if attempt == MAX_ATTEMPTS {
                    return Err(format!(
                        "请求超时 ({endpoint})：连续 {MAX_ATTEMPTS} 次没有收到响应。"
                    ));
                }
            }
        }
        sleep(Duration::from_secs(attempt as u64)).await;
    }
    unreachable!()
}

fn emit_catalog_progress(
    app: &AppHandle,
    company_id: &str,
    received_bytes: u64,
    total_bytes: Option<u64>,
) {
    app.emit(
        "native-catalog-progress",
        NativeCatalogProgress {
            company_id: company_id.to_string(),
            received_bytes,
            total_bytes,
        },
    )
    .ok();
}

fn parse_companies(payload: &str) -> Result<Vec<Company>, String> {
    let trimmed = payload.trim();
    if trimmed.starts_with('[') {
        return serde_json::from_str(trimmed).map_err(|error| error.to_string());
    }
    trimmed
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
        .collect()
}

async fn read_json_cache<T>(path: &Path) -> Result<Option<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

async fn read_text_cache(path: &Path) -> Result<Option<String>, String> {
    match tokio::fs::read_to_string(path).await {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

async fn write_cache(path: &Path, bytes: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let temp_path = path.with_extension("tmp");
    tokio::fs::write(&temp_path, bytes)
        .await
        .map_err(|error| error.to_string())?;
    if let Err(error) = tokio::fs::rename(&temp_path, path).await {
        if !path.exists() {
            return Err(error.to_string());
        }
        tokio::fs::remove_file(path)
            .await
            .map_err(|remove_error| remove_error.to_string())?;
        tokio::fs::rename(temp_path, path)
            .await
            .map_err(|rename_error| rename_error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_root_is_derived_from_file_endpoint() {
        assert_eq!(
            normalize_api_root("https://example.test/prefix/api/companies/123/storages/files/")
                .unwrap(),
            "https://example.test/prefix"
        );
    }

    #[test]
    fn newline_delimited_companies_are_parsed() {
        let payload = "{\"id\":\"1\",\"title\":\"One\"}\n{\"id\":\"2\",\"title\":\"Two\"}\n";
        let companies = parse_companies(payload).unwrap();
        assert_eq!(companies.len(), 2);
        assert_eq!(companies[1].title.as_deref(), Some("Two"));
    }
}
