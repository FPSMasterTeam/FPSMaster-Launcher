use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::{open_file_with_system, sanitize_file_name};

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiEnvelope<T> {
    pub success: bool,
    #[serde(default)]
    pub code: Option<String>,
    pub message: Option<String>,
    pub data: Option<T>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherVersion {
    #[serde(default)]
    pub id: Option<serde_json::Value>,
    pub channel: String,
    #[serde(rename = "versionType")]
    pub version_type: String,
    #[serde(rename = "versionName")]
    pub version_name: String,
    // Minecraft game version this release targets (e.g. "1.21.11"). Present on nova entries so the
    // launcher can offer multiple game versions under a single Nova product; null for edge.
    #[serde(rename = "gameVersion", default)]
    pub game_version: Option<String>,
    #[serde(rename = "artifactSourceType", default)]
    pub artifact_source_type: Option<String>,
    #[serde(rename = "downloadUrl")]
    pub download_url: String,
    // Optional Forge-free AOT zip for Edge (launcher installs under versions/<id>/aot/).
    #[serde(rename = "aotDownloadUrl", default)]
    pub aot_download_url: Option<String>,
    #[serde(rename = "aotChecksum", default)]
    pub aot_checksum: Option<String>,
    #[serde(rename = "aotFileSize", default)]
    pub aot_file_size: Option<i64>,
    #[serde(rename = "fileBucket", default)]
    pub file_bucket: Option<String>,
    #[serde(rename = "fileKey", default)]
    pub file_key: Option<String>,
    #[serde(rename = "fileSize", default)]
    pub file_size: Option<i64>,
    #[serde(default)]
    pub checksum: Option<String>,
    #[serde(rename = "manifestUrl", default)]
    pub manifest_url: Option<String>,
    #[serde(rename = "minLauncherVersion", default)]
    pub min_launcher_version: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub changelog: Option<String>,
    #[serde(rename = "commitHash", default)]
    pub commit_hash: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherAppUpdateInfo {
    pub version: String,
    #[serde(rename = "downloadUrl")]
    pub download_url: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(rename = "publishedAt", default)]
    pub published_at: Option<String>,
    /// Always false in the static catalog; kept so the frontend shape is unchanged.
    #[serde(default)]
    pub mandatory: bool,
    #[serde(default)]
    pub checksum: Option<String>,
    #[serde(rename = "fileSize", default)]
    pub file_size: Option<u64>,
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadedLauncherUpdate {
    pub version: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize)]
struct LauncherAppUpdateProgress {
    #[serde(rename = "downloadedBytes")]
    downloaded_bytes: u64,
    #[serde(rename = "totalBytes")]
    total_bytes: Option<u64>,
    percent: Option<u8>,
}

#[tauri::command]
pub async fn download_launcher_app_update(
    app: tauri::AppHandle,
    download_url: String,
    version: String,
    checksum: Option<String>,
    ipc_session: Option<String>,
) -> Result<DownloadedLauncherUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cancel = crate::downloader::CancelToken::new(ipc_session.as_deref());
        let result =
            download_launcher_app_update_blocking(&app, &cancel, download_url, version, checksum);
        crate::clear_install_cancel(ipc_session.as_deref());
        result
    })
    .await
    .map_err(|e| format!("Failed to join launcher app download task: {e}"))?
}

#[tauri::command]
pub fn open_downloaded_file(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(file_path.trim());
    if path.as_os_str().is_empty() {
        return Err("Downloaded file path is empty".to_string());
    }
    open_file_with_system(&path)
}

fn download_launcher_app_update_blocking(
    app: &tauri::AppHandle,
    cancel: &crate::downloader::CancelToken,
    download_url: String,
    version: String,
    checksum: Option<String>,
) -> Result<DownloadedLauncherUpdate, String> {
    let normalized_download_url = download_url.trim().to_string();
    if normalized_download_url.is_empty() {
        return Err("Launcher update download URL is empty".to_string());
    }
    let normalized_version = version.trim().to_string();
    if normalized_version.is_empty() {
        return Err("Launcher update version is empty".to_string());
    }
    let expected_checksum = checksum
        .and_then(|item| normalize_launcher_update_checksum(&item))
        .ok_or_else(|| "Launcher update checksum is missing or invalid".to_string())?;

    let file_name = infer_download_file_name(&normalized_download_url, &normalized_version);
    let updates_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?
        .join("updates");
    fs::create_dir_all(&updates_dir).map_err(|e| {
        format!(
            "Failed to create launcher update directory {}: {e}",
            updates_dir.display()
        )
    })?;
    let target_path = updates_dir.join(&file_name);
    remove_stale_update_files(&updates_dir, &file_name);
    // The downloader throttles this callback (launcher-core-19: it used to fire
    // an IPC event for every 64 KiB read).
    let progress = |downloaded_bytes: u64, total_bytes: Option<u64>| {
        let percent = total_bytes
            .filter(|value| *value > 0)
            .map(|value| {
                downloaded_bytes
                    .saturating_mul(100)
                    .min(value.saturating_mul(100))
                    / value
            })
            .and_then(|value| u8::try_from(value).ok());
        let _ = app.emit(
            "launcher-app-update-progress",
            LauncherAppUpdateProgress {
                downloaded_bytes,
                total_bytes,
                percent,
            },
        );
    };
    crate::downloader::download(
        &crate::downloader::Request::single(&normalized_download_url, &target_path, cancel)
            .sha256(Some(expected_checksum.as_str()))
            .on_progress(&progress),
    )
    .map_err(|e| format!("Failed to download launcher installer: {e}"))?;

    Ok(DownloadedLauncherUpdate {
        version: normalized_version,
        file_name,
        file_path: target_path.to_string_lossy().to_string(),
    })
}

/// Deletes installers left over from earlier updates. Only the file being
/// downloaded now (and its resumable `.part` state) is kept.
fn remove_stale_update_files(updates_dir: &Path, keep_file_name: &str) {
    let Ok(entries) = fs::read_dir(updates_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == keep_file_name || name.starts_with(&format!("{keep_file_name}.part")) {
            continue;
        }
        let path = entry.path();
        if path.is_file() {
            if let Err(error) = fs::remove_file(&path) {
                crate::push_ui_log(
                    "core",
                    "warn",
                    &format!("Failed to remove old launcher installer {}: {error}", path.display()),
                );
            }
        }
    }
}

fn normalize_launcher_update_checksum(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let normalized = trimmed
        .strip_prefix("sha256:")
        .or_else(|| trimmed.strip_prefix("SHA256:"))
        .unwrap_or(trimmed)
        .trim();
    if normalized.len() == 64 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(normalized.to_ascii_lowercase())
    } else {
        None
    }
}

fn current_launcher_update_target() -> String {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "unknown"
    };
    format!("{os}-{arch}")
}

/// Self-update target. Windows 7 (and earlier) must install the WebView2
/// fixed-runtime build (`-win7` suffix) because current evergreen WebView2
/// runtime versions are Windows 10+ only.
#[cfg(target_os = "windows")]
pub(crate) fn current_launcher_app_update_target() -> String {
    let mut target = current_launcher_update_target();
    target.push_str(win7_target_suffix());
    target
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn current_launcher_app_update_target() -> String {
    current_launcher_update_target()
}

#[cfg(target_os = "windows")]
fn win7_target_suffix() -> &'static str {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;

    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        dwMajorVersion: 0,
        dwMinorVersion: 0,
        dwBuildNumber: 0,
        dwPlatformId: 0,
        szCSDVersion: [0u16; 128],
    };
    unsafe { RtlGetVersion(&mut info) };
    if info.dwMajorVersion < 6 || (info.dwMajorVersion == 6 && info.dwMinorVersion <= 1) {
        "-win7"
    } else {
        ""
    }
}

pub(crate) fn infer_download_file_name(download_url: &str, version: &str) -> String {
    let fallback = format!("fpsmaster-launcher-{}", sanitize_file_name(version));
    match reqwest::Url::parse(download_url) {
        Ok(url) => url
            .path_segments()
            .and_then(|segments| segments.last())
            .map(sanitize_file_name)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(fallback),
        Err(_) => fallback,
    }
}

pub(crate) fn parse_api_envelope<T: for<'de> Deserialize<'de>>(
    status: reqwest::StatusCode,
    body: &str,
    context: &str,
) -> Result<T, String> {
    match serde_json::from_str::<ApiEnvelope<T>>(body) {
        Ok(payload) => {
            if !status.is_success() || !payload.success {
                return Err(api_failure(status, body, context));
            }
            payload
                .data
                .ok_or_else(|| format!("{context} response missing data"))
        }
        Err(err) => {
            if status.is_success() && extract_api_error_message(body).is_none() {
                return Err(format!("Invalid {context} response JSON: {err}"));
            }
            Err(api_failure(status, body, context))
        }
    }
}

/// Marks a failed FPSMaster API call. What follows is a JSON object
/// `{"status","code","message","context"}` so the frontend can branch on the
/// stable `code` / HTTP status instead of matching message text (contract §1).
pub(crate) const API_ERROR_PREFIX: &str = "FPSMASTER_API_ERROR ";

/// Builds the tagged error for a non-success API response. `message` is the
/// backend's localized text (or null when the body had none, e.g. a proxy's
/// HTML error page); the frontend falls back to its own text by status.
pub(crate) fn api_failure(status: reqwest::StatusCode, body: &str, context: &str) -> String {
    let value = serde_json::from_str::<serde_json::Value>(body.trim_start_matches('\u{feff}').trim()).ok();
    let code = value
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(|code| code.as_str())
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .map(str::to_string);
    // `code` is an identifier, never display text: drop it before searching for
    // the message so a body without one does not show "ITEM_ALREADY_OWNED".
    let message = value.map(|mut value| {
        if let Some(object) = value.as_object_mut() {
            object.remove("code");
        }
        value
    });
    let message = message.as_ref().and_then(find_error_message_in_value);
    let payload = serde_json::json!({
        "status": status.as_u16(),
        "code": code,
        "message": message,
        "context": context,
    });
    format!("{API_ERROR_PREFIX}{payload}")
}

pub(crate) fn extract_api_error_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    find_error_message_in_value(&value)
}

fn find_error_message_in_value(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(object) = value.as_object() {
        for key in ["message", "error", "detail", "msg", "reason"] {
            if let Some(candidate) = object.get(key).and_then(|item| item.as_str()) {
                let trimmed = candidate.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        for nested in object.values() {
            if let Some(found) = find_error_message_in_value(nested) {
                return Some(found);
            }
        }
    }

    if let Some(array) = value.as_array() {
        for item in array {
            if let Some(found) = find_error_message_in_value(item) {
                return Some(found);
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{api_failure, API_ERROR_PREFIX};

    fn decode(error: &str) -> serde_json::Value {
        let json = error
            .strip_prefix(API_ERROR_PREFIX)
            .expect("tagged API error");
        serde_json::from_str(json).expect("JSON payload")
    }

    #[test]
    fn api_failure_carries_status_code_and_message() {
        let body = r#"{"success":false,"code":"UNAUTHORIZED","message":"请先登录","data":{}}"#;
        let value = decode(&api_failure(reqwest::StatusCode::UNAUTHORIZED, body, "login"));
        assert_eq!(value["status"], 401);
        assert_eq!(value["code"], "UNAUTHORIZED");
        assert_eq!(value["message"], "请先登录");
    }

    #[test]
    fn api_failure_never_uses_the_code_as_message() {
        let body = r#"{"success":false,"code":"ITEM_ALREADY_OWNED","message":null}"#;
        let value = decode(&api_failure(reqwest::StatusCode::CONFLICT, body, "shop"));
        assert_eq!(value["code"], "ITEM_ALREADY_OWNED");
        assert!(value["message"].is_null());
    }

}
