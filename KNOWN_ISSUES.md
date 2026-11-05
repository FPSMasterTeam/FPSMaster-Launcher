# 已知问题与限制（最终版）

## 发布前必须处理

- **catalog revision 1 是草稿。** `catalog/catalog.json` 中的 URL 尚不存在、hash 来自预发布构建、缺 Edge AOT 条目。发布前必须用 `catalog/build_catalog.py` 基于最终产物重新生成（见 `catalog/README.md`），不得发布当前草稿。

## 更新信任模型（已确定）

- 自更新保留 GitHub `catalog.json` + 安装包 **SHA-256** 校验，**不做数字签名**，不引入 Tauri updater 插件或签名密钥。这是最终版的明确决策，不是待开发事项。
- 信任锚是 GitHub HTTPS 与仓库/Release 的控制权；远程 catalog 也可经 jsDelivr HTTPS 镜像取得，镜像属于额外信任边界。发布者必须保护 GitHub 账号、仓库写权限和发布工作流。
- SHA-256 能检测安装包损坏或与目录不一致，不能独立证明发布者身份。若攻击者同时控制 catalog 与产物，哈希校验不能防止恶意更新。内置副本与缓存也不等于数字签名或防回滚机制。

## 未完成的真机验证

以下项已实现并有单元测试，但尚未在真机完成验收：

- 全新游戏数据目录 + 离线账号的完整启动流程；
- 原版安装并启动到主菜单；
- 运行时零 FPSMaster 域名请求的抓包证据（目前只有静态调用路径核实）；
- 真实最终 jar 的手动导入（目前只测过合成 metadata jar）；
- Windows / Linux / Windows 7 / macOS x64 平台验证（本机无对应环境）；
- Windows 7 兼容层（固定 WebView2 109 + VC++/UCRT 随附）未在真机验证，验收步骤见 `docs/windows7.md`。

## 设计限制（非缺陷）

- 系统钥匙串不可用时的文件密钥降级（需用户明确同意）对全部凭据生效，包括正版登录 token：主密钥与密文同目录、0600 权限，防随手翻看、不防同用户取证。同意弹窗已就此明示；这是停更产品的明确取舍，不引入第二套密钥管理。

- 离线账号不能加入要求正版验证的服务器。
- Microsoft 正版登录依赖 Azure 应用注册与 Microsoft/Mojang 服务；这些服务不可用时不影响离线账号。
- BMCLAPI 镜像为第三方公共服务，其可用性不受本项目控制；镜像仅作传输层，内容以官方 hash 校验。
- Intel Mac 不打包；macOS 安装包为 ad-hoc 签名、未公证，首次打开可能需要在系统设置里允许运行。
- Edge 的 Forge-free AOT 路径不能用普通 mod jar 替代客户端包。

## 代码层面

- 前端 lint 存在 51 个历史 warning（React hooks 依赖、未使用变量等），基线与最终版保持一致；按真实缺陷逐个修复，不做批量压制。
