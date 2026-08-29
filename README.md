# FPSMaster Launcher

Minecraft launcher architecture with:

- Tauri + React UI
- Rust command bridge and launcher core

## Project Layout

- `tauri-app/`: Tauri + React desktop frontend and Rust command layer
- `reference/HMCL/HMCL/`: HMCL reference codebase for behaviour parity

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
- 只有推送 `v*` 语义化版本 tag 才会真正发版：构建安装包、创建 GitHub Release，并调用后端发布接口登记桌面端更新。

tag 到更新通道的映射（仅保留 beta / release）：

- `v0.3.15` -> `release` / 版本号 `0.3.15`
- `v0.3.15-beta.1` -> `beta` / 版本号 `0.3.15-beta.1`

更新日志取自被打 tag 的那个 commit 的提交信息，会直接展示给玩家。写法要求见 [docs/release-notes.md](docs/release-notes.md)。

GitHub 仓库需要配置以下 Secrets：

- `FPSMASTER_CI_API_BASE_URL`：后端 API 地址
- `FPSMASTER_CI_UPLOAD_TOKEN`：后端配置项 `fps.launcher.ci-upload-token`
- `QINIU_ACCESS_KEY`、`QINIU_SECRET_KEY`、`QINIU_BUCKET`、`QINIU_S3_ENDPOINT`、`QINIU_S3_REGION`、`QINIU_CDN_BASE_URL`：发布包上传配置

工作流发布 Windows x64、Windows 7 x64、Linux x64 `.deb` 和 Apple Silicon macOS `.dmg`。Intel Mac 暂不打包。Linux 在 Ubuntu 22.04 构建并校验最高 GLIBC 需求不超过 2.35。macOS 包一律使用 ad-hoc / 未签名分发，不需要 Apple Developer ID 证书，也不做公证；玩家首次打开时可能需要在系统设置里允许运行。

发布回调接口为 `POST /api/v1/launcher/releases/ci`，`productCode` 固定为 `launcher`，`target` 按产物平台填写。
