use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

static PERSISTENCE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeAppSettings {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub queue_options: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePersistenceSnapshot {
    pub queue_options: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSaveSettingsRequest {
    pub queue_options: Value,
}

#[tauri::command]
pub async fn native_persistence_load(app: AppHandle) -> Result<NativePersistenceSnapshot, String> {
    let _guard = persistence_lock().lock().await;
    let root = persistence_root(&app)?;
    let settings_path = root.join("app-settings.json");
    let settings: NativeAppSettings = read_json_or_default(&settings_path).await?;

    Ok(NativePersistenceSnapshot {
        queue_options: settings.queue_options,
    })
}

#[tauri::command]
pub async fn native_settings_save(
    app: AppHandle,
    request: NativeSaveSettingsRequest,
) -> Result<(), String> {
    let _guard = persistence_lock().lock().await;
    let path = persistence_root(&app)?.join("app-settings.json");
    write_json_atomic(
        &path,
        &NativeAppSettings {
            version: 1,
            queue_options: Some(request.queue_options),
        },
    )
    .await
}

fn persistence_lock() -> &'static Mutex<()> {
    PERSISTENCE_LOCK.get_or_init(|| Mutex::new(()))
}

fn persistence_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

async fn read_json_or_default<T>(path: &Path) -> Result<T, String>
where
    T: serde::de::DeserializeOwned + Default,
{
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.to_string()),
    }
}

async fn write_json_atomic<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize + ?Sized,
{
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let temp_path = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
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

    #[tokio::test]
    async fn json_helpers_round_trip_values() {
        let tempdir = tempfile::tempdir().unwrap();
        let path = tempdir.path().join("nested/settings.json");
        let expected = NativeAppSettings {
            version: 1,
            queue_options: Some(serde_json::json!({ "maxConcurrent": 4 })),
        };

        write_json_atomic(&path, &expected).await.unwrap();
        let actual: NativeAppSettings = read_json_or_default(&path).await.unwrap();

        assert_eq!(actual.version, 1);
        assert_eq!(actual.queue_options, expected.queue_options);
    }
}
