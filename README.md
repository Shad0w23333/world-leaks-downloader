# World Leaks Downloader

## 使用说明

World Leaks Downloader 可以批量下载 World Leaks 的文件。使用前请先打开 Tor 浏览器，并确认 Tor 浏览器已经连接到 Tor 网络。

从 GitHub Release 下载程序包：https://github.com/microbun/world-leaks-downloader/releases

支持断点续传。

## 自行编译

以下内容只在你需要从源码自行编译或开发本项目时使用。普通用户下载发布包后不需要安装这些编译环境。

### 项目结构

```text
frontend/      静态 HTML、CSS 和 JavaScript 界面
src-tauri/     Rust 后端和 Tauri 配置
```

### 环境准备

所有平台都需要先安装：

- Rust: https://www.rust-lang.org/tools/install
- Tauri CLI:

```bash
cargo install tauri-cli --version "^2"
```

### Windows

先安装 Microsoft C++ 编译工具：

1. 安装 Visual Studio Build Tools 2022。
2. 勾选 `Desktop development with C++` 工作负载。
3. 确认已选择 Windows SDK。

然后在仓库根目录打开 PowerShell。

检查项目：

```powershell
cd src-tauri
cargo check
cargo test
```

以开发模式运行桌面程序：

```powershell
cd src-tauri
cargo run
```

构建发布版本：

```powershell
cd src-tauri
cargo tauri build --bundles nsis
```

构建后的安装包位于：

```text
src-tauri\target\release\bundle\
```

直接可运行的免安装程序位于：

```text
src-tauri\target\release\world-leaks-downloader.exe
```

### macOS

先安装 Apple 命令行工具：

```bash
xcode-select --install
```

检查项目：

```bash
cd src-tauri
cargo check
cargo test
```

以开发模式运行桌面程序：

```bash
cd src-tauri
cargo run
```

构建 `.dmg` 安装包：

```bash
cd src-tauri
cargo tauri build --bundles dmg
```

构建后的文件位于：

```text
src-tauri/target/release/bundle/
```
