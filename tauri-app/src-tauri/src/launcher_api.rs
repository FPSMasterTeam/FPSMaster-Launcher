use std::fs;
use std::path::{Path, PathBuf};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::{
    build_api_http_client, describe_http_error, open_file_with_system, sanitize_file_name,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiEnvelope<T> {
    pub success: bool,
    #[serde(default)]
    pub code: Option<String>,
    pub message: Option<String>,
    pub data: Option<T>,
}

#[derive(Debug, Serialize, Deserialize)]
struct LauncherLoginRequest {
    #[serde(rename = "usernameOrEmail")]
    username_or_email: String,
    password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherLoginResult {
    pub token: String,
    pub user: serde_json::Value,
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
    // launcher can offer multiple game versions under a single Nova product; null for edge/extreme.
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

mod category_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use serde_json::Value;

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let opt = Option::<Value>::deserialize(deserializer)?;
        match opt {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s)),
            Some(Value::Object(obj)) => {
                if let Some(Value::String(name)) = obj.get("name") {
                    Ok(Some(name.clone()))
                } else {
                    Ok(None)
                }
            }
            Some(_) => Ok(None),
        }
    }

    pub fn serialize<S>(value: &Option<String>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        value.serialize(serializer)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherNewsItem {
    pub id: String,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(
        default,
        deserialize_with = "category_option::deserialize",
        serialize_with = "category_option::serialize"
    )]
    pub category: Option<String>,
    #[serde(rename = "publishedAt", default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(rename = "targetClients", default)]
    pub target_clients: Vec<String>,
    #[serde(rename = "startsAt", default)]
    pub starts_at: Option<String>,
    #[serde(rename = "endsAt", default)]
    pub ends_at: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherServerItem {
    pub id: String,
    pub name: String,
    pub address: String,
    pub description: String,
    pub active: bool,
    pub mode: String,
    #[serde(rename = "iconPath", default)]
    pub icon_path: Option<String>,
    #[serde(rename = "iconUrl", default)]
    pub icon_url: Option<String>,
    #[serde(rename = "detailedDescription", default)]
    pub detailed_description: Option<String>,
    #[serde(rename = "serverGroup", default)]
    pub server_group: Option<String>,
    #[serde(rename = "displayOrder", default)]
    pub display_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherWeeklyPlaytimePoint {
    pub date: String,
    #[serde(rename = "playSeconds")]
    pub play_seconds: i64,
    #[serde(rename = "playMinutes")]
    pub play_minutes: i64,
    #[serde(rename = "playHours")]
    pub play_hours: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherWeeklyPlaytime {
    pub points: Vec<LauncherWeeklyPlaytimePoint>,
    #[serde(rename = "totalSeconds")]
    pub total_seconds: i64,
    #[serde(rename = "totalMinutes")]
    pub total_minutes: i64,
    #[serde(rename = "totalHours")]
    pub total_hours: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherUserStats {
    #[serde(rename = "totalActivities")]
    pub total_activities: i64,
    #[serde(rename = "playSessionCount")]
    pub play_session_count: i64,
    #[serde(rename = "totalPlaySeconds")]
    pub total_play_seconds: i64,
    #[serde(rename = "totalPlayHours")]
    pub total_play_hours: f64,
    #[serde(rename = "latestActivityAt", default)]
    pub latest_activity_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherDashboard {
    pub user: serde_json::Value,
    pub stats: LauncherUserStats,
    #[serde(rename = "weeklyPlaytime")]
    pub weekly_playtime: LauncherWeeklyPlaytime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryOnlineSummary {
    pub online: i64,
    pub total: i64,
    pub launcher: i64,
    pub edge: i64,
    pub nova: i64,
    pub generic: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherHomePayload {
    pub news: Vec<LauncherNewsItem>,
    pub servers: Vec<LauncherServerItem>,
    pub online: TelemetryOnlineSummary,
    pub dashboard: Option<LauncherDashboard>,
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
    pub mandatory: bool,
    #[serde(default)]
    pub checksum: Option<String>,
    #[serde(rename = "fileSize", default)]
    pub file_size: Option<u64>,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherAppUpdateChannel {
    pub code: String,
    pub name: String,
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
pub async fn launcher_login(
    base_url: String,
    username_or_email: String,
    password: String,
) -> Result<LauncherLoginResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        launcher_login_blocking(base_url, username_or_email, password)
    })
    .await
    .map_err(|e| format!("Failed to join launcher login task: {e}"))?
}

fn launcher_login_blocking(
    base_url: String,
    username_or_email: String,
    password: String,
) -> Result<LauncherLoginResult, String> {
    let endpoint = format!(
        "{}/api/v1/auth/launcher/login",
        normalize_api_base_url(&base_url)?
    );
    let client = build_api_http_client()?;
    let payload = LauncherLoginRequest {
        username_or_email: username_or_email.trim().to_string(),
        password,
    };
    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .map_err(|e| format!("Login request failed: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read login response: {e}"))?;
    parse_launcher_login_response(status, &text)
}

#[tauri::command]
pub async fn launcher_list_available_versions(
    base_url: String,
    token: String,
    version_type: Option<String>,
) -> Result<Vec<LauncherVersion>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        launcher_list_available_versions_blocking(base_url, token, version_type)
    })
    .await
    .map_err(|e| format!("Failed to join launcher versions task: {e}"))?
}

#[tauri::command]
pub async fn launcher_list_news(
    base_url: String,
    limit: Option<u32>,
) -> Result<Vec<LauncherNewsItem>, String> {
    tauri::async_runtime::spawn_blocking(move || launcher_list_news_blocking(base_url, limit))
        .await
        .map_err(|e| format!("Failed to join launcher news task: {e}"))?
}

#[tauri::command]
pub async fn launcher_list_servers(
    base_url: String,
    token: Option<String>,
) -> Result<Vec<LauncherServerItem>, String> {
    tauri::async_runtime::spawn_blocking(move || launcher_list_servers_blocking(base_url, token))
        .await
        .map_err(|e| format!("Failed to join launcher servers task: {e}"))?
}

#[tauri::command]
pub async fn launcher_get_dashboard(
    base_url: String,
    token: String,
) -> Result<LauncherDashboard, String> {
    tauri::async_runtime::spawn_blocking(move || launcher_get_dashboard_blocking(base_url, token))
        .await
        .map_err(|e| format!("Failed to join launcher dashboard task: {e}"))?
}

#[tauri::command]
pub async fn launcher_get_home(
    base_url: String,
    token: Option<String>,
) -> Result<LauncherHomePayload, String> {
    tauri::async_runtime::spawn_blocking(move || launcher_get_home_blocking(base_url, token))
        .await
        .map_err(|e| format!("Failed to join launcher home task: {e}"))?
}

#[tauri::command]
pub async fn launcher_get_app_update(
    app: tauri::AppHandle,
    base_url: String,
    channel: Option<String>,
) -> Result<LauncherAppUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        launcher_get_app_update_blocking(&app, base_url, channel)
    })
    .await
    .map_err(|e| format!("Failed to join launcher app update task: {e}"))?
}

#[tauri::command]
pub async fn launcher_list_app_update_channels(
    base_url: String,
    token: Option<String>,
) -> Result<Vec<LauncherAppUpdateChannel>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        launcher_list_app_update_channels_blocking(base_url, token)
    })
    .await
    .map_err(|e| format!("Failed to join launcher app update channels task: {e}"))?
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

fn launcher_list_news_blocking(
    base_url: String,
    limit: Option<u32>,
) -> Result<Vec<LauncherNewsItem>, String> {
    let normalized_base = normalize_api_base_url(&base_url)?;
    let client = build_api_http_client()?;

    let mut url = reqwest::Url::parse(&format!("{normalized_base}/api/v1/launcher/news"))
        .map_err(|e| format!("Invalid launcher news endpoint URL: {e}"))?;
    url.query_pairs_mut()
        .append_pair("limit", &limit.unwrap_or(4).clamp(1, 12).to_string())
        .append_pair("clientKind", "LAUNCHER");

    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Launcher news request failed: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read launcher news response: {e}"))?;
    parse_launcher_news_response(status, &text)
}

// Previously the frontend hit this endpoint with a bare `fetch` that never
// checked `response.ok`, so an HTTP 500 silently became an empty server list.
// Routing it through the shared API client gives it the same timeout budget,
// error description and status handling as every other launcher call.
fn launcher_list_servers_blocking(
    base_url: String,
    token: Option<String>,
) -> Result<Vec<LauncherServerItem>, String> {
    let normalized_base = normalize_api_base_url(&base_url)?;
    let client = build_api_http_client()?;

    let url = reqwest::Url::parse(&format!("{normalized_base}/api/v1/launcher/servers"))
        .map_err(|e| format!("Invalid launcher servers endpoint URL: {e}"))?;
    let mut request = client.get(url);
    if let Some(value) = token
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
    {
        request = request.bearer_auth(value);
    }
    let response = request
        .send()
        .map_err(|e| format!("Launcher servers request failed: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read launcher servers response: {e}"))?;
    parse_launcher_servers_response(status, &text)
}

fn parse_launcher_servers_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<Vec<LauncherServerItem>, String> {
    if let Ok(items) = parse_api_envelope::<Vec<LauncherServerItem>>(status, body, "launcher servers")
    {
        return Ok(items);
    }

    if !status.is_success() {
        return Err(api_failure(status, body, "launcher servers"));
    }

    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid launcher servers response JSON: {e}"))?;
    let data = value.get("data").unwrap_or(&value);
    serde_json::from_value::<Vec<LauncherServerItem>>(data.clone())
        .map_err(|e| format!("Invalid launcher servers payload: {e}"))
}

fn launcher_get_dashboard_blocking(
    base_url: String,
    token: String,
) -> Result<LauncherDashboard, String> {
    let normalized_base = normalize_api_base_url(&base_url)?;
    let normalized_token = token.trim().to_string();
    if normalized_token.is_empty() {
        return Err("Token is required".to_string());
    }

    let client = build_api_http_client()?;

    let url = reqwest::Url::parse(&format!("{normalized_base}/api/v1/launcher/dashboard"))
        .map_err(|e| format!("Invalid launcher dashboard endpoint URL: {e}"))?;
    let response = client
        .get(url)
        .bearer_auth(&normalized_token)
        .send()
        .map_err(|e| format!("Launcher dashboard request failed: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read launcher dashboard response: {e}"))?;
    parse_launcher_dashboard_response(status, &text)
}

fn launcher_get_home_blocking(
    base_url: String,
    token: Option<String>,
) -> Result<LauncherHomePayload, String> {
    let normalized_base = normalize_api_base_url(&base_url)?;
    let client = build_api_http_client()?;

    let url = reqwest::Url::parse(&format!("{normalized_base}/api/v1/launcher/home"))
        .map_err(|e| format!("Invalid launcher home endpoint URL: {e}"))?;
    let mut request = client.get(url);
    if let Some(value) = token
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
    {
        request = request.bearer_auth(value);
    }
    let response = request
        .send()
        .map_err(|e| format!("Launcher home request failed: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read launcher home response: {e}"))?;
    parse_launcher_home_response(status, &text)
}

fn launcher_get_app_update_blocking(
    app: &tauri::AppHandle,
    base_url: String,
    channel: Option<String>,
) -> Result<LauncherAppUpdateInfo, String> {
    let normalized_base = normalize_api_base_url(&base_url)?;
    let client = build_api_http_client()?;
    let install_id = get_or_create_launcher_install_id(app)?;
    let mut url = reqwest::Url::parse(&format!("{normalized_base}/api/v1/launcher/app-update"))
        .map_err(|e| format!("Invalid launcher app update endpoint URL: {e}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("target", &current_launcher_app_update_target());
        query.append_pair("installId", &install_id);
        if let Some(normalized_channel) = channel
            .map(|item| item.trim().to_lowercase())
            .filter(|item| !item.is_empty())
        {
            query.append_pair("channel", &normalized_channel);
        }
    }

    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Launcher app update request failed: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read launcher app update response: {e}"))?;
    parse_launcher_app_update_response(status, &text)
}

fn launcher_list_app_update_channels_blocking(
    base_url: String,
    token: Option<String>,
) -> Result<Vec<LauncherAppUpdateChannel>, String> {
    let normalized_base = normalize_api_base_url(&base_url)?;
    let client = build_api_http_client()?;
    let url = reqwest::Url::parse(&format!(
        "{normalized_base}/api/v1/launcher/app-update/channels"
    ))
    .map_err(|e| format!("Invalid launcher app update channels endpoint URL: {e}"))?;

    let mut request = client.get(url);
    if let Some(value) = token
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
    {
        request = request.bearer_auth(value);
    }

    let response = request
        .send()
        .map_err(|e| format!("Launcher app update channels request failed: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read launcher app update channels response: {e}"))?;
    parse_api_envelope(status, &text, "launcher app update channels")
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

fn launcher_list_available_versions_blocking(
    base_url: String,
    token: String,
    version_type: Option<String>,
) -> Result<Vec<LauncherVersion>, String> {
    let normalized_base = normalize_api_base_url(&base_url)?;
    let normalized_token = token.trim().to_string();
    if normalized_token.is_empty() {
        return Err("Token is required".to_string());
    }
    // Optional client-side filter kept for callers that still pass a specific type; the new
    // catalog endpoint returns every entitled client product in one call.
    let type_filter = version_type
        .map(|item| item.trim().to_uppercase())
        .filter(|item| !item.is_empty());

    let client = build_api_http_client()?;

    // New release system: one authenticated per-platform catalog call replaces the legacy
    // per-versionType /versions/available fan-out. `target` scopes native products (extreme)
    // to this platform; Java products (edge/nova) are platform-agnostic and always included.
    let mut url = reqwest::Url::parse(&format!(
        "{normalized_base}/api/v1/launcher/releases/available"
    ))
    .map_err(|e| format!("Invalid releases endpoint URL: {e}"))?;
    url.query_pairs_mut()
        .append_pair("target", &current_launcher_update_target());
    let response = client
        .get(url)
        .bearer_auth(&normalized_token)
        .send()
        .map_err(|e| format!("Releases request failed: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read releases response: {e}"))?;
    let mut items = parse_launcher_versions_response(status, &text)?;
    if let Some(filter) = type_filter {
        items.retain(|item| item.version_type.eq_ignore_ascii_case(&filter));
    }
    Ok(items)
}

pub(crate) fn normalize_api_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("API base URL is empty".to_string());
    }
    Ok(trimmed.to_string())
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
fn current_launcher_app_update_target() -> String {
    let mut target = current_launcher_update_target();
    target.push_str(win7_target_suffix());
    target
}

#[cfg(not(target_os = "windows"))]
fn current_launcher_app_update_target() -> String {
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

fn get_or_create_launcher_install_id(app: &tauri::AppHandle) -> Result<String, String> {
    let install_id_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve launcher app data directory: {e}"))?
        .join("state")
        .join("install-id.txt");
    if let Some(parent) = install_id_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create launcher install state directory {}: {e}",
                parent.display()
            )
        })?;
    }

    if let Ok(existing) = fs::read_to_string(&install_id_path) {
        if let Some(normalized) = normalize_launcher_install_id(&existing) {
            return Ok(normalized);
        }
    }

    let generated = create_launcher_install_id();
    fs::write(&install_id_path, format!("{generated}\n")).map_err(|e| {
        format!(
            "Failed to persist launcher install id to {}: {e}",
            install_id_path.display()
        )
    })?;
    Ok(generated)
}

fn normalize_launcher_install_id(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 32 || !normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(normalized)
}

fn create_launcher_install_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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

fn parse_launcher_login_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<LauncherLoginResult, String> {
    if let Ok(result) = parse_api_envelope::<LauncherLoginResult>(status, body, "login") {
        return Ok(LauncherLoginResult {
            token: normalize_auth_token(&result.token)
                .ok_or_else(|| "登录异常: 未能读取到有效 token".to_string())?,
            user: normalize_login_user_payload(result.user),
        });
    }

    // Status first: a non-JSON error page (proxy 502, framework 404) must still
    // come back tagged so the frontend words it by status (contract §1).
    if !status.is_success() {
        return Err(api_failure(status, body, "login"));
    }

    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Invalid login response JSON: {e}"))?;

    let container = login_payload_container(&value);
    let token = extract_login_token(container)
        .or_else(|| extract_login_token(&value))
        .ok_or_else(|| "登录异常: 未能读取到有效 token".to_string())?;
    let user = extract_login_user(container)
        .or_else(|| extract_login_user(&value))
        .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));

    Ok(LauncherLoginResult {
        token,
        user: normalize_login_user_payload(user),
    })
}

fn parse_launcher_versions_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<Vec<LauncherVersion>, String> {
    let trimmed_body = body.trim_start_matches('\u{feff}').trim();
    if trimmed_body.is_empty() {
        if status.is_success() {
            return Ok(Vec::new());
        }
        return Err(api_failure(status, trimmed_body, "versions list"));
    }

    let value: serde_json::Value = match serde_json::from_str(trimmed_body) {
        Ok(value) => value,
        Err(err) => {
            if !status.is_success() {
                // Non-JSON error page (proxy, framework 404 while the backend is
                // mid-deploy): the frontend words it by status.
                return Err(api_failure(status, trimmed_body, "versions list"));
            }
            let preview = response_body_preview(trimmed_body);
            return Err(format!(
                "Invalid versions list response (not JSON, {err}): {preview}"
            ));
        }
    };

    if let Ok(envelope) = serde_json::from_value::<ApiEnvelope<Vec<LauncherVersion>>>(value.clone())
    {
        if !status.is_success() || !envelope.success {
            return Err(api_failure(status, trimmed_body, "versions list"));
        }
        if let Some(data) = envelope.data {
            return Ok(data);
        }
    }

    if !status.is_success() {
        return Err(api_failure(status, trimmed_body, "versions list"));
    }

    extract_launcher_versions(&value)
        .ok_or_else(|| "versions list response missing data".to_string())
}

fn response_body_preview(body: &str) -> String {
    const LIMIT: usize = 200;
    let mut preview: String = body.chars().take(LIMIT).collect();
    preview = preview.replace(['\n', '\r', '\t'], " ");
    if body.chars().count() > LIMIT {
        preview.push('…');
    }
    preview
}

fn parse_launcher_news_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<Vec<LauncherNewsItem>, String> {
    if let Ok(items) = parse_api_envelope::<Vec<LauncherNewsItem>>(status, body, "launcher news") {
        return Ok(items);
    }

    if !status.is_success() {
        return Err(api_failure(status, body, "launcher news"));
    }

    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid launcher news response JSON: {e}"))?;

    extract_launcher_news(&value).ok_or_else(|| "launcher news response missing data".to_string())
}

fn parse_launcher_dashboard_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<LauncherDashboard, String> {
    if let Ok(item) = parse_api_envelope::<LauncherDashboard>(status, body, "launcher dashboard") {
        return Ok(item);
    }

    if !status.is_success() {
        return Err(api_failure(status, body, "launcher dashboard"));
    }

    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid launcher dashboard response JSON: {e}"))?;

    serde_json::from_value::<LauncherDashboard>(value)
        .map_err(|e| format!("launcher dashboard response missing data: {e}"))
}

fn parse_launcher_home_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<LauncherHomePayload, String> {
    if let Ok(item) = parse_api_envelope::<LauncherHomePayload>(status, body, "launcher home") {
        return Ok(item);
    }

    if !status.is_success() {
        return Err(api_failure(status, body, "launcher home"));
    }

    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid launcher home response JSON: {e}"))?;

    serde_json::from_value::<LauncherHomePayload>(value)
        .map_err(|e| format!("launcher home response missing data: {e}"))
}

fn parse_launcher_app_update_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<LauncherAppUpdateInfo, String> {
    if let Ok(item) =
        parse_api_envelope::<LauncherAppUpdateInfo>(status, body, "launcher app update")
    {
        return Ok(item);
    }

    if !status.is_success() {
        return Err(api_failure(status, body, "launcher app update"));
    }

    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid launcher app update response JSON: {e}"))?;

    serde_json::from_value::<LauncherAppUpdateInfo>(value)
        .map_err(|e| format!("launcher app update response missing data: {e}"))
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

fn login_payload_container(value: &serde_json::Value) -> &serde_json::Value {
    value.get("data").unwrap_or(value)
}

fn extract_launcher_versions(value: &serde_json::Value) -> Option<Vec<LauncherVersion>> {
    if let Ok(items) = serde_json::from_value::<Vec<LauncherVersion>>(value.clone()) {
        return Some(items);
    }

    if let Some(object) = value.as_object() {
        for key in ["data", "items", "list", "results", "records"] {
            if let Some(found) = object.get(key).and_then(extract_launcher_versions) {
                return Some(found);
            }
        }
    }

    None
}

fn extract_launcher_news(value: &serde_json::Value) -> Option<Vec<LauncherNewsItem>> {
    if let Ok(items) = serde_json::from_value::<Vec<LauncherNewsItem>>(value.clone()) {
        return Some(items);
    }

    if let Some(object) = value.as_object() {
        for key in ["data", "items", "list", "results", "records"] {
            if let Some(found) = object.get(key).and_then(extract_launcher_news) {
                return Some(found);
            }
        }
    }

    None
}

fn extract_login_token(value: &serde_json::Value) -> Option<String> {
    if let Some(object) = value.as_object() {
        for key in ["token", "accessToken", "jwt", "jwtToken", "authToken"] {
            if let Some(normalized) = object.get(key).and_then(value_as_normalized_token) {
                return Some(normalized);
            }
        }

        for key in ["auth", "result", "payload"] {
            if let Some(found) = object.get(key).and_then(extract_login_token) {
                return Some(found);
            }
        }
    }
    None
}

fn extract_login_user(value: &serde_json::Value) -> Option<serde_json::Value> {
    if let Some(object) = value.as_object() {
        for key in ["user", "currentUser", "profile", "me"] {
            if let Some(candidate) = object.get(key) {
                return Some(candidate.clone());
            }
        }
    }
    None
}

fn value_as_normalized_token(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => normalize_auth_token(text),
        serde_json::Value::Object(object) => {
            for key in ["value", "token", "accessToken", "jwt"] {
                if let Some(found) = object.get(key).and_then(value_as_normalized_token) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn normalize_auth_token(raw: &str) -> Option<String> {
    let mut token = raw.trim().trim_matches('"').trim().to_string();
    if token.to_ascii_lowercase().starts_with("bearer ") {
        token = token[7..].trim().to_string();
    }
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn normalize_login_user_payload(value: serde_json::Value) -> serde_json::Value {
    if value.is_object() {
        value
    } else {
        serde_json::Value::Object(serde_json::Map::new())
    }
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
    use super::{
        api_failure, parse_launcher_app_update_response, parse_launcher_login_response,
        parse_launcher_versions_response, API_ERROR_PREFIX,
    };

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

    #[test]
    fn non_json_error_page_keeps_the_status() {
        let error = parse_launcher_versions_response(
            reqwest::StatusCode::NOT_FOUND,
            "Unable to find matching target resource method",
        )
        .unwrap_err();
        let value = decode(&error);
        assert_eq!(value["status"], 404);
        assert!(value["code"].is_null());
    }

    #[test]
    fn login_proxy_html_error_keeps_the_status() {
        let error = parse_launcher_login_response(
            reqwest::StatusCode::BAD_GATEWAY,
            "<html><body><h1>502 Bad Gateway</h1></body></html>",
        )
        .unwrap_err();
        let value = decode(&error);
        assert_eq!(value["status"], 502);
        assert!(value["message"].is_null());
    }

    #[test]
    fn app_update_plain_text_404_keeps_the_status() {
        let error = parse_launcher_app_update_response(
            reqwest::StatusCode::NOT_FOUND,
            "Unable to find matching target resource method",
        )
        .unwrap_err();
        assert_eq!(decode(&error)["status"], 404);
    }
}
