# 旧版启动器的最终升级契约

根据最终版分支改造前的 `7ffb8df` 核实。此处仅用于后端 sunset 迁移，不是最终版的新联网依赖。

## 请求

```http
GET /api/v1/launcher/app-update?target=windows-x86_64&installId=<persistent-UUID>&channel=release
Accept-Language: zh-CN
User-Agent: <launcher user agent>
```

不需要 Authorization，无请求签名。`installId` 是本地持久 UUID。`channel` 可省略，有值时 trim 后小写。

`target` 为 `<windows|macos|linux>-<x86_64|aarch64|x86|unknown>`，Windows 7 及以下另加 `-win7`。当前 CI 产物只有：

- `windows-x86_64`
- `windows-x86_64-win7`
- `linux-x86_64`
- `macos-aarch64`

未提供的平台应返回 404，不可用其它架构安装包冒充。

## 响应

返回 HTTP 200，JSON：

```json
{
  "success": true,
  "code": null,
  "message": null,
  "data": {
    "version": "1.0.0",
    "downloadUrl": "https://github.com/OWNER/REPO/releases/download/TAG/installer.exe",
    "notes": "最终版更新日志",
    "publishedAt": "2026-11-04T00:00:00Z",
    "mandatory": true,
    "checksum": "<SHA256 of exact installer bytes, 64 hex characters>",
    "fileSize": 123,
    "target": "windows-x86_64"
  }
}
```

也兼容直接返回 `data` 中的对象。`version`、`downloadUrl`、`mandatory`、`target` 必填；`notes`、`publishedAt`、`fileSize` 可以省略或 null。

`checksum` 在解析时可缺失，但下载阶段强制要求有效 SHA256。支持纯 64 位 hex，以及 `sha256:` / `SHA256:` 前缀。必须来自最终安装包，不能填客户端 jar 的 hash。

旧版没有数字签名验证，不接收 Tauri updater 的 `signature` 来替代 SHA256。它先比较版本，下载比本机更新的安装器并校验，再调用系统打开，Windows 随即退出启动器。`mandatory: true` 可以引导旧版用户进入最后一次更新流程。不要返回最终版自身依赖的新格式。

发布时人工把各平台真实 GitHub Releases URL 和 hash 配到后端即可，不再需要启动器 CI 上传七牛或登记 API。此工作流不自动发布任何产物。
