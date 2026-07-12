use crate::downloader::{
    build_client_for_url, cached_file_sizes, cached_metadata_sizes, default_proxy_url,
    download_file, resolve_metadata_sizes, CancellationFlag, DownloadError, DownloadProgress,
    DownloadRequest, ProgressCallback,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::timeout;

#[derive(Default)]
pub struct NativeDownloads {
    next_id: u64,
    cancellations: HashMap<u64, CancellationFlag>,
    records: HashMap<u64, NativeDownloadEvent>,
}

pub type SharedNativeDownloads = Arc<Mutex<NativeDownloads>>;

static PATH_SELECTION_FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownloadStartRequest {
    pub id: Option<u64>,
    pub url: String,
    pub filename: String,
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownloadStarted {
    pub id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownloadEvent {
    pub id: u64,
    pub state: String,
    pub bytes_received: u64,
    pub session_bytes_received: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownloadSearchRequest {
    pub id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownloadExistsRequest {
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownloadExistsManyRequest {
    pub filenames: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRevealPathRequest {
    pub path: String,
    #[serde(default)]
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSelectDirectoryRequest {
    pub initial_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMetadataSizesRequest {
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub entries: Option<Vec<NativeMetadataSizeEntry>>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMetadataSizeEntry {
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePathSelectionUpdateRequest {
    pub kind: String,
    pub path: String,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePathSelections {
    pub version: u32,
    #[serde(default)]
    pub entries: HashMap<String, bool>,
}

impl Default for NativePathSelections {
    fn default() -> Self {
        Self {
            version: 1,
            entries: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownloadFileStatus {
    pub filename: String,
    pub exists: bool,
    pub is_file: bool,
    pub file_size: Option<u64>,
}

#[tauri::command]
pub async fn native_download_start(
    app: AppHandle,
    downloads: State<'_, SharedNativeDownloads>,
    request: NativeDownloadStartRequest,
) -> Result<NativeDownloadStarted, String> {
    let proxy_url = request.proxy_url.clone().unwrap_or_else(default_proxy_url);
    ensure_proxy_reachable(&proxy_url).await?;

    let (id, cancellation) = {
        let mut downloads = downloads.lock().await;
        let id = match request.id {
            Some(id) if id > 0 => {
                downloads.next_id = downloads.next_id.max(id);
                id
            }
            _ => {
                downloads.next_id = downloads.next_id.saturating_add(1);
                downloads.next_id
            }
        };
        let cancellation = Arc::new(AtomicBool::new(false));
        downloads.cancellations.insert(id, cancellation.clone());
        downloads.records.insert(
            id,
            NativeDownloadEvent {
                id,
                state: "in_progress".to_string(),
                bytes_received: 0,
                session_bytes_received: 0,
                total_bytes: None,
                error: None,
            },
        );
        (id, cancellation)
    };

    eprintln!(
        "[native-download] start id={} url={} filename={} proxy={}",
        id,
        request.url,
        request.filename,
        request.proxy_url.as_deref().unwrap_or("")
    );

    let downloads_state = downloads.inner().clone();
    let progress_app = app.clone();
    let progress_downloads_state = downloads_state.clone();
    let progress: ProgressCallback = Arc::new(move |progress: DownloadProgress| {
        eprintln!(
            "[native-download] progress id={} bytes={} session_bytes={} total={:?}",
            id, progress.bytes_received, progress.session_bytes_received, progress.total_bytes
        );
        let event = NativeDownloadEvent {
            id,
            state: "in_progress".to_string(),
            bytes_received: progress.bytes_received,
            session_bytes_received: progress.session_bytes_received,
            total_bytes: progress.total_bytes,
            error: None,
        };
        let progress_downloads_state = progress_downloads_state.clone();
        let record_event = event.clone();
        tauri::async_runtime::spawn(async move {
            progress_downloads_state
                .lock()
                .await
                .records
                .insert(id, record_event);
        });
        progress_app.emit("native-download-changed", event).ok();
    });

    let metadata_cache_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|path| path.join("metadata-size-cache.json"));
    let proxy_url_for_check = proxy_url.clone();
    tauri::async_runtime::spawn(async move {
        let result = download_file(
            DownloadRequest {
                id: id.to_string(),
                url: request.url,
                final_path: PathBuf::from(request.filename),
                proxy_url: Some(proxy_url),
                metadata_cache_path,
            },
            Some(progress),
            Some(cancellation),
        )
        .await;

        let last_session_bytes = {
            let mut downloads = downloads_state.lock().await;
            downloads.cancellations.remove(&id);
            downloads
                .records
                .get(&id)
                .map(|event| event.session_bytes_received)
                .unwrap_or(0)
        };
        let event = match result {
            Ok(result) => NativeDownloadEvent {
                id,
                state: "complete".to_string(),
                bytes_received: result.bytes_written,
                session_bytes_received: result.session_bytes_written,
                total_bytes: result.total_bytes,
                error: None,
            },
            Err(DownloadError::Cancelled) => NativeDownloadEvent {
                id,
                state: "interrupted".to_string(),
                bytes_received: 0,
                session_bytes_received: last_session_bytes,
                total_bytes: None,
                error: Some("USER_CANCELED".to_string()),
            },
            Err(error) => {
                let error_message = if matches!(&error, DownloadError::Network(_))
                    && ensure_proxy_reachable(&proxy_url_for_check).await.is_err()
                {
                    "TOR_PROXY_DISCONNECTED".to_string()
                } else {
                    format!("{error:?}")
                };
                NativeDownloadEvent {
                    id,
                    state: "interrupted".to_string(),
                    bytes_received: 0,
                    session_bytes_received: last_session_bytes,
                    total_bytes: None,
                    error: Some(error_message),
                }
            }
        };
        eprintln!(
            "[native-download] finish id={} state={} bytes={} total={:?} error={:?}",
            event.id, event.state, event.bytes_received, event.total_bytes, event.error
        );
        downloads_state
            .lock()
            .await
            .records
            .insert(id, event.clone());
        app.emit("native-download-changed", event).ok();
    });

    Ok(NativeDownloadStarted { id })
}

pub(crate) async fn ensure_proxy_reachable(proxy_url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(proxy_url).map_err(|_| "TOR_PROXY_UNAVAILABLE".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "TOR_PROXY_UNAVAILABLE".to_string())?;
    let port = parsed.port().unwrap_or(1080);
    match timeout(Duration::from_secs(3), TcpStream::connect((host, port))).await {
        Ok(Ok(_)) => Ok(()),
        _ => Err("TOR_PROXY_UNAVAILABLE".to_string()),
    }
}

#[tauri::command]
pub async fn native_download_cancel(
    downloads: State<'_, SharedNativeDownloads>,
    id: u64,
) -> Result<(), String> {
    if let Some(flag) = downloads.lock().await.cancellations.get(&id) {
        eprintln!("[native-download] cancel id={}", id);
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn native_download_search(
    downloads: State<'_, SharedNativeDownloads>,
    request: NativeDownloadSearchRequest,
) -> Result<Option<NativeDownloadEvent>, String> {
    Ok(downloads.lock().await.records.get(&request.id).cloned())
}

#[tauri::command]
pub async fn native_download_exists(
    request: NativeDownloadExistsRequest,
) -> Result<NativeDownloadFileStatus, String> {
    local_file_status(request.filename).await
}

#[tauri::command]
pub async fn native_download_exists_many(
    request: NativeDownloadExistsManyRequest,
) -> Result<Vec<NativeDownloadFileStatus>, String> {
    let mut statuses = Vec::with_capacity(request.filenames.len());
    for filename in request.filenames {
        statuses.push(local_file_status(filename).await?);
    }
    Ok(statuses)
}

async fn local_file_status(filename: String) -> Result<NativeDownloadFileStatus, String> {
    let path = PathBuf::from(&filename);
    match tokio::fs::metadata(path).await {
        Ok(metadata) => {
            let is_file = metadata.is_file();
            Ok(NativeDownloadFileStatus {
                filename,
                exists: true,
                is_file,
                file_size: is_file.then_some(metadata.len()),
            })
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(NativeDownloadFileStatus {
            filename,
            exists: false,
            is_file: false,
            file_size: None,
        }),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn native_reveal_path(request: NativeRevealPathRequest) -> Result<(), String> {
    tokio::task::spawn_blocking(move || reveal_path(PathBuf::from(request.path), request.is_directory))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn native_select_directory(
    app: AppHandle,
    request: NativeSelectDirectoryRequest,
) -> Result<Option<String>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(initial_path) = request
            .initial_path
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
        {
            dialog = dialog.set_directory(initial_path);
        }
        let selected = dialog
            .pick_folder()
            .map(|path| path.to_string_lossy().to_string());
        let _ = sender.send(selected);
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn native_default_download_directory(app: AppHandle) -> Result<String, String> {
    app.path()
        .download_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn native_metadata_sizes(
    app: AppHandle,
    request: NativeMetadataSizesRequest,
) -> Result<Vec<Option<u64>>, String> {
    let cache_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("metadata-size-cache.json");
    if let Some(entries) = request.entries {
        let refs = entries
            .iter()
            .map(|entry| (entry.kind.as_str(), entry.path.as_str()))
            .collect::<Vec<_>>();
        let cached_sizes = cached_metadata_sizes(&cache_path, &refs).await;
        if cached_sizes.iter().all(Option::is_some) {
            return Ok(cached_sizes);
        }
        if let Some(base_url) = request.base_url.filter(|value| !value.trim().is_empty()) {
            let proxy_url = request.proxy_url.unwrap_or_else(default_proxy_url);
            if ensure_proxy_reachable(&proxy_url).await.is_err() {
                return Ok(cached_sizes);
            }
            let client = build_client_for_url(Some(&proxy_url), &base_url)
                .map_err(|error| error.to_string())?;
            return match resolve_metadata_sizes(&client, &base_url, Some(&cache_path), &refs).await
            {
                Ok(sizes) => Ok(sizes),
                Err(error) => {
                    eprintln!("[native-download] metadata refresh failed error={error:?}");
                    Ok(cached_metadata_sizes(&cache_path, &refs).await)
                }
            };
        }
        return Ok(cached_sizes);
    }
    Ok(cached_file_sizes(&cache_path, &request.paths).await)
}

#[tauri::command]
pub async fn native_path_selections_load(app: AppHandle) -> Result<NativePathSelections, String> {
    let _guard = path_selection_file_lock().lock().await;
    read_path_selections(&path_selection_file_path(&app)?).await
}

#[tauri::command]
pub async fn native_path_selection_update(
    app: AppHandle,
    request: NativePathSelectionUpdateRequest,
) -> Result<(), String> {
    let _guard = path_selection_file_lock().lock().await;
    let path = path_selection_file_path(&app)?;
    let mut selections = read_path_selections(&path).await?;
    apply_path_selection_update(&mut selections, request);
    write_path_selections(&path, &selections).await
}

fn path_selection_file_lock() -> &'static Mutex<()> {
    PATH_SELECTION_FILE_LOCK.get_or_init(|| Mutex::new(()))
}

fn path_selection_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("path-selection-overrides.json"))
        .map_err(|error| error.to_string())
}

async fn read_path_selections(path: &std::path::Path) -> Result<NativePathSelections, String> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(NativePathSelections::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

async fn write_path_selections(
    path: &std::path::Path,
    selections: &NativePathSelections,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let temp_path = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(selections).map_err(|error| error.to_string())?;
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

fn apply_path_selection_update(
    selections: &mut NativePathSelections,
    request: NativePathSelectionUpdateRequest,
) {
    let path = normalize_selection_path(&request.path);
    if path.is_empty() {
        return;
    }
    let kind = if request.kind == "file" {
        "file"
    } else {
        "dir"
    };
    if kind == "dir" {
        let descendant_prefix = format!("{path}/");
        selections.entries.retain(|key, _| {
            let stored_path = key.split_once(':').map(|(_, value)| value).unwrap_or("");
            stored_path != path && !stored_path.starts_with(&descendant_prefix)
        });
    }
    selections
        .entries
        .insert(format!("{kind}:{path}"), request.selected);
    selections.version = 1;
}

fn normalize_selection_path(path: &str) -> String {
    path.trim()
        .trim_start_matches(['/', '\\'])
        .replace('\\', "/")
}

#[cfg(target_os = "windows")]
fn windows_explorer_path(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('/', "\\")
}

fn reveal_path(path: PathBuf, is_directory_hint: bool) -> Result<(), String> {
    let target =
        nearest_existing_path(path).ok_or_else(|| "找不到可打开的本地目录。".to_string())?;

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        if target.is_file() {
            command.arg("-R");
        }
        command.arg(&target);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        if target.is_file() && !is_directory_hint {
            command.arg("/select,");
            command.arg(windows_explorer_path(&target));
        } else {
            command.arg(windows_explorer_path(&target));
        }
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(if target.is_file() {
            target.parent().unwrap_or(&target)
        } else {
            &target
        });
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn nearest_existing_path(mut path: PathBuf) -> Option<PathBuf> {
    loop {
        if path.exists() {
            return Some(path);
        }
        if !path.pop() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_download_exists_reports_file_metadata() {
        let tempdir = tempfile::tempdir().unwrap();
        let path = tempdir.path().join("file.txt");
        tokio::fs::write(&path, b"hello").await.unwrap();

        let status = native_download_exists(NativeDownloadExistsRequest {
            filename: path.to_string_lossy().to_string(),
        })
        .await
        .unwrap();

        assert!(status.exists);
        assert!(status.is_file);
        assert_eq!(status.file_size, Some(5));
    }

    #[tokio::test]
    async fn native_download_exists_reports_missing_file() {
        let tempdir = tempfile::tempdir().unwrap();
        let path = tempdir.path().join("missing.txt");

        let status = native_download_exists(NativeDownloadExistsRequest {
            filename: path.to_string_lossy().to_string(),
        })
        .await
        .unwrap();

        assert!(!status.exists);
        assert!(!status.is_file);
        assert_eq!(status.file_size, None);
    }

    #[tokio::test]
    async fn native_download_exists_many_reports_each_file() {
        let tempdir = tempfile::tempdir().unwrap();
        let existing = tempdir.path().join("existing.txt");
        let missing = tempdir.path().join("missing.txt");
        tokio::fs::write(&existing, b"hello").await.unwrap();

        let statuses = native_download_exists_many(NativeDownloadExistsManyRequest {
            filenames: vec![
                existing.to_string_lossy().to_string(),
                missing.to_string_lossy().to_string(),
            ],
        })
        .await
        .unwrap();

        assert_eq!(statuses.len(), 2);
        assert!(statuses[0].exists);
        assert_eq!(statuses[0].file_size, Some(5));
        assert!(!statuses[1].exists);
    }

    #[test]
    fn nearest_existing_path_uses_parent_for_missing_file() {
        let tempdir = tempfile::tempdir().unwrap();
        let missing = tempdir.path().join("folder").join("missing.txt");

        assert_eq!(
            nearest_existing_path(missing),
            Some(tempdir.path().to_path_buf())
        );
    }

    #[test]
    fn directory_selection_replaces_descendant_rules() {
        let mut selections = NativePathSelections::default();
        selections
            .entries
            .insert("dir:root/child".to_string(), false);
        selections
            .entries
            .insert("file:root/child/file.txt".to_string(), true);
        selections
            .entries
            .insert("file:other/file.txt".to_string(), false);

        apply_path_selection_update(
            &mut selections,
            NativePathSelectionUpdateRequest {
                kind: "directory".to_string(),
                path: "/root".to_string(),
                selected: true,
            },
        );

        assert_eq!(selections.entries.get("dir:root"), Some(&true));
        assert!(!selections.entries.contains_key("dir:root/child"));
        assert!(!selections.entries.contains_key("file:root/child/file.txt"));
        assert_eq!(selections.entries.get("file:other/file.txt"), Some(&false));
    }

}
