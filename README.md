# FPSMaster Launcher

Minecraft launcher architecture with:

- Tauri + React UI
- Rust command bridge and launcher core

## Project Layout

- `tauri-app/`: Tauri + React desktop frontend and Rust command layer

## Development Phases

### Phase 1

- Vanilla install:
  - parse Mojang version manifest and version JSON
  - download client jar, libraries, assets index and objects
  - build launch command arguments for vanilla

### Phase 2

- Forge and Fabric auto-install:
  - Fabric metadata-driven profile installation
  - Forge installer download and headless invocation
  - compatible version profile generation and validation

## CI/CD Release

Launcher 已接入 GitHub Actions 自动打包和发版流程。

- 所有 `pull_request` 和 `master` 的 `push` 都只执行打包校验，不发版。
- 只有推送 `v*` 语义化版本 tag 才会真正发版：构建安装包、创建 GitHub Release。

tag 到更新通道的映射（仅保留 beta / release）：

- `v0.3.15` -> `release` / 版本号 `0.3.15`
- `v0.3.15-beta.1` -> `beta` / 版本号 `0.3.15-beta.1`

更新日志取自被打 tag 的那个 commit 的提交信息，会直接展示给玩家。写法要求见 [docs/release-notes.md](docs/release-notes.md)。

发布只依赖 GitHub Releases。旧版启动器的最后一次升级由后端 sunset 配置人工指向 GitHub 安装包，不再由 CI 上传七牛或调用后端。迁移契约见 [docs/legacy-update-contract.md](docs/legacy-update-contract.md)。

工作流发布 Windows x64、Windows 7 x64、Linux x64 `.deb` 和 Apple Silicon macOS `.dmg`。Intel Mac 暂不打包。Linux 在 Ubuntu 22.04 构建并校验最高 GLIBC 需求不超过 2.35。macOS 包一律使用 ad-hoc / 未签名分发，不需要 Apple Developer ID 证书，也不做公证；玩家首次打开时可能需要在系统设置里允许运行。

Windows 7 必须使用单独的 `(Win7)` 安装包：除了官方的 `x86_64-win7-windows-msvc` + WebView2 109 固定运行时，安装程序还会把 VC++ 2015-2022 和 Universal CRT 放到启动器旁边。限制和真机验收步骤见 [docs/windows7.md](docs/windows7.md)。

## 离线使用与 Microsoft 登录

不需要 FPSMaster 账号。保留 Microsoft 正版登录和本地离线账号。客户端包下载失败时可选择手动导入可信的 jar；也可在实例设置 → 模组中导入（Edge 须启用 Forge）。手动导入后保留其它模组，不再自动替换客户端包。

Microsoft 登录仍依赖 Azure 应用注册和 Microsoft/Mojang 服务，维护者必须保留注册。Fork 替换 client id 与构建步骤见 [docs/FORKING.md](docs/FORKING.md)。离线账号不需要这些服务，但不能用于要求正版验证的服务器。
