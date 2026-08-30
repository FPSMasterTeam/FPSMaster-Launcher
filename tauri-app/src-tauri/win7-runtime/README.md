# Windows 7 runtime payload

This folder is filled by `scripts/prepare-win7-runtime.ps1` on the Windows CI
image (or a local VS 2022 + Windows SDK machine). Do not commit the DLLs.

The script copies:

- Visual C++ 2015-2022 x64 CRT (`vcruntime140.dll`, `msvcp140.dll`, …)
- Universal CRT app-local files from the Windows SDK (`ucrtbase.dll` and
  `api-ms-win-*.dll`)
- `vc_redist.x64.exe` for an optional system-wide install
- `Windows6.1-KB2999226-x64.msu` when Microsoft's download is reachable

The NSIS hook then copies every `*.dll` next to `fpsmaster-launcher.exe`.
On Windows 7 the UCRT API-set forwarders only resolve `ucrtbase.dll` from the
main executable directory.
