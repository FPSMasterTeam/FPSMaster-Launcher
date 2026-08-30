# Windows 7 启动器兼容说明

普通 Windows 安装包不能在 Windows 7 上运行。玩家必须使用带 `(Win7)` 后缀的安装包。

## 已经做了什么

官方 Tauri 文档只要求两件事：用 `x86_64-win7-windows-msvc` 编译，以及捆绑 WebView2 **109.0.1518.78** 固定运行时。这两项仓库里早就有了，但真实 Win7 机器上仍然会缺运行库。

这次补上的是用户真正碰到的那一层：

1. **Rust `x86_64-win7-windows-msvc` + `build-std`**  
   避免把 `ProcessPrng` 等 Windows 10 API 写进导入表。
2. **WebView2 Fixed Runtime 109.0.1518.78**  
   110 及以后的 Evergreen / offline installer 不再支持 Windows 7。
3. **把 VC++ 2015-2022 与 Universal CRT 放到 exe 旁边**  
   解决 `vcruntime140.dll`、`msvcp140.dll`、`api-ms-win-crt-*.dll`、`ucrtbase.dll` 缺失。  
   Microsoft 明确允许（但不推荐）从 Windows SDK 的 `Redist\ucrt\DLLs\x64` 做 app-local 部署；在 Windows 7 上这些文件必须和主程序在同一目录。
4. **NSIS 安装钩子**  
   - 拒绝 32 位系统和未打 SP1 的 Windows 7 RTM  
   - 把 `win7-runtime\*.dll` 复制到安装目录和 WebView2 109 目录  
   - 有管理员权限时静默安装 `vc_redist.x64.exe`，必要时再装 KB2999226
5. **启动前检查**  
   WebView2 / 运行库仍缺失时弹出中英双语说明，而不是只显示系统的“找不到 DLL”。
6. **壁纸读取回退到 `SystemParametersInfo(SPI_GETDESKWALLPAPER)`**  
   `IDesktopWallpaper` 是 Windows 8 才有的接口。

## 仍然无法保证的限制

- **只要 Windows 7 SP1 x64（6.1.7601）。** RTM、32 位、Vista 都不支持。
- 未安装 [KB3033929](https://support.microsoft.com/kb/3033929)（SHA-2 代码签名）的机器，可能无法运行较新的 `vc_redist.x64.exe` 或 MSU。app-local DLL 不依赖这次安装。
- WebView2 **109 已停止安全更新**。这是 Microsoft 最后一个能在 Win7 上跑的版本。
- Tauri 从 2.12 起不再承诺 Windows 7。本仓库钉在 Tauri **2.10**。升级 Tauri / wry / webview2-com 前必须重新在 Win7 SP1 上验证。
- Liquid Glass、亚克力、部分较新的 CSS 在 WebView2 109 上会降级。
- 自更新必须走 `windows-x86_64-win7` 通道。普通包升级到 Win7 机器上会再次出现缺 DLL / 无法创建 WebView。

## 维护者如何在真实 Win7 上验收

准备一台 **Windows 7 SP1 x64**，尽量满足这两种情况各测一次：

1. **“干净”机器**：没有 VC++ 2015-2022，没有 KB2999226，没有 WebView2。
2. **只打了 SP1 的机器**：有 SHA-2（KB3033929）更好，便于验证可选的 `vc_redist` / MSU 路径。

步骤：

1. 安装 CI 产出的 `*win7*` NSIS 包，不要用普通 Windows 包。
2. 确认安装目录同时存在：
   - `fpsmaster-launcher.exe`
   - `ucrtbase.dll`、`vcruntime140.dll`、`vcruntime140_1.dll`、`msvcp140.dll`
   - 若干 `api-ms-win-crt-*.dll`
   - `Microsoft.WebView2.FixedVersionRuntime.109.0.1518.78.x64\EBWebView\x64\EmbeddedBrowserWebView.dll`
   - `win7-runtime\vc_redist.x64.exe`
3. 启动启动器，应进入登录页，而不是缺 DLL 对话框。
4. 登录、打开首页、启动一个已安装实例（或至少走完准备阶段）。
5. 故意删掉安装目录里的 `ucrtbase.dll`（若 System32 也没有）或 WebView2 目录，再启动，应看到启动器自己的中英错误说明。
6. 在 Windows 10/11 上抽查：普通安装包行为不变；Win7 包也可以启动，但玩家应继续使用对应通道更新。

本地打包（仅 Windows + VS 2022 + Windows SDK）：

```powershell
cd tauri-app/src-tauri
powershell -File scripts/prepare-win7-runtime.ps1
# 另按 CI 下载并解压 WebView2 109 cab
cd ..
npm run build:installer:windows:win7
python src-tauri/scripts/verify-win7-pe.py --binary src-tauri/target/x86_64-win7-windows-msvc/release/fpsmaster-launcher.exe
```

## 参考

- [Tauri Windows Installer / Supporting Windows 7](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri #10501](https://github.com/tauri-apps/tauri/issues/10501) Evergreen / bootstrapper 在 Win7 上不可用，只能绑 109
- [Tauri #6800](https://github.com/tauri-apps/tauri/issues/6800) 缺少 `api-ms-win-crt-*.dll`
- [Tauri #10834](https://github.com/tauri-apps/tauri/issues/10834) / [aws-lc #1997](https://github.com/aws/aws-lc/issues/1997) `ProcessPrng`
- [Tauri #12550](https://github.com/tauri-apps/tauri/issues/12550) 2.12 起放弃 Win7
- [Tauri #11381](https://github.com/tauri-apps/tauri/issues/11381) 以及 [yangziwen 的 Win7 适配笔记](https://yangziwen.cn/zh/blog/tauri/win7)
- [Microsoft Universal CRT deployment](https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment)
- [Microsoft WebView2 on Windows 7/8](https://learn.microsoft.com/en-us/microsoft-edge/webview2/#windows-7-and-8)
- [westinyang/WebView2RuntimeArchive 109.0.1518.78](https://github.com/westinyang/WebView2RuntimeArchive/releases/tag/109.0.1518.78)
- [Rust `x86_64-win7-windows-msvc`](https://doc.rust-lang.org/rustc/platform-support/win7-windows-msvc.html)
