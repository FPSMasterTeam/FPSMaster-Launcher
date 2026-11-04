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

- 修改 Tauri 配置中的 `identifier`、`productName`、窗口标题、图标，以及 `package.json` / Cargo / Tauri 的同步版本号。
- 将 `catalog.rs` 的 GitHub raw / jsDelivr URL 换为自己的仓库。
- 使用 `catalog/build_catalog.py` 根据真实发布文件重新生成 URL、大小与 SHA256，增加 `revision`，不要发布草稿中的占位 URL。
- 当前 catalog 自更新是安装包 SHA256 校验，不是数字签名。签名清单升级仍待实现，不要把它描述为已完成。
- 旧启动器迁移由后端 sunset 配置人工完成，见 `legacy-update-contract.md`，CI 不再调用后端。

## 手动导入客户端

在实例设置 → 模组 → 导入客户端 jar，选择与游戏版本匹配、可信来源的 Edge Forge 或 Nova Fabric jar。下载客户端包失败时也会提供导入选项。Edge Forge-free AOT 不能用普通 mod jar 替代。

导入会检查 ZIP 和 mod id，保存本地 SHA256，并仅替换启动器管理的客户端包，保留其它模组。mod id 和 SHA256 不是发布者签名，不能替代来源信任。导入后的包标记为 `local:`，不会被 catalog 更新替换；再次导入即可更换。
