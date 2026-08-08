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

工作流构建命令为 `npm run build:installer`，发布产物路径为 `tauri-app/src-tauri/target/release/bundle/nsis/*.exe`，回调接口为 `POST /api/v1/launcher/releases/ci`，其中 `productCode` 固定为 `launcher`，`target` 固定为 `windows-x86_64`。
