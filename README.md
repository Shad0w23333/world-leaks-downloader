# World Leaks Downloader

World Leaks Downloader 是一个基于 Tauri 2 的桌面下载工具，用于导入路径列表，并通过 Rust 后端执行可恢复的文件下载。

它既可以下载普通 HTTP/HTTPS 地址，也可以通过本地 Tor SOCKS 代理下载 `.onion` 地址。默认代理地址为 `socks5h://127.0.0.1:9150`，对应 Tor Browser 常见的 SOCKS 端口。

## 项目结构

```text
frontend/      静态 HTML、CSS 和 JavaScript 界面
src-tauri/     Rust 后端和 Tauri 配置
```

## 环境准备

所有平台都需要先安装：

- Rust: https://www.rust-lang.org/tools/install
- Tauri CLI:

```bash
cargo install tauri-cli --version "^2"
```

## Windows

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

## macOS

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

## 发布 GitHub Release

推送版本 tag 后，GitHub Actions 会自动构建发布包，并上传到草稿 GitHub Release。

当前发布产物包括：

- Windows NSIS 安装包：`*.exe`
- Windows 免安装压缩包：`*-windows-x64-portable.zip`
- macOS 安装包：`*.dmg`

Windows 不再生成 MSI，因此 release 中不会出现带 `_en-US.msi` 后缀的文件。

发布步骤：

1. 更新 `src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 中的版本号。
2. 如版本号变化会影响 `src-tauri/Cargo.lock`，一并更新并提交。
3. 提交代码。
4. 创建并推送版本 tag：

```bash
git tag v0.1.2
git push origin v0.1.2
```

5. 打开 GitHub 上生成的草稿 release，确认安装包和免安装包无误后发布。

## 使用方法

1. 如果需要下载 `.onion` 地址，先启动 Tor Browser 或其他 Tor 服务。
2. 打开 World Leaks Downloader。
3. 如果路径列表中包含相对路径，先设置 `Base URL`。
4. 选择保存目录。
5. 导入路径 txt 文件。
6. 调整下载间隔和并发数量。
7. 启动下载队列。

路径 txt 文件规则：

- 空行会被忽略。
- 以 `#` 或 `//` 开头的行会被忽略。
- 每一行可以是相对路径，例如 `folder/file.zip`。
- 每一行也可以是完整的 `http://` 或 `https://` URL。
- 相对路径会与 `Base URL` 拼接。
- 路径中的空格会被保留，并自动进行 URL 编码。

下载未完成时会写入 `.part` 文件。如果重新开始下载，程序会读取现有 `.part` 文件大小，并在服务器支持时通过 HTTP `Range` 请求继续下载。

## 注意事项

- 如果你的 Tor SOCKS 端口不是 `127.0.0.1:9150`，请在程序中修改代理设置。
- 只应下载你有权限访问的页面和文件。
- 本工具不会绕过网站权限、登录限制或网络访问控制。
