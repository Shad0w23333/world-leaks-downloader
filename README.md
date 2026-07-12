# World Leaks Downloader

World Leaks Downloader is a Tauri 2 desktop app for importing path lists and downloading files with resumable Rust-backed transfers.

The app can work with normal HTTP/HTTPS URLs and with `.onion` URLs through a local Tor SOCKS proxy. By default it uses `socks5h://127.0.0.1:9150`, which matches the common Tor Browser SOCKS port.

## Project Layout

```text
frontend/      Static HTML, CSS, and JavaScript UI
src-tauri/     Rust backend and Tauri configuration
```

## Prerequisites

Install these before building on any platform:

- Rust: https://www.rust-lang.org/tools/install
- Tauri CLI:

```bash
cargo install tauri-cli --version "^2"
```

## macOS

Install Apple command line tools:

```bash
xcode-select --install
```

Check the project:

```bash
cd src-tauri
cargo check
cargo test
```

Run the desktop app in development mode:

```bash
cd src-tauri
cargo run
```

Build a distributable app:

```bash
cd src-tauri
cargo tauri build
```

The packaged output is written under `src-tauri/target/release/bundle/`.

## Windows

Install the Microsoft C++ build tools:

1. Install Visual Studio Build Tools 2022.
2. Select the "Desktop development with C++" workload.
3. Make sure the Windows SDK is selected.

Then open PowerShell in the repository root.

Check the project:

```powershell
cd src-tauri
cargo check
cargo test
```

Run the desktop app in development mode:

```powershell
cd src-tauri
cargo run
```

Build a distributable installer:

```powershell
cd src-tauri
cargo tauri build
```

The packaged output is written under `src-tauri\target\release\bundle\`.

## Publishing a GitHub Release

Release builds are produced by GitHub Actions when a version tag is pushed.
The workflow builds Windows packages on `windows-latest` and a macOS `.dmg` on `macos-latest`, then uploads them to a draft GitHub Release.

1. Update the version in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Commit the version change.
3. Create and push a tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

4. Open the draft release on GitHub, check the uploaded packages, then publish it.

## Using the App

1. Start Tor Browser or another Tor service if you need to download `.onion` URLs.
2. Open the app.
3. Set `Base URL` if your path list contains relative paths.
4. Choose a save directory.
5. Import a path txt file.
6. Adjust interval and concurrency.
7. Start the queue.

Path txt rules:

- Empty lines are ignored.
- Lines starting with `#` or `//` are ignored.
- A line can be a relative path, such as `folder/file.zip`.
- A line can be a full `http://` or `https://` URL.
- Relative paths are joined with `Base URL`.
- Spaces in paths are preserved and URL-encoded automatically.

Downloads are written as `.part` files while incomplete. If a download is restarted, the app reads the existing `.part` size and resumes with an HTTP `Range` request when the server supports it.

## Notes

- If your Tor SOCKS port is not `127.0.0.1:9150`, update the proxy setting in the app.
- Only use this tool for pages and files you are authorized to access.
- The app does not bypass website permissions or network access controls.
