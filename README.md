# FPSMaster Launcher

Minecraft launcher architecture with:

- Tauri + React UI
- Rust command bridge (lightweight tasks such as JDK management)
- Java launcher core (game install and launch metadata logic)

## Project Layout

- `java-core/`: Java core for vanilla install + launch command assembly
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

- 所有 `pull_request` 和命中的 `push` 都会执行 Windows 打包校验。
- 命中发布分支时，会自动构建 NSIS 安装包、创建 GitHub Release，并调用后端发布接口登记桌面端更新。

分支到更新通道的映射：

- `master` -> `beta`
- `nightly`、`nightly/*` -> `nightly`
- `cannary`、`cannary/*` -> `cannary`
- `beta`、`beta/*` -> `beta`
- `release`、`release/*` -> `release`

保留 `master -> beta` 的原因是当前桌面端默认更新通道为 `beta`，内测阶段需要让主分支推送的版本能被现有用户接收到。

GitHub 仓库需要配置以下 Secrets：

- `FPSMASTER_CI_API_BASE_URL`：后端 API 地址
- `FPSMASTER_CI_UPLOAD_TOKEN`：后端配置项 `fps.launcher.ci-upload-token`

工作流构建命令为 `npm run build:installer`，发布产物路径为 `tauri-app/src-tauri/target/release/bundle/nsis/*.exe`，回调接口为 `POST /api/v1/launcher/releases/ci`，其中 `productCode` 固定为 `launcher`，`target` 固定为 `windows-x86_64`。
