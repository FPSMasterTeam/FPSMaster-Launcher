# 静态发布目录（catalog）

FPSMaster 后端关停后，启动器不再通过 `/api/v1/launcher/releases/available`（需要 FPSMaster 账号）
获取可安装的客户端版本，也不再通过 `/api/v1/launcher/app-update` 检查自身更新。两件事都改为读取本目录的
`catalog.json`。

## 启动器如何读取

实现见 `tauri-app/src-tauri/src/catalog.rs`。

1. **内置副本**：编译时把 `catalog.json` 打进启动器，断网的全新安装也能用。
2. **远程副本**：并行请求 GitHub raw 和 jsDelivr 镜像，首个有效结果生效，单源超时 6 秒，双源均无响应时最坏约 6 秒，这样发布之后仍然可以修正目录。
3. **本地缓存**：最近一次成功拿到的远程副本，存放在应用数据目录的 `catalog-cache.json`。

三者中有效且 `revision` 最大的那份生效。校验规则：
- `downloadUrl` 必须是 https；
- `checksum` 必须是 64 位 sha256；
- Nova 条目必须带 `gameVersion`；
- 只保留 EDGE 和 NOVA；
- 启动器更新一律视为非强制。

校验不通过的条目会被丢弃；整份不可用时，回退到内置副本。

远程刷新在后台任务中运行，不阻塞主界面与本地实例列表渲染。已就绪实例启动先检查本地文件，
不等远程 catalog；需要安装/修复的预设操作可能等待刷新。自动刷新没有可见的 loading 提示，
也没有“跳过/强制内置”的 UI。成功或失败都会写 30 分钟 TTL 标记（成功即缓存文件本身，
失败是 `catalog-fetch.failed` 空文件），TTL 内的重复解析直接跳过网络，因此单次运行里
启动检查与页面触发只会请求一次，断网重启也不会每个页面都重新等待。
不要将后台请求用时与“窗口卡住”混为一谈，实际交互仍需 GUI 验收。

本地故障注入检查（不访问生产，仅隔离源码副本替换 catalog URL；数值为串行实现时实测，
并行后双源无响应上界约为单源超时 6 秒加少量调度余量）：
404 约 182ms、200 但无效 JSON 约 145ms、双源无响应约 12131ms；
三者均不覆盖本地 catalog，最终保留内置副本或 revision 更高的已有缓存。
HTTPS CONNECT 在代理层返回 404 只属于传输失败，不等同于源站返回 HTTP 404；
无效 JSON 及源站 404 不应通过篡改加密流量伪造。

## 如何更新

1. 把产物上传到对应仓库的 GitHub Release。
2. 用本地的同一份文件运行生成脚本（脚本会计算 sha256），`--revision` 必须比当前值大：

```bash
python3 catalog/build_catalog.py --revision 2 --edge-version 2.0.0-final --nova-version 1.0.0 --launcher-version 1.0.0 \
  --client edge=dist/FPSMaster-Edge-2.0.0-final.jar@https://github.com/FPSMasterTeam/FPSMaster-Edge/releases/download/v2.0.0-final/FPSMaster-Edge-2.0.0-final.jar \
  --edge-aot dist/fpsmaster-edge-aot-2.0.0-final.zip@https://github.com/FPSMasterTeam/FPSMaster-Edge/releases/download/v2.0.0-final/fpsmaster-edge-aot-2.0.0-final.zip \
  --client nova:1.21.11=dist/fpsmaster-nova-1.21.11-1.0.0.jar@https://github.com/FPSMasterTeam/FPSMaster-Nova/releases/download/v1.0.0/fpsmaster-nova-1.21.11-1.0.0.jar \
  --launcher windows-x86_64=dist/FPSMaster-Launcher_1.0.0_x64-setup.exe@https://github.com/FPSMasterTeam/FPSMaster-Launcher/releases/download/v1.0.0/FPSMaster-Launcher_1.0.0_x64-setup.exe \
  --recommended-nova 1.21.11
```

`--edge-version` 与 `--nova-version` 分别指定产品版本，没有全局兜底：列了某个产品的条目就必须给对应版本参数，防止 Edge/Nova 最终版本号被误填成同一个值。
上面文件名和 Release URL 是示例，必须按真实最终资产核对，运行命令本身不会上传或发布。

3. 运行 `cargo test catalog`。其中 `bundled_catalog_is_valid` 会拒绝不可用的目录。
4. 提交到 `master` 后，已安装的启动器下次启动就会拿到新目录。

> ⚠️ 当前的 `catalog.json`（revision 1）是用 8 月的预发布构建生成的**草稿**，其中的 URL 还不存在。
> 发布最终版时必须重新生成。
