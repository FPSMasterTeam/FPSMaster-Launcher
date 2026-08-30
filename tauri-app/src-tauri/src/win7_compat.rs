//! Windows 7 launch-time compatibility helpers.
//!
//! The official Tauri Win7 recipe (`x86_64-win7-windows-msvc` + WebView2 109
//! fixed runtime) is not enough on real machines: VC++ 2015-2022 and the
//! Universal CRT are often missing, and WebView2 109 still dynamically loads
//! those DLLs. This module:
//!
//! - puts the executable directory on the DLL search path so app-local CRT/UCRT
//!   files next to the exe can be found (required on Win7; see Microsoft
//!   Universal CRT local-deployment notes);
//! - checks OS / runtime files before Tauri/WebView2 initialize;
//! - shows a bilingual error instead of a raw missing-DLL dialog.

use std::path::{Path, PathBuf};

pub const WEBVIEW2_FIXED_RUNTIME_DIR: &str =
    "Microsoft.WebView2.FixedVersionRuntime.109.0.1518.78.x64";
#[allow(dead_code)]
pub const WEBVIEW2_EMBEDDED_DLL: &str = "EBWebView/x64/EmbeddedBrowserWebView.dll";

const REQUIRED_APP_LOCAL_DLLS: &[&str] = &[
    "ucrtbase.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "msvcp140.dll",
    "api-ms-win-crt-runtime-l1-1-0.dll",
    "api-ms-win-crt-math-l1-1-0.dll",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OsSupport {
    Supported,
    Windows7RtmNeedsSp1,
    TooOld,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreflightFailure {
    UnsupportedOs { major: u32, minor: u32, build: u32 },
    Windows7Rtm,
    MissingWebView2 { path: String },
    MissingRuntimeDll { name: String },
}

impl PreflightFailure {
    pub fn title(&self) -> &'static str {
        "FPSMaster Launcher (Win7)"
    }

    pub fn message(&self) -> String {
        match self {
            Self::UnsupportedOs {
                major,
                minor,
                build,
            } => format!(
                "This Windows 7 build of the launcher cannot start on Windows {major}.{minor} (build {build}).\n\
                 Install Windows 7 SP1 x64 or later.\n\n\
                 此 Windows 7 专用启动器无法在 Windows {major}.{minor}（内部版本 {build}）上运行。\n\
                 请安装 64 位 Windows 7 SP1 或更新的系统。"
            ),
            Self::Windows7Rtm => {
                "Windows 7 RTM is not supported. Install Service Pack 1 (KB976932), then reopen the launcher.\n\n\
                 不支持未打 SP1 的 Windows 7。请先安装 Service Pack 1（KB976932），再重新打开启动器。"
                    .to_string()
            }
            Self::MissingWebView2 { path } => format!(
                "The bundled WebView2 109 runtime is missing:\n{path}\n\n\
                 Reinstall the Windows 7 launcher package. Evergreen WebView2 (110+) does not run on Windows 7.\n\n\
                 未找到捆绑的 WebView2 109 运行时：\n{path}\n\n\
                 请重新安装 Windows 7 专用启动器。更高版本的 Evergreen WebView2 不能在 Windows 7 上运行。"
            ),
            Self::MissingRuntimeDll { name } => format!(
                "Required runtime file is missing: {name}\n\n\
                 Reinstall the Windows 7 launcher, or run the bundled Visual C++ 2015-2022 x64 redistributable \
                 (win7-runtime\\vc_redist.x64.exe) as Administrator. Windows 7 also needs the Universal CRT \
                 (KB2999226) if ucrtbase.dll is missing from System32.\n\n\
                 缺少运行库文件：{name}\n\n\
                 请重新安装 Windows 7 专用启动器，或以管理员身份运行安装目录 win7-runtime\\vc_redist.x64.exe。\n\
                 如果系统目录没有 ucrtbase.dll，还需要安装通用 C 运行时更新 KB2999226。"
            ),
        }
    }
}

pub fn evaluate_os_version(major: u32, minor: u32, build: u32) -> OsSupport {
    if major < 6 || (major == 6 && minor < 1) {
        return OsSupport::TooOld;
    }
    if major == 6 && minor == 1 && build < 7601 {
        return OsSupport::Windows7RtmNeedsSp1;
    }
    OsSupport::Supported
}

pub fn webview2_embedded_browser_path(exe_dir: &Path) -> PathBuf {
    exe_dir
        .join(WEBVIEW2_FIXED_RUNTIME_DIR)
        .join("EBWebView")
        .join("x64")
        .join("EmbeddedBrowserWebView.dll")
}

pub fn missing_app_local_dlls(exe_dir: &Path, system_dir: Option<&Path>) -> Vec<String> {
    REQUIRED_APP_LOCAL_DLLS
        .iter()
        .copied()
        .filter(|name| !runtime_dll_is_available(exe_dir, system_dir, name))
        .map(str::to_string)
        .collect()
}

fn runtime_dll_is_available(exe_dir: &Path, system_dir: Option<&Path>, name: &str) -> bool {
    if exe_dir.join(name).is_file() {
        return true;
    }
    if let Some(system_dir) = system_dir {
        if system_dir.join(name).is_file() {
            return true;
        }
    }
    false
}

pub fn evaluate_preflight(
    major: u32,
    minor: u32,
    build: u32,
    exe_dir: &Path,
    system_dir: Option<&Path>,
) -> Result<(), PreflightFailure> {
    match evaluate_os_version(major, minor, build) {
        OsSupport::TooOld => {
            return Err(PreflightFailure::UnsupportedOs {
                major,
                minor,
                build,
            });
        }
        OsSupport::Windows7RtmNeedsSp1 => return Err(PreflightFailure::Windows7Rtm),
        OsSupport::Supported => {}
    }

    let webview2 = webview2_embedded_browser_path(exe_dir);
    if !webview2.is_file() {
        return Err(PreflightFailure::MissingWebView2 {
            path: webview2.display().to_string(),
        });
    }

    if let Some(name) = missing_app_local_dlls(exe_dir, system_dir).into_iter().next() {
        return Err(PreflightFailure::MissingRuntimeDll { name });
    }

    Ok(())
}

#[cfg(windows)]
pub fn prepare_dll_search_path() {
    if let Some(exe_dir) = current_exe_dir() {
        let _ = set_dll_directory(&exe_dir);
    }
}

#[cfg(windows)]
pub fn preflight() -> Result<(), PreflightFailure> {
    let (major, minor, build) = os_version();
    let exe_dir = current_exe_dir().unwrap_or_else(|| PathBuf::from("."));
    let system_dir = system_directory();
    evaluate_preflight(
        major,
        minor,
        build,
        &exe_dir,
        system_dir.as_deref(),
    )
}

#[cfg(windows)]
pub fn show_blocking_error(failure: &PreflightFailure) {
    message_box(failure.title(), &failure.message());
}

#[cfg(windows)]
fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

#[cfg(windows)]
fn system_directory() -> Option<PathBuf> {
    let mut buffer = [0u16; 260];
    let len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if len == 0 || (len as usize) >= buffer.len() {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])))
}

#[cfg(windows)]
fn os_version() -> (u32, u32, u32) {
    let mut info = OsVersionInfoExW {
        dw_os_version_info_size: std::mem::size_of::<OsVersionInfoExW>() as u32,
        dw_major_version: 0,
        dw_minor_version: 0,
        dw_build_number: 0,
        dw_platform_id: 0,
        sz_csd_version: [0; 128],
        w_service_pack_major: 0,
        w_service_pack_minor: 0,
        w_suite_mask: 0,
        w_product_type: 0,
        w_reserved: 0,
    };
    unsafe {
        RtlGetVersion(&mut info);
    }
    (
        info.dw_major_version,
        info.dw_minor_version,
        info.dw_build_number,
    )
}

#[cfg(windows)]
fn set_dll_directory(dir: &Path) -> bool {
    let encoded = wide_z(dir);
    unsafe { SetDllDirectoryW(encoded.as_ptr()) != 0 }
}

#[cfg(windows)]
fn message_box(title: &str, body: &str) {
    let title = wide_z(title);
    let body = wide_z(body);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            0x0000_0010,
        );
    }
}

#[cfg(windows)]
fn wide_z(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
#[repr(C)]
struct OsVersionInfoExW {
    dw_os_version_info_size: u32,
    dw_major_version: u32,
    dw_minor_version: u32,
    dw_build_number: u32,
    dw_platform_id: u32,
    sz_csd_version: [u16; 128],
    w_service_pack_major: u16,
    w_service_pack_minor: u16,
    w_suite_mask: u16,
    w_product_type: u8,
    w_reserved: u8,
}

#[cfg(windows)]
#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(info: *mut OsVersionInfoExW) -> i32;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetDllDirectoryW(path: *const u16) -> i32;
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, ty: u32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fpsmaster-win7-compat-{}-{}",
            label,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, b"").expect("touch");
    }

    #[test]
    fn os_version_requires_win7_sp1() {
        assert_eq!(evaluate_os_version(6, 0, 6002), OsSupport::TooOld);
        assert_eq!(
            evaluate_os_version(6, 1, 7600),
            OsSupport::Windows7RtmNeedsSp1
        );
        assert_eq!(evaluate_os_version(6, 1, 7601), OsSupport::Supported);
        assert_eq!(evaluate_os_version(6, 2, 9200), OsSupport::Supported);
        assert_eq!(evaluate_os_version(10, 0, 19041), OsSupport::Supported);
    }

    #[test]
    fn preflight_reports_missing_webview2_before_dlls() {
        let exe_dir = temp_dir("webview2");
        let err = evaluate_preflight(6, 1, 7601, &exe_dir, None).unwrap_err();
        match err {
            PreflightFailure::MissingWebView2 { path } => {
                assert!(path.contains(WEBVIEW2_FIXED_RUNTIME_DIR));
                assert!(path.contains("EmbeddedBrowserWebView.dll"));
            }
            other => panic!("unexpected failure: {other:?}"),
        }
        let _ = fs::remove_dir_all(exe_dir);
    }

    #[test]
    fn preflight_accepts_complete_layout() {
        let exe_dir = temp_dir("ok");
        touch(&webview2_embedded_browser_path(&exe_dir));
        for name in REQUIRED_APP_LOCAL_DLLS {
            touch(&exe_dir.join(name));
        }
        evaluate_preflight(6, 1, 7601, &exe_dir, None).expect("complete layout");
        let _ = fs::remove_dir_all(exe_dir);
    }

    #[test]
    fn preflight_accepts_system32_runtimes() {
        let exe_dir = temp_dir("exe");
        let system_dir = temp_dir("system");
        touch(&webview2_embedded_browser_path(&exe_dir));
        for name in REQUIRED_APP_LOCAL_DLLS {
            touch(&system_dir.join(name));
        }
        evaluate_preflight(6, 1, 7601, &exe_dir, Some(&system_dir)).expect("system runtimes");
        let _ = fs::remove_dir_all(exe_dir);
        let _ = fs::remove_dir_all(system_dir);
    }

    #[test]
    fn missing_ucrt_message_mentions_kb2999226() {
        let message = PreflightFailure::MissingRuntimeDll {
            name: "ucrtbase.dll".to_string(),
        }
        .message();
        assert!(message.contains("KB2999226"));
        assert!(message.contains("vc_redist.x64.exe"));
        assert!(message.contains("通用 C 运行时"));
    }

    #[test]
    fn win7_rtm_message_mentions_sp1() {
        let message = PreflightFailure::Windows7Rtm.message();
        assert!(message.contains("KB976932"));
        assert!(message.contains("SP1"));
    }
}
