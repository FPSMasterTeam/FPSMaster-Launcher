# Fork 与离线运行

## 构建

使用 Node.js、npm、Rust 稳定版和对应系统的 Tauri 2 构建依赖。

```sh
cd tauri-app
npm ci
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

首次安装依赖、下载 Minecraft、Java 和加载器需要网络；已有完整实例可以用首页的快速启动跳过联网准备。离线账号不能加入要求正版验证的服务器。

## Microsoft / Azure 应用注册

FPSMaster 账号系统已移除，Microsoft 正版登录仍直接访问 Microsoft、Xbox Live 和 Mojang。**原版发行的维护者必须长期保留 Azure 应用注册**。删除或禁用它会使正版登录失效，已经安装启动器也会受影响。

Fork 应创建自己的 Microsoft Entra / Azure 应用注册，支持个人 Microsoft 账号，并按微软要求取得 Minecraft API 使用权限。它是公开客户端，使用授权码 + PKCE 或设备码登录，**不要在启动器里放 client secret**。

配置 client id 的优先级如下：

1. 运行时 `FPSMASTER_MINECRAFT_CLIENT_ID`
2. 运行时 `MICROSOFT_CLIENT_ID`
3. 编译时上述两个环境变量（同顺序）
4. `src-tauri/src/microsoft_auth.rs` 的内置公开 client id

浏览器登录默认使用本机 loopback 回调。自定义回调可通过运行时或编译时 `FPSMASTER_MINECRAFT_REDIRECT_URL` 设置；必须与 Azure 注册允许的 redirect URI 一致。设备码登录也必须允许 public-client flow。更改编译时环境变量后须重新构建 Rust 产物。

## 品牌与发布来源

- 修改 `tauri-app/src-tauri/tauri.conf.json` 中的 `identifier`（原为 `com.fpsmaster.launcher`）、`productName`、窗口标题与图标，以及 Windows/Win7 平台覆盖配置中的品牌设置。独立 identifier 同时隔离应用数据目录与钥匙串 service，不要复用原发行版标识。
- 在 `tauri-app/package.json` 设置版本，运行 `npm run version:sync` 同步 package-lock、Cargo.toml / Cargo.lock 与 Tauri 配置；不要仅改单个版本字段。仓库当前开发版本仍是 0.4.0，最终 1.0.0 的版本同步在发布准备时完成。
- 将 `tauri-app/src-tauri/src/catalog.rs` 的 `REMOTE_CATALOG_URLS` 中 GitHub raw / jsDelivr 地址与分支一起换为自己的仓库。内置副本路径仍是 `catalog/catalog.json`；仅替换远程地址不会替换内置产物来源。
- 使用 `catalog/build_catalog.py` 根据真实发布文件重新生成 URL、大小与 SHA256，增加 `revision`，不要发布草稿中的占位 URL。
- 最终版明确保留 GitHub catalog + 安装包 SHA-256 校验，不做数字签名，不需要 Tauri updater 插件或签名密钥。信任锚是 GitHub HTTPS 与仓库控制权（使用 jsDelivr 时也信任该 HTTPS 镜像）；保护仓库与发布权限。哈希不是发布者身份签名，不能抵抗 catalog 与产物同时被篡改。
- 旧启动器迁移由后端 sunset 配置人工完成，见 `legacy-update-contract.md`，CI 不再调用后端。

## 自行发布

1. 修改品牌、identifier、Microsoft client id 与 catalog 地址，检查 README、Cargo `repository`、工作流与所有产物 URL 不再指向原仓库。
2. 按上述方法同步版本，执行 typecheck、前端测试、lint、build 与 Rust 测试。各平台在自己的构建环境做真机验证，特别是 Windows 7。
3. 阅读 `.github/workflows/ci-release.yml`：PR、分支 push 与手动工作流只做构建校验；语义化 `v*` tag 才创建 GitHub Release。`v1.0.0` 属于 release 通道，带预发布后缀的 tag 属于 beta。Fork 必须自行授权并配置发布权限，不能沿用原仓库私有凭据。
4. 发布时使用的 commit message 会成为玩家看到的更新说明，遵守 `release-notes.md`。macOS 当前为 ad-hoc 签名/不公证，不要求 Apple Developer ID；这与未使用自更新数字签名是两件事。
5. 用实际 Release 文件与准确 URL 运行 `catalog/build_catalog.py`，包含 Edge jar、Edge AOT、各 Minecraft 版本的 Nova 和各平台启动器条目；增加 `revision`，运行 `cargo test catalog`，核对大小/hash/URL。示例见 `../catalog/README.md`，不要照抄其中示例产物版本。
6. 把更新后的 catalog 提交到 `REMOTE_CATALOG_URLS` 所指分支。若最终安装包还要内置新目录，先准备客户端目录再构建启动器，上传安装包后再补远程启动器条目，避免自包含安装包 hash 的循环依赖。

本文描述发布流程，不代表已创建 tag、上传产物或发布最终版。停止维护日期统一保留为 `<停止维护日期>`，实际发布时再替换。

## 手动导入客户端

在实例设置 → 模组 → 导入客户端 jar，选择与游戏版本匹配、可信来源的 Edge Forge 或 Nova Fabric jar。下载客户端包失败时也会提供导入选项。Edge Forge-free AOT 不能用普通 mod jar 替代。

导入会检查 ZIP 和 mod id，保存本地 SHA256，并仅替换启动器管理的客户端包，保留其它模组。mod id 和 SHA256 不是发布者签名，不能替代来源信任。导入后的包标记为 `local:`，不会被 catalog 更新替换；再次导入即可更换。
