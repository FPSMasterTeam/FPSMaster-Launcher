# 静态发布目录（catalog）

FPSMaster 后端关停后，启动器不再通过 `/api/v1/launcher/releases/available`（需要 FPSMaster 账号）
获取可安装的客户端版本，也不再通过 `/api/v1/launcher/app-update` 检查自身更新。两件事都改为读取本目录的
`catalog.json`。

## 启动器如何读取

实现见 `tauri-app/src-tauri/src/catalog.rs`。

1. **内置副本**：编译时把 `catalog.json` 打进启动器，断网的全新安装也能用。
2. **远程副本**：依次尝试 GitHub raw 和 jsDelivr 镜像（超时 6 秒），这样发布之后仍然可以修正目录。
3. **本地缓存**：最近一次成功拿到的远程副本，存放在应用数据目录的 `catalog-cache.json`。

三者中有效且 `revision` 最大的那份生效。校验规则：
- `downloadUrl` 必须是 https；
- `checksum` 必须是 64 位 sha256；
- Nova 条目必须带 `gameVersion`；
- 只保留 EDGE 和 NOVA；
- 启动器更新一律视为非强制。

校验不通过的条目会被丢弃；整份不可用时，回退到内置副本。

## 如何更新

1. 把产物上传到对应仓库的 GitHub Release。
2. 用本地的同一份文件运行生成脚本（脚本会计算 sha256），`--revision` 必须比当前值大：

```bash
python3 catalog/build_catalog.py --revision 2 --client-version 2.0.0 --launcher-version 1.0.0 \
  --client edge=dist/FPSMaster-Edge-2.0.0.jar@https://github.com/FPSMasterTeam/FPSMaster-Edge/releases/download/v2.0.0/FPSMaster-Edge-2.0.0.jar \
  --edge-aot dist/fpsmaster-edge-aot-2.0.0.zip@https://github.com/FPSMasterTeam/FPSMaster-Edge/releases/download/v2.0.0/fpsmaster-edge-aot-2.0.0.zip \
  --client nova:1.21.11=dist/fpsmaster-nova-1.21.11-2.0.0.jar@https://github.com/FPSMasterTeam/FPSMaster-Nova/releases/download/v2.0.0/fpsmaster-nova-1.21.11-2.0.0.jar \
  --launcher windows-x86_64=dist/FPSMaster-Launcher_1.0.0_x64-setup.exe@https://github.com/FPSMasterTeam/FPSMaster-Launcher/releases/download/v1.0.0/FPSMaster-Launcher_1.0.0_x64-setup.exe \
  --recommended-nova 1.21.11
```

3. 运行 `cargo test catalog`。其中 `bundled_catalog_is_valid` 会拒绝不可用的目录。
4. 提交到 `master` 后，已安装的启动器下次启动就会拿到新目录。

> ⚠️ 当前的 `catalog.json`（revision 1）是用 8 月的预发布构建生成的**草稿**，其中的 URL 还不存在。
> 发布最终版时必须重新生成。
