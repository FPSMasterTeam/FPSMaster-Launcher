# FPSMaster Launcher

> **本项目停止维护（`<停止维护日期>`）。** 最终版本为 **1.0.0**，本仓库保留源代码，供自行构建与 fork。不再提供日常维护或功能更新。
>
> 安装包下载：[GitHub Releases](https://github.com/FPSMasterTeam/FPSMaster-Launcher/releases)。最终产物以该页面实际发布为准；当前开发版本仍是 0.4.0，发布前的限制见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 这是什么

FPSMaster 启动器是一个离线可用的 Minecraft 启动器：

- Tauri 2 + React 桌面界面，Rust 命令层与启动核心
- 原版 / Forge / Fabric 自动安装，Edge（Forge 或 Forge-free AOT）与 Nova 预设客户端
- Microsoft 正版登录与本地离线账号，不需要 FPSMaster 账号
- 整合包导入（Modrinth `.mrpack`）、实例管理、诊断与本地支持包导出
- 版本列表与自更新读取本仓库的静态 catalog，无任何 FPSMaster 后端依赖

## 下载

- Windows x64 / Windows 7 x64 / Linux x64（.deb）/ Apple Silicon macOS（.dmg）安装包都在 [GitHub Releases](https://github.com/FPSMasterTeam/FPSMaster-Launcher/releases)。
- Windows 7 必须使用单独的 `(Win7)` 安装包，见 [docs/windows7.md](docs/windows7.md)。
- macOS 包为 ad-hoc 签名、未公证，首次打开可能需要在系统设置里允许运行。Intel Mac 不打包。

## 怎么构建

需要 Node.js、npm、Rust 稳定版和对应系统的 Tauri 2 构建依赖。

```sh
cd tauri-app
npm ci
npm run typecheck   # TypeScript 检查
npm test            # 前端单元测试
npm run lint        # ESLint
npm run build       # 前端产物
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单元测试
npm run tauri dev   # 开发运行
```

首次安装依赖、下载 Minecraft / Java / 加载器需要网络；已有完整实例可以离线直接启动。详细构建与 fork 说明见 [docs/FORKING.md](docs/FORKING.md)，架构概览见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，已知问题见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 目录结构

- `tauri-app/`：Tauri + React 桌面前端与 Rust 命令层
  - `src/`：React 页面、组件、hooks 与前端逻辑
  - `src-tauri/src/`：Rust 命令层、catalog、下载器、启动核心、诊断、安全存储
- `catalog/`：静态发布目录 `catalog.json` 与生成脚本 `build_catalog.py`
- `docs/`：fork、架构、旧版迁移契约、更新日志规范、Windows 7 说明
- `.github/workflows/`：GitHub Actions 打包与发版

## 离线使用与 Microsoft 登录

不需要 FPSMaster 账号。保留 Microsoft 正版登录和本地离线账号。客户端包下载失败时可选择手动导入可信的 jar；也可在实例设置 → 模组中导入（Edge 须启用 Forge）。手动导入后保留其它模组，不再自动替换客户端包。

Microsoft 登录仍依赖 Azure 应用注册和 Microsoft/Mojang 服务，维护者必须保留注册。Fork 替换 client id 与构建步骤见 [docs/FORKING.md](docs/FORKING.md)。离线账号不需要这些服务，但不能用于要求正版验证的服务器。

## CI/CD Release

只有推送 `v*` 语义化版本 tag 才会发版：构建安装包、创建 GitHub Release；`pull_request` 和 `master` 的 push 只做打包校验。tag 到更新通道的映射仅保留 beta / release（如 `v1.0.0-beta.1` → beta）。

更新日志取自被打 tag 的那个 commit 的提交信息，会直接展示给玩家，写法要求见 [docs/release-notes.md](docs/release-notes.md)。

发布只依赖 GitHub Releases。旧版启动器的最后一次升级由后端 sunset 配置人工指向 GitHub 安装包，不再由 CI 上传七牛或调用后端。迁移契约见 [docs/legacy-update-contract.md](docs/legacy-update-contract.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方组件声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
