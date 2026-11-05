# 架构概览

启动器是 Tauri 2 应用：React 前端通过 IPC 调用 Rust 命令层，下载、安装与启动核心在 Rust 侧完成。FPSMaster 后端依赖已移除；仍访问静态 catalog、Microsoft/Mojang、加载器、内容平台、镜像与部分图片/字体服务，不等于整个应用完全不联网。

## Rust 命令层（`tauri-app/src-tauri/src/`）

- `main.rs`：Tauri 命令入口与实例/运行时管理。IPC 命令、JDK 管理、离线就绪校验（`get_offline_launch_readiness`）、客户端包安装与本地 jar 导入、自定义 JVM/窗口参数注入（`apply_custom_launch_options`）。
- `catalog.rs`：静态发布目录。内置副本、远程副本（GitHub raw / jsDelivr，每次请求 6 秒超时）、本地缓存三者取 `revision` 最大且校验通过者；条目校验失败即丢弃。
- `downloader.rs`：统一下载器。`.part` 续传（If-Range/校验和保护）、大文件 Range 分段与分段重试、指数退避、候选源故障转移、镜像健康度排序；连接失败类错误不对同一源退避重试，保证断网快速失败。每读空闲 30 秒超时，避免无限卡住。
- `minecraft_core.rs`：启动核心。版本 JSON 解析与继承、库/资源解析与补齐、natives 隔离解压、原版与 Edge AOT 启动计划构建。离线模式（`VanillaLaunchRequest.offline`）下不解析下载源、不下载日志配置，仅用本地缓存，缺文件立即报错。
- `microsoft_auth.rs`：Microsoft 正版登录（授权码 + PKCE / 设备码），公开客户端，无 client secret。client id 可被环境变量覆盖，见 `docs/FORKING.md`。
- `secure_storage.rs`：凭据加密存储。AES-256-GCM 主密钥放系统钥匙串，keyring service 跟随 app identifier（验证/ fork 构建不会触碰发行版条目）；系统凭据存储不可用时可在用户同意后退回 0600 文件。
- `diagnostics.rs`：崩溃检测、下载源测速、健康检查与支持包导出。导出纯本地完成，所有文本条目统一脱敏（token、私钥、用户路径、邮箱等）。
- `modpack.rs`：Modrinth `.mrpack` 整合包导入；CurseForge 分发限制按协议处理。
- `launcher_api.rs`：catalog 使用的发布/更新数据结构、安装包下载（SHA-256 校验）与打开安装包命令。保留旧 manifest 信封解析兼容，不再提供 FPSMaster 账号或后端请求。
- `win7_compat.rs`：Windows 7 兼容层（固定 WebView2 109、VC++/UCRT 随附），见 `docs/windows7.md`。
- `zip_budget.rs`：ZIP 解压的条目数/大小/路径预算，防 zip bomb 与目录逃逸。

## 前端（`tauri-app/src/`）

- `pages/`：Home（实例与快速启动）、Instances、InstanceSettings（含模组与本地 jar 导入、实例级启动参数）、Install、Content（模组/资源包等内容管理）、Monitor（游戏运行监控）、Diagnostics（健康检查与支持包）、Settings（全局设置、全局启动参数、关于与更新）。
- `App.tsx`：启动流程编排——本地就绪校验、发布门控（catalog 不可用时本地就绪可降级）、账号就绪、JDK 准备、`launch_vanilla` IPC。
- `lib/launchOptions.ts`：全局/实例启动参数（内存、Java 路径、JVM 参数、窗口尺寸）的规范化与继承合并，留空继承全局。
- `hooks/`：账号、安装控制器、自更新、响应式布局等状态。
- `i18n.tsx` + `locales/`：中英文界面文案。

## 数据流要点

- 版本列表与自更新：catalog（见上），不再有任何 FPSMaster API。更新信任锚为 GitHub HTTPS（含 jsDelivr HTTPS 镜像边界），只做 SHA-256、不做数字签名。
- Minecraft 资源：Mojang 官方源与 BMCLAPI 镜像，按下载器策略选择；镜像仅作传输层，内容以官方 hash 校验。
- 启动：本地就绪 → 离线直启；不就绪 → 联网补齐，断网快速失败并明确提示。
