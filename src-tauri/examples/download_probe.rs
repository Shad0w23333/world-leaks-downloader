use std::path::PathBuf;
use std::sync::Arc;
use world_leaks_downloader::downloader::{
    default_proxy_url, download_file, DownloadProgress, DownloadRequest, ProgressCallback,
};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let Some(url) = args.next() else {
        eprintln!("usage: cargo run --example download_probe -- <url> <output>");
        std::process::exit(2);
    };
    let output = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/tor-resumable-download-probe.bin"));

    let progress: ProgressCallback = Arc::new(|progress: DownloadProgress| {
        eprintln!(
            "[probe] progress id={} bytes={} total={:?}",
            progress.id, progress.bytes_received, progress.total_bytes
        );
    });

    match download_file(
        DownloadRequest {
            id: "probe".to_string(),
            url,
            final_path: output,
            proxy_url: Some(default_proxy_url()),
            metadata_cache_path: Some(PathBuf::from("/tmp/tor-resumable-metadata-size-cache.json")),
        },
        Some(progress),
        None,
    )
    .await
    {
        Ok(result) => eprintln!(
            "[probe] complete bytes={} total={:?} path={}",
            result.bytes_written,
            result.total_bytes,
            result.final_path.display()
        ),
        Err(error) => {
            eprintln!("[probe] error {error}");
            eprintln!("[probe] debug {error:?}");
            std::process::exit(1);
        }
    }
}
