pub mod catalog;
pub mod downloader;
pub mod native_download;
pub mod pathing;
pub mod persistence;

use catalog::{native_companies_load, native_company_data_load};
use native_download::{
    native_default_download_directory, native_download_cancel, native_download_exists,
    native_download_exists_many, native_download_search, native_download_start,
    native_metadata_sizes, native_path_selection_update, native_path_selections_load,
    native_reveal_path, native_select_directory, SharedNativeDownloads,
};
use persistence::{native_persistence_load, native_settings_save};
use std::sync::Arc;
use tokio::sync::Mutex;

pub fn run() {
    let native_downloads: SharedNativeDownloads = Arc::new(Mutex::new(Default::default()));
    tauri::Builder::default()
        .manage(native_downloads)
        .invoke_handler(tauri::generate_handler![
            native_companies_load,
            native_company_data_load,
            native_default_download_directory,
            native_download_start,
            native_download_cancel,
            native_download_search,
            native_download_exists,
            native_download_exists_many,
            native_metadata_sizes,
            native_reveal_path,
            native_select_directory,
            native_path_selections_load,
            native_path_selection_update,
            native_persistence_load,
            native_settings_save
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tauri app");
}
