#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Cursor, Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs};
use tauri::menu::{Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
#[cfg(target_os = "macos")]
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt;
#[cfg(windows)]
use windows::core::{HSTRING, PWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{POINT, RECT, RPC_E_CHANGED_MODE};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY, MONITORINFO,
};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_APARTMENTTHREADED,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::{DesktopWallpaper, IDesktopWallpaper};

const DEFAULT_MINECRAFT_MICROSOFT_CLIENT_ID: &str = "057064c6-d180-43df-b010-834b4571532f";
const DEFAULT_MINECRAFT_MICROSOFT_REDIRECT_URL: &str = "http://localhost:3389/oauth";
const MINECRAFT_MICROSOFT_SCOPE: &str = "XboxLive.signin offline_access openid profile email";

#[derive(Debug, Serialize, Deserialize)]
struct InstallResult {
    #[serde(rename = "versionId")]
    version_id: String,
    #[serde(rename = "versionJsonPath")]
    version_json_path: String,
    #[serde(rename = "librariesDownloaded")]
    libraries_downloaded: i32,
    #[serde(rename = "assetsDownloaded")]
    assets_downloaded: i32,
}

#[derive(Debug, Serialize, Deserialize)]
struct LaunchPlan {
    command: Vec<String>,
    classpath: String,
    #[serde(rename = "mainClass")]
    main_class: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LaunchExecutionResult {
    #[serde(rename = "versionId")]
    version_id: String,
    pid: i64,
    #[serde(rename = "waitForExit")]
    wait_for_exit: bool,
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
    #[serde(rename = "mainClass")]
    main_class: String,
    #[serde(default)]
    shell: String,
    command: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FabricInstallResult {
    #[serde(rename = "profileId")]
    profile_id: String,
    #[serde(rename = "loaderVersion", default)]
    loader_version: Option<String>,
    #[serde(rename = "profileJsonPath", alias = "profilePath")]
    profile_json_path: String,
    #[serde(rename = "librariesDownloaded")]
    libraries_downloaded: i32,
}

#[derive(Debug, Serialize, Deserialize)]
struct ForgeInstallResult {
    #[serde(rename = "forgeVersion")]
    forge_version: String,
    #[serde(rename = "profileId")]
    profile_id: String,
    #[serde(rename = "profileJsonPath")]
    profile_json_path: String,
    #[serde(rename = "installerUrl")]
    installer_url: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ApiEnvelope<T> {
    success: bool,
    message: Option<String>,
    data: Option<T>,
}

#[derive(Debug, Serialize, Deserialize)]
struct LauncherLoginRequest {
    #[serde(rename = "usernameOrEmail")]
    username_or_email: String,
    password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherLoginResult {
    token: String,
    user: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MinecraftAuthConfigStatus {
    configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    configuration_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MinecraftAccountPayload {
    id: String,
    #[serde(rename = "type")]
    account_type: String,
    username: String,
    uuid: String,
    access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    xuid: Option<String>,
    expires_at: i64,
    added_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MinecraftDeviceLoginStart {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification_uri_complete: Option<String>,
    expires_in: u64,
    expires_at: i64,
    interval: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MinecraftDeviceLoginPollResult {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    interval: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<MinecraftAccountPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MicrosoftDeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    expires_in: u64,
    #[serde(default)]
    interval: Option<u64>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MicrosoftTokenSuccessResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MicrosoftTokenErrorResponse {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct XboxAuthResponse {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims")]
    display_claims: XboxDisplayClaims,
}

#[derive(Debug, Clone, Deserialize)]
struct XboxDisplayClaims {
    #[serde(rename = "xui", default)]
    users: Vec<XboxUserClaim>,
}

#[derive(Debug, Clone, Deserialize)]
struct XboxUserClaim {
    #[serde(default)]
    uhs: Option<String>,
    #[serde(default)]
    xid: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftLoginResponse {
    access_token: String,
    expires_in: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftProfileResponse {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftEntitlementsResponse {
    #[serde(default)]
    items: Vec<MinecraftEntitlementItem>,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftEntitlementItem {
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherVersion {
    #[serde(default)]
    id: Option<serde_json::Value>,
    channel: String,
    #[serde(rename = "versionType")]
    version_type: String,
    #[serde(rename = "versionName")]
    version_name: String,
    #[serde(rename = "artifactSourceType", default)]
    artifact_source_type: Option<String>,
    #[serde(rename = "downloadUrl")]
    download_url: String,
    #[serde(rename = "fileBucket", default)]
    file_bucket: Option<String>,
    #[serde(rename = "fileKey", default)]
    file_key: Option<String>,
    #[serde(rename = "fileSize", default)]
    file_size: Option<i64>,
    #[serde(default)]
    checksum: Option<String>,
    #[serde(rename = "manifestUrl", default)]
    manifest_url: Option<String>,
    #[serde(rename = "minLauncherVersion", default)]
    min_launcher_version: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    recommended: bool,
    #[serde(default)]
    changelog: Option<String>,
    #[serde(rename = "commitHash", default)]
    commit_hash: Option<String>,
    #[serde(rename = "createdAt", default)]
    created_at: Option<String>,
}

// Custom deserializer for category that extracts just the name as a string
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
                // Extract the "name" field from the category object
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
struct LauncherNewsItem {
    id: String,
    title: String,
    summary: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(
        default,
        deserialize_with = "category_option::deserialize",
        serialize_with = "category_option::serialize"
    )]
    category: Option<String>,
    #[serde(rename = "publishedAt", default)]
    published_at: Option<String>,
    #[serde(default)]
    pinned: bool,
    #[serde(rename = "targetClients", default)]
    target_clients: Vec<String>,
    #[serde(rename = "startsAt", default)]
    starts_at: Option<String>,
    #[serde(rename = "endsAt", default)]
    ends_at: Option<String>,
    #[serde(default)]
    severity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherServerItem {
    id: String,
    name: String,
    address: String,
    description: String,
    active: bool,
    mode: String,
    #[serde(rename = "iconPath", default)]
    icon_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherWeeklyPlaytimePoint {
    date: String,
    #[serde(rename = "playSeconds")]
    play_seconds: i64,
    #[serde(rename = "playMinutes")]
    play_minutes: i64,
    #[serde(rename = "playHours")]
    play_hours: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherWeeklyPlaytime {
    points: Vec<LauncherWeeklyPlaytimePoint>,
    #[serde(rename = "totalSeconds")]
    total_seconds: i64,
    #[serde(rename = "totalMinutes")]
    total_minutes: i64,
    #[serde(rename = "totalHours")]
    total_hours: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherUserStats {
    #[serde(rename = "totalActivities")]
    total_activities: i64,
    #[serde(rename = "playSessionCount")]
    play_session_count: i64,
    #[serde(rename = "totalPlaySeconds")]
    total_play_seconds: i64,
    #[serde(rename = "totalPlayHours")]
    total_play_hours: f64,
    #[serde(rename = "latestActivityAt", default)]
    latest_activity_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherDashboard {
    user: serde_json::Value,
    stats: LauncherUserStats,
    #[serde(rename = "weeklyPlaytime")]
    weekly_playtime: LauncherWeeklyPlaytime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TelemetryOnlineSummary {
    online: i64,
    total: i64,
    launcher: i64,
    edge: i64,
    nova: i64,
    generic: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherHomePayload {
    news: Vec<LauncherNewsItem>,
    servers: Vec<LauncherServerItem>,
    online: TelemetryOnlineSummary,
    dashboard: Option<LauncherDashboard>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherAppUpdateInfo {
    version: String,
    #[serde(rename = "downloadUrl")]
    download_url: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(rename = "publishedAt", default)]
    published_at: Option<String>,
    mandatory: bool,
    #[serde(default)]
    checksum: Option<String>,
    #[serde(rename = "fileSize", default)]
    file_size: Option<u64>,
    target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherAppUpdateChannel {
    code: String,
    name: String,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadedLauncherUpdate {
    version: String,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "filePath")]
    file_path: String,
}

#[derive(Debug, Clone, Serialize)]
struct LauncherModsInstallResult {
    #[serde(rename = "targetDir")]
    target_dir: String,
    #[serde(rename = "installedFiles")]
    installed_files: usize,
    skipped: bool,
    #[serde(rename = "versionTag")]
    version_tag: String,
    #[serde(rename = "manifestUrl")]
    manifest_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherInstalledFileRecord {
    path: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    checksum: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherModsInstallMarker {
    #[serde(rename = "versionTag")]
    version_tag: String,
    #[serde(default)]
    checksum: Option<String>,
    #[serde(rename = "manifestUrl", default)]
    manifest_url: Option<String>,
    #[serde(rename = "downloadUrl")]
    download_url: String,
    #[serde(default)]
    files: Vec<LauncherInstalledFileRecord>,
    #[serde(rename = "installedAtEpochSec")]
    installed_at_epoch_sec: u64,
}

#[derive(Debug, Clone, Serialize)]
struct LauncherPackageState {
    installed: bool,
    #[serde(rename = "upToDate")]
    up_to_date: bool,
    #[serde(rename = "versionTag")]
    version_tag: Option<String>,
    checksum: Option<String>,
    #[serde(rename = "manifestUrl")]
    manifest_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct LauncherPackageManifest {
    #[serde(rename = "versionTag", default)]
    version_tag: Option<String>,
    #[serde(rename = "baseUrl", default)]
    base_url: Option<String>,
    #[serde(default)]
    files: Vec<LauncherPackageManifestFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct LauncherPackageManifestFile {
    #[serde(alias = "targetPath", alias = "filePath")]
    path: String,
    #[serde(default, alias = "downloadUrl", alias = "sourceUrl")]
    url: Option<String>,
    #[serde(default, alias = "checksum", alias = "hash")]
    sha256: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct ModrinthSearchResult {
    source: String,
    #[serde(rename = "projectId")]
    project_id: String,
    slug: String,
    title: String,
    description: String,
    author: String,
    #[serde(rename = "iconUrl")]
    icon_url: Option<String>,
    downloads: u64,
    categories: Vec<String>,
    #[serde(rename = "displayCategories")]
    display_categories: Vec<String>,
    #[serde(rename = "projectType")]
    project_type: String,
    #[serde(rename = "latestGameVersion")]
    latest_game_version: Option<String>,
    #[serde(rename = "gameVersions")]
    game_versions: Vec<String>,
    #[serde(rename = "clientSide")]
    client_side: Option<String>,
    #[serde(rename = "serverSide")]
    server_side: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ModrinthInstallResult {
    source: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "projectTitle")]
    project_title: String,
    #[serde(rename = "contentType")]
    content_type: String,
    #[serde(rename = "versionId")]
    version_id: String,
    #[serde(rename = "versionNumber")]
    version_number: String,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "targetDir")]
    target_dir: String,
    #[serde(rename = "installedPath")]
    installed_path: String,
    changelog: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstalledContentItem {
    source: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "projectTitle")]
    project_title: String,
    #[serde(rename = "contentType")]
    content_type: String,
    #[serde(rename = "versionId")]
    version_id: String,
    #[serde(rename = "versionNumber")]
    version_number: String,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "installedPath")]
    installed_path: String,
    #[serde(rename = "installedAtEpochSec")]
    installed_at_epoch_sec: u64,
}

#[derive(Debug, Clone, Serialize)]
struct InstalledContentUpdate {
    source: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "contentType")]
    content_type: String,
    status: String,
    #[serde(rename = "updateAvailable")]
    update_available: bool,
    #[serde(rename = "installedVersionId")]
    installed_version_id: String,
    #[serde(rename = "installedVersionNumber")]
    installed_version_number: String,
    #[serde(rename = "latestVersionId")]
    latest_version_id: Option<String>,
    #[serde(rename = "latestVersionNumber")]
    latest_version_number: Option<String>,
    changelog: Option<String>,
    error: Option<String>,
    #[serde(rename = "checkedAtEpochSec")]
    checked_at_epoch_sec: u64,
}

#[derive(Debug, Clone, Serialize)]
struct WorldInstallResult {
    source: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "projectTitle")]
    project_title: String,
    #[serde(rename = "contentType")]
    content_type: String,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "installedPath")]
    installed_path: String,
    #[serde(rename = "installedAtEpochSec")]
    installed_at_epoch_sec: u64,
}

#[derive(Debug, Clone, Serialize)]
struct InstanceExportResult {
    #[serde(rename = "archivePath")]
    archive_path: String,
}

#[derive(Debug, Clone, Serialize)]
struct InstanceImportResult {
    #[serde(rename = "versionId")]
    version_id: String,
    #[serde(rename = "baseVersion")]
    base_version: String,
    loader: String,
    #[serde(rename = "loaderVersion")]
    loader_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct InstanceRepairResult {
    #[serde(rename = "versionId")]
    version_id: String,
    #[serde(rename = "baseVersion")]
    base_version: String,
    loader: String,
    #[serde(rename = "loaderVersion")]
    loader_version: Option<String>,
    #[serde(rename = "reinstalledFromVersionId")]
    reinstalled_from_version_id: String,
}

#[derive(Debug, Clone)]
struct InstanceProfileMetadata {
    version_id: String,
    base_version: String,
    loader: String,
    loader_version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModrinthSearchResponse {
    #[serde(default)]
    hits: Vec<ModrinthSearchHit>,
}

#[derive(Debug, Deserialize)]
struct ModrinthSearchHit {
    #[serde(rename = "project_id")]
    project_id: String,
    #[serde(default)]
    slug: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: String,
    #[serde(rename = "icon_url", default)]
    icon_url: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(rename = "display_categories", default)]
    display_categories: Vec<String>,
    #[serde(rename = "project_type")]
    project_type: String,
    #[serde(default)]
    versions: Vec<String>,
    #[serde(rename = "client_side", default)]
    client_side: Option<String>,
    #[serde(rename = "server_side", default)]
    server_side: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModrinthProjectVersion {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(rename = "version_number", default)]
    version_number: String,
    #[serde(default)]
    changelog: Option<String>,
    #[serde(rename = "date_published", default)]
    date_published: Option<String>,
    #[serde(default)]
    featured: bool,
    #[serde(rename = "version_type", default)]
    version_type: Option<String>,
    #[serde(default)]
    files: Vec<ModrinthVersionFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModrinthVersionFile {
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    hashes: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct CurseForgeEnvelope<T> {
    data: T,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseForgeSearchItem {
    id: u64,
    #[serde(default)]
    slug: String,
    name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    authors: Vec<CurseForgeAuthor>,
    #[serde(default)]
    categories: Vec<CurseForgeCategory>,
    #[serde(rename = "logo", default)]
    logo: Option<CurseForgeAsset>,
    #[serde(rename = "downloadCount", default)]
    download_count: Option<f64>,
    #[serde(rename = "latestFilesIndexes", default)]
    latest_files_indexes: Vec<CurseForgeFileIndex>,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseForgeAuthor {
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseForgeCategory {
    #[serde(rename = "classId", default)]
    class_id: Option<u64>,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseForgeAsset {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseForgeFileIndex {
    #[serde(rename = "gameVersion", default)]
    game_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseForgeFile {
    id: u64,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(rename = "fileName", default)]
    file_name: String,
    #[serde(rename = "downloadUrl", default)]
    download_url: Option<String>,
    #[serde(rename = "releaseType", default)]
    release_type: Option<u32>,
    #[serde(rename = "fileDate", default)]
    file_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct CoreLogEvent {
    level: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct GameExitEvent {
    pid: i64,
    #[serde(rename = "exitCode")]
    exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
struct ContentInstallProgressEvent {
    #[serde(rename = "projectKey")]
    project_key: String,
    #[serde(rename = "downloadedBytes")]
    downloaded_bytes: u64,
    #[serde(rename = "totalBytes")]
    total_bytes: Option<u64>,
    percent: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JavaRuntimeRequirement {
    #[serde(rename = "versionId")]
    version_id: String,
    #[serde(rename = "majorVersion")]
    major_version: i32,
    component: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct JdkEnsureResult {
    #[serde(rename = "majorVersion")]
    major_version: i32,
    #[serde(rename = "javaPath")]
    java_path: String,
    cached: bool,
}

#[derive(Debug, Clone, Serialize)]
struct UiLogEntry {
    seq: u64,
    source: String,
    level: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct UiLogPollResult {
    entries: Vec<UiLogEntry>,
    #[serde(rename = "nextSeq")]
    next_seq: u64,
}

#[derive(Debug, Default)]
struct UiLogStore {
    next_seq: u64,
    entries: VecDeque<UiLogEntry>,
}

static UI_LOG_STORE: OnceLock<Mutex<UiLogStore>> = OnceLock::new();
static GAME_RUNTIME_STARTS: OnceLock<Mutex<HashMap<i64, std::time::Instant>>> = OnceLock::new();
static GAME_RUNTIME_CACHE: OnceLock<Mutex<HashMap<i64, CachedGameRuntimeStats>>> = OnceLock::new();
static GAME_RUNTIME_SAMPLER_STARTED: OnceLock<()> = OnceLock::new();
static JAVA_CORE_RESOURCE_JAR: OnceLock<PathBuf> = OnceLock::new();
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const TRAY_SHOW_ID: &str = "tray_show";
const TRAY_HIDE_ID: &str = "tray_hide";
const TRAY_QUIT_ID: &str = "tray_quit";
const GAME_RUNTIME_CACHE_TTL_MS: u128 = 2500;
const GAME_RUNTIME_SAMPLE_INTERVAL_MS: u64 = 1000;
#[derive(Debug, Clone, Serialize)]
struct GameRuntimeStats {
    pid: i64,
    running: bool,
    #[serde(rename = "memoryMb")]
    memory_mb: Option<u64>,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct CachedGameRuntimeStats {
    stats: GameRuntimeStats,
    captured_at_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
struct InstanceSectionEntry {
    name: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
    #[serde(rename = "disabled")]
    disabled: bool,
}

fn ui_log_store() -> &'static Mutex<UiLogStore> {
    UI_LOG_STORE.get_or_init(|| Mutex::new(UiLogStore::default()))
}

fn game_runtime_starts() -> &'static Mutex<HashMap<i64, std::time::Instant>> {
    GAME_RUNTIME_STARTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn game_runtime_cache() -> &'static Mutex<HashMap<i64, CachedGameRuntimeStats>> {
    GAME_RUNTIME_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ensure_game_runtime_sampler() {
    GAME_RUNTIME_SAMPLER_STARTED.get_or_init(|| {
        thread::spawn(|| loop {
            sample_game_runtime_cache();
            thread::sleep(Duration::from_millis(GAME_RUNTIME_SAMPLE_INTERVAL_MS));
        });
    });
}

fn sample_game_runtime_cache() {
    let tracked = if let Ok(store) = game_runtime_starts().lock() {
        store
            .iter()
            .map(|(pid, started_at)| (*pid, started_at.elapsed().as_millis()))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    if tracked.is_empty() {
        return;
    }

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut stale = Vec::new();
    let mut sampled = Vec::new();

    for (pid, elapsed_raw) in tracked {
        match query_process_memory_kb(pid) {
            Ok(Some(memory_kb)) => {
                sampled.push((
                    pid,
                    GameRuntimeStats {
                        pid,
                        running: true,
                        memory_mb: Some(memory_kb / 1024),
                        elapsed_ms: u64::try_from(elapsed_raw).ok(),
                    },
                ));
            }
            Ok(None) => stale.push(pid),
            Err(_) => {}
        }
    }

    if let Ok(mut cache) = game_runtime_cache().lock() {
        for (pid, stats) in sampled {
            cache.insert(
                pid,
                CachedGameRuntimeStats {
                    stats,
                    captured_at_ms: now_ms,
                },
            );
        }
        for pid in &stale {
            cache.remove(pid);
        }
    }

    if !stale.is_empty() {
        if let Ok(mut store) = game_runtime_starts().lock() {
            for pid in stale {
                store.remove(&pid);
            }
        }
    }
}

fn push_ui_log(source: &str, level: &str, message: &str) {
    if let Ok(mut store) = ui_log_store().lock() {
        let entry = UiLogEntry {
            seq: store.next_seq,
            source: source.to_string(),
            level: level.to_string(),
            message: message.to_string(),
        };
        store.next_seq = store.next_seq.saturating_add(1);
        store.entries.push_back(entry);
        while store.entries.len() > 8000 {
            let _ = store.entries.pop_front();
        }
    }
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())
}

fn hide_main_window_internal(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
    window
        .hide()
        .map_err(|e| format!("Failed to hide main window: {e}"))?;

    // Schedule webview suspend (navigate to blank) after 60 seconds
    let state = app.state::<LauncherRuntimeState>();
    let stop_flag = state.webview_suspend_stop.clone();
    let app_handle = app.clone();

    *state.webview_suspend_scheduled.lock().unwrap() = Some(Instant::now());
    stop_flag.store(false, Ordering::Relaxed);

    thread::spawn(move || {
        // Wait 60 seconds, checking stop flag every second
        for _ in 0..60 {
            thread::sleep(Duration::from_secs(1));
            if stop_flag.load(Ordering::Relaxed) {
                return; // Cancelled
            }
        }

        // Navigate to a minimal suspended page (embedded HTML)
        if let Some(window) = app_handle.get_webview_window("main") {
            let suspended_html = r#"<!DOCTYPE html><html><head><title>Suspended</title></head><body style="background:#1a1a2e;margin:0;display:flex;align-items:center;justify-content:center;height:100vh;color:rgba(255,255,255,0.5);font-family:sans-serif;"><div style="text-align:center;"><div style="width:32px;height:32px;border:3px solid rgba(255,255,255,0.1);border-top-color:#25b87a;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px;"></div><div style="font-size:12px;letter-spacing:0.1em;">FPSMaster Launcher</div></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style></body></html>"#;
            let _ = window.eval(&format!(
                "document.open();document.write({:?});document.close();",
                suspended_html
            ));
            app_handle
                .state::<LauncherRuntimeState>()
                .webview_suspended
                .store(true, Ordering::Relaxed);
        }
    });

    Ok(())
}

fn show_main_window_internal(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LauncherRuntimeState>();

    // Cancel any pending suspend
    state.webview_suspend_stop.store(true, Ordering::Relaxed);
    *state.webview_suspend_scheduled.lock().unwrap() = None;

    let window = main_window(app)?;

    // If webview was suspended, navigate back to app root
    if state.webview_suspended.swap(false, Ordering::Relaxed) {
        let _ = window.eval("window.location.href = '/'");
    }

    if window
        .is_minimized()
        .map_err(|e| format!("Failed to inspect minimized state: {e}"))?
    {
        window
            .unminimize()
            .map_err(|e| format!("Failed to unminimize main window: {e}"))?;
    }
    window
        .show()
        .map_err(|e| format!("Failed to show main window: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus main window: {e}"))?;
    Ok(())
}

fn should_minimize_to_tray(app: &AppHandle) -> bool {
    app.state::<LauncherRuntimeState>()
        .minimize_to_tray
        .load(Ordering::Relaxed)
}

fn is_autostart_launch() -> bool {
    env::args().any(|arg| arg == "--autostart")
}

struct LauncherRuntimeState {
    minimize_to_tray: AtomicBool,
    telemetry_session: Mutex<Option<LauncherTelemetrySession>>,
    heartbeat_running: AtomicBool,
    heartbeat_stop: Arc<AtomicBool>,
    webview_suspend_scheduled: Mutex<Option<Instant>>,
    webview_suspend_stop: Arc<AtomicBool>,
    webview_suspended: AtomicBool,
}

impl Default for LauncherRuntimeState {
    fn default() -> Self {
        Self {
            minimize_to_tray: AtomicBool::new(true),
            telemetry_session: Mutex::new(None),
            heartbeat_running: AtomicBool::new(false),
            heartbeat_stop: Arc::new(AtomicBool::new(false)),
            webview_suspend_scheduled: Mutex::new(None),
            webview_suspend_stop: Arc::new(AtomicBool::new(false)),
            webview_suspended: AtomicBool::new(false),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherTelemetrySession {
    #[serde(rename = "baseUrl")]
    base_url: String,
    #[serde(rename = "clientName")]
    client_name: String,
    #[serde(rename = "clientKind")]
    client_kind: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(rename = "playerUuid", skip_serializing_if = "Option::is_none")]
    player_uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct LauncherTelemetryOfflineRequest {
    #[serde(rename = "clientName")]
    client_name: String,
    #[serde(rename = "clientKind")]
    client_kind: String,
    #[serde(rename = "sessionId")]
    session_id: String,
}

impl From<&LauncherTelemetrySession> for LauncherTelemetryOfflineRequest {
    fn from(value: &LauncherTelemetrySession) -> Self {
        Self {
            client_name: value.client_name.clone(),
            client_kind: value.client_kind.clone(),
            session_id: value.session_id.clone(),
        }
    }
}

fn cache_launcher_telemetry_session(app: &AppHandle, session: LauncherTelemetrySession) {
    if let Ok(mut guard) = app.state::<LauncherRuntimeState>().telemetry_session.lock() {
        *guard = Some(session);
    }
}

fn take_launcher_telemetry_session(app: &AppHandle) -> Option<LauncherTelemetrySession> {
    app.state::<LauncherRuntimeState>()
        .telemetry_session
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

fn post_launcher_telemetry_offline(session: &LauncherTelemetrySession) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Failed to build telemetry HTTP client: {e}"))?;
    let normalized_base = normalize_api_base_url(&session.base_url)?;
    let url = reqwest::Url::parse(&format!("{normalized_base}/api/v1/telemetry/offline"))
        .map_err(|e| format!("Invalid telemetry offline endpoint URL: {e}"))?;
    let payload = LauncherTelemetryOfflineRequest::from(session);
    let response = client
        .post(url)
        .json(&payload)
        .send()
        .map_err(|e| format!("Failed to submit launcher telemetry offline request: {e}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Launcher telemetry offline request failed with HTTP {}",
            response.status()
        ))
    }
}

fn flush_launcher_telemetry_session(app: &AppHandle) {
    if let Some(session) = take_launcher_telemetry_session(app) {
        if let Err(err) = post_launcher_telemetry_offline(&session) {
            push_ui_log("launcher", "warn", &err);
        }
    }
}

#[tauri::command]
fn poll_ui_logs(after_seq: Option<u64>) -> UiLogPollResult {
    if let Ok(store) = ui_log_store().lock() {
        let entries = if let Some(after) = after_seq {
            store
                .entries
                .iter()
                .filter(|entry| entry.seq > after)
                .cloned()
                .collect()
        } else {
            store.entries.iter().cloned().collect()
        };
        return UiLogPollResult {
            entries,
            next_seq: store.next_seq,
        };
    }
    UiLogPollResult {
        entries: Vec::new(),
        next_seq: 0,
    }
}

#[tauri::command]
fn poll_game_runtime(pid: i64) -> Result<GameRuntimeStats, String> {
    if pid <= 0 {
        return Err("Invalid pid".to_string());
    }

    ensure_game_runtime_sampler();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if let Ok(cache) = game_runtime_cache().lock() {
        if let Some(cached) = cache.get(&pid) {
            if now_ms.saturating_sub(cached.captured_at_ms) <= GAME_RUNTIME_CACHE_TTL_MS {
                return Ok(cached.stats.clone());
            }
        }
    }
    if let Ok(store) = game_runtime_starts().lock() {
        if let Some(start) = store.get(&pid) {
            return Ok(GameRuntimeStats {
                pid,
                running: true,
                memory_mb: None,
                elapsed_ms: u64::try_from(start.elapsed().as_millis()).ok(),
            });
        }
    }
    Ok(GameRuntimeStats {
        pid,
        running: false,
        memory_mb: None,
        elapsed_ms: None,
    })
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window_internal(&app)
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    hide_main_window_internal(&app)
}

#[tauri::command]
fn configure_tray_behavior(app: tauri::AppHandle, minimize_to_tray: bool) {
    app.state::<LauncherRuntimeState>()
        .minimize_to_tray
        .store(minimize_to_tray, Ordering::Relaxed);
}

#[tauri::command]
fn set_launch_on_startup(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch()
            .enable()
            .map_err(|e| format!("Failed to enable autostart: {e}"))?;
    } else {
        app.autolaunch()
            .disable()
            .map_err(|e| format!("Failed to disable autostart: {e}"))?;
    }
    Ok(())
}

fn create_tray(app: &AppHandle) -> Result<(), String> {
    let show_item = MenuItem::with_id(app, TRAY_SHOW_ID, "Open Launcher", true, None::<&str>)
        .map_err(|e| format!("Failed to create tray show item: {e}"))?;
    let hide_item = MenuItem::with_id(app, TRAY_HIDE_ID, "Hide Launcher", true, None::<&str>)
        .map_err(|e| format!("Failed to create tray hide item: {e}"))?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit", true, None::<&str>)
        .map_err(|e| format!("Failed to create tray quit item: {e}"))?;
    let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])
        .map_err(|e| format!("Failed to create tray menu: {e}"))?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "Failed to load tray icon: default window icon is missing".to_string())?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => {
                let _ = show_main_window_internal(app);
            }
            TRAY_HIDE_ID => {
                let _ = hide_main_window_internal(app);
            }
            TRAY_QUIT_ID => {
                flush_launcher_telemetry_session(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Ok(window) = main_window(app) {
                    let is_visible = window.is_visible().unwrap_or(false);
                    if is_visible {
                        let _ = hide_main_window_internal(app);
                    } else {
                        let _ = show_main_window_internal(app);
                    }
                }
            }
        })
        .build(app)
        .map_err(|e| format!("Failed to build tray icon: {e}"))?;
    Ok(())
}

#[tauri::command]
fn terminate_game_process(pid: i64, force: Option<bool>) -> Result<bool, String> {
    if pid <= 0 {
        return Err("Invalid pid".to_string());
    }

    let hard = force.unwrap_or(true);
    let running_before = query_process_memory_kb(pid)?.is_some();
    if !running_before {
        clear_runtime_pid(pid);
        return Ok(false);
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.arg("/PID").arg(pid.to_string()).arg("/T");
        apply_windows_silent_spawn(&mut command);
        if hard {
            command.arg("/F");
        }
        let output = command
            .output()
            .map_err(|e| format!("Failed to run taskkill: {e}"))?;
        if !output.status.success() && query_process_memory_kb(pid)?.is_some() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to terminate process {pid}: {stderr}"));
        }
    }

    #[cfg(not(windows))]
    {
        let signal = if hard { "-KILL" } else { "-TERM" };
        let output = Command::new("kill")
            .arg(signal)
            .arg(pid.to_string())
            .output()
            .map_err(|e| format!("Failed to run kill command: {e}"))?;
        if !output.status.success() && query_process_memory_kb(pid)?.is_some() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to terminate process {pid}: {stderr}"));
        }
    }

    thread::sleep(Duration::from_millis(120));
    let running_after = query_process_memory_kb(pid)?.is_some();
    if !running_after {
        clear_runtime_pid(pid);
        push_ui_log("game", "exit", &format!("process terminated pid={pid}"));
    }
    Ok(!running_after)
}

#[tauri::command]
fn is_version_installed(game_dir: String, version_id: String) -> Result<bool, String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let profile_json = game_dir_path
        .join("versions")
        .join(&version_id)
        .join(format!("{version_id}.json"));
    Ok(profile_json.exists())
}

#[tauri::command]
fn list_installed_versions(game_dir: String) -> Result<Vec<String>, String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let versions_dir = game_dir_path.join("versions");
    if !versions_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&versions_dir).map_err(|e| {
        format!(
            "Failed to read versions directory {}: {e}",
            versions_dir.display()
        )
    })?;

    let mut installed = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        let version_path = entry.path();
        if !version_path.is_dir() {
            continue;
        }
        let version_id = entry.file_name().to_string_lossy().to_string();
        if version_id.is_empty() {
            continue;
        }
        let version_json = version_path.join(format!("{version_id}.json"));
        if version_json.exists() {
            installed.push(version_id);
        }
    }

    installed.sort();
    installed.reverse();
    Ok(installed)
}

#[tauri::command]
fn rename_version_profile(
    game_dir: String,
    from_version_id: String,
    to_version_id: String,
) -> Result<String, String> {
    let from_id = from_version_id.trim();
    let to_id = to_version_id.trim();
    if from_id.is_empty() || to_id.is_empty() {
        return Err("Version id cannot be empty".to_string());
    }
    if from_id == to_id {
        return Ok(to_id.to_string());
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let versions_dir = game_dir_path.join("versions");
    let from_dir = versions_dir.join(from_id);
    let to_dir = versions_dir.join(to_id);
    let to_json = to_dir.join(format!("{to_id}.json"));

    if to_json.exists() {
        rewrite_version_profile_id(&to_json, to_id)?;
        return Ok(to_id.to_string());
    }
    if is_launcher_preset_version_id(to_id) {
        if to_dir.exists() {
            if retarget_version_runtime(&to_dir, from_id, to_id).is_ok() {
                return Ok(to_id.to_string());
            }
            if from_dir.exists() {
                copy_directory_contents(&from_dir, &to_dir)?;
                retarget_version_runtime(&to_dir, from_id, to_id)?;
                let _ = fs::remove_dir_all(&from_dir);
            }
            return Ok(to_id.to_string());
        }
        if !from_dir.exists() {
            return Ok(to_id.to_string());
        }
    }
    if to_dir.exists() {
        if !from_dir.exists() {
            return Err(format!(
                "Target version directory already exists but profile json is missing, and source version directory was not found: {}",
                to_dir.display()
            ));
        }

        copy_directory_contents(&from_dir, &to_dir)?;
        retarget_version_runtime(&to_dir, from_id, to_id)?;
        let _ = fs::remove_dir_all(&from_dir);
        return Ok(to_id.to_string());
    }
    if !from_dir.exists() {
        return Err(format!(
            "Source version directory not found: {}",
            from_dir.display()
        ));
    }

    fs::rename(&from_dir, &to_dir).map_err(|e| {
        format!(
            "Failed to rename version directory from {} to {}: {e}",
            from_dir.display(),
            to_dir.display()
        )
    })?;
    retarget_version_runtime(&to_dir, from_id, to_id)?;

    Ok(to_id.to_string())
}

fn is_launcher_preset_version_id(version_id: &str) -> bool {
    matches!(version_id, "FPSMaster-Edge" | "FPSMaster-Nova")
}

#[tauri::command]
fn duplicate_instance_storage(
    game_dir: String,
    source_version_id: String,
    target_version_id: String,
) -> Result<String, String> {
    let source_id = source_version_id.trim();
    let target_id = target_version_id.trim();
    if source_id.is_empty() || target_id.is_empty() {
        return Err("Version id cannot be empty".to_string());
    }
    if source_id == target_id {
        return Err("Source and target version ids must be different".to_string());
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let versions_dir = game_dir_path.join("versions");
    let source_dir = versions_dir.join(source_id);
    let target_dir = versions_dir.join(target_id);
    let source_json = source_dir.join(format!("{source_id}.json"));

    if !source_dir.exists() || !source_json.exists() {
        return Err(format!(
            "Source instance files are missing: {}",
            source_dir.display()
        ));
    }
    if target_dir.exists() {
        return Err(format!(
            "Target instance version already exists: {}",
            target_dir.display()
        ));
    }

    copy_directory_contents(&source_dir, &target_dir)?;
    retarget_version_runtime(&target_dir, source_id, target_id)?;
    Ok(target_id.to_string())
}

#[tauri::command]
fn export_instance_archive(
    game_dir: String,
    version_id: String,
    archive_name: Option<String>,
) -> Result<InstanceExportResult, String> {
    let normalized_version_id = version_id.trim();
    if normalized_version_id.is_empty() {
        return Err("Version id cannot be empty".to_string());
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let source_dir = game_dir_path.join("versions").join(normalized_version_id);
    let source_json = source_dir.join(format!("{normalized_version_id}.json"));
    if !source_dir.exists() || !source_json.exists() {
        return Err(format!(
            "Instance files are missing for export: {}",
            source_dir.display()
        ));
    }

    let export_base_name = archive_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Path::new(value)
                .file_stem()
                .map(|item| item.to_string_lossy().to_string())
                .unwrap_or_else(|| value.to_string())
        })
        .unwrap_or_else(|| normalized_version_id.to_string());
    let safe_archive_name = sanitize_file_name(&export_base_name)
        .trim()
        .trim_matches('.')
        .to_string();
    if safe_archive_name.is_empty() {
        return Err("Archive name cannot be empty".to_string());
    }

    let exports_dir = game_dir_path.join("exports");
    fs::create_dir_all(&exports_dir).map_err(|e| {
        format!(
            "Failed to create exports directory {}: {e}",
            exports_dir.display()
        )
    })?;
    let archive_path =
        exports_dir.join(format!("{}-{}.zip", safe_archive_name, now_epoch_millis()));

    write_instance_archive(&source_dir, &archive_path, &safe_archive_name)?;
    let _ = open_path_in_explorer(&exports_dir);

    Ok(InstanceExportResult {
        archive_path: archive_path.to_string_lossy().to_string(),
    })
}

fn import_instance_archive_blocking(
    game_dir: String,
    archive_name: String,
    archive_data: Vec<u8>,
    target_version_id: Option<String>,
) -> Result<InstanceImportResult, String> {
    if archive_data.is_empty() {
        return Err("Instance archive cannot be empty".to_string());
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let versions_dir = game_dir_path.join("versions");
    fs::create_dir_all(&versions_dir).map_err(|e| {
        format!(
            "Failed to create versions directory {}: {e}",
            versions_dir.display()
        )
    })?;

    let stage_root = env::temp_dir().join(format!(
        ".fpsmaster-instance-import-{}-{}",
        std::process::id(),
        now_epoch_millis()
    ));
    if stage_root.exists() {
        fs::remove_dir_all(&stage_root).map_err(|e| {
            format!(
                "Failed to reset instance staging directory {}: {e}",
                stage_root.display()
            )
        })?;
    }
    fs::create_dir_all(&stage_root).map_err(|e| {
        format!(
            "Failed to create instance staging directory {}: {e}",
            stage_root.display()
        )
    })?;

    let extracted_entries = extract_archive_to_stage(&archive_data, &stage_root, "instance")?;
    if extracted_entries == 0 {
        let _ = fs::remove_dir_all(&stage_root);
        return Err("Instance archive does not contain importable files".to_string());
    }

    let extracted_root = determine_archive_stage_root(&stage_root, "instance")?;
    let source_json = find_instance_profile_json(&extracted_root)?;
    let source_root = source_json
        .parent()
        .ok_or_else(|| "Imported instance profile path is invalid".to_string())?
        .to_path_buf();
    let metadata = parse_instance_profile_metadata(&source_json)?;
    let fallback_version_id =
        archive_file_stem(&archive_name).unwrap_or_else(|| metadata.version_id.clone());
    let resolved_target_version_id = normalize_version_identifier(
        target_version_id
            .as_deref()
            .unwrap_or(&metadata.version_id)
            .trim(),
    )
    .or_else(|_| normalize_version_identifier(&fallback_version_id))?;

    let target_dir = versions_dir.join(&resolved_target_version_id);
    if target_dir.exists() {
        let _ = fs::remove_dir_all(&stage_root);
        return Err(format!(
            "Target instance version already exists: {}",
            target_dir.display()
        ));
    }

    move_or_copy_directory(&source_root, &target_dir)?;
    let _ = fs::remove_dir_all(&stage_root);
    retarget_version_runtime(
        &target_dir,
        &metadata.version_id,
        &resolved_target_version_id,
    )?;

    Ok(InstanceImportResult {
        version_id: resolved_target_version_id,
        base_version: metadata.base_version,
        loader: metadata.loader,
        loader_version: metadata.loader_version,
    })
}

fn repair_instance_runtime_blocking(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    loader: String,
    base_version: String,
    loader_version: Option<String>,
) -> Result<InstanceRepairResult, String> {
    let normalized_version_id = normalize_version_identifier(version_id.trim())?;
    let normalized_loader = normalize_loader_kind(&loader)?;
    let normalized_base_version = base_version.trim().to_string();
    if normalized_base_version.is_empty() {
        return Err("Base version cannot be empty".to_string());
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let versions_dir = game_dir_path.join("versions");
    fs::create_dir_all(&versions_dir).map_err(|e| {
        format!(
            "Failed to create versions directory {}: {e}",
            versions_dir.display()
        )
    })?;

    let vanilla = install_vanilla_blocking_core(
        Some(&window),
        &game_dir_path,
        &normalized_base_version,
        None,
    )?;
    let mut source_version_id = vanilla.version_id;
    let mut resolved_loader_version = loader_version
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if normalized_loader == "fabric" {
        if resolved_loader_version.is_none() {
            let loader_versions =
                list_fabric_loaders_blocking_core(Some(&window), &normalized_base_version, None)?;
            resolved_loader_version = loader_versions
                .into_iter()
                .find(|value| !value.trim().is_empty());
        }
        let selected_loader_version = resolved_loader_version.clone().ok_or_else(|| {
            format!(
                "No fabric loader version available for {}",
                normalized_base_version
            )
        })?;
        let fabric = install_fabric_blocking_core(
            Some(&window),
            &game_dir_path,
            &normalized_base_version,
            &selected_loader_version,
            None,
        )?;
        source_version_id = fabric.profile_id;
    } else if normalized_loader == "forge" {
        if resolved_loader_version.is_none() {
            let forge_versions =
                list_forge_versions_blocking_core(Some(&window), &normalized_base_version, None)?;
            resolved_loader_version = forge_versions
                .into_iter()
                .find(|value| !value.trim().is_empty());
        }
        let selected_loader_version = resolved_loader_version
            .clone()
            .ok_or_else(|| format!("No forge version available for {}", normalized_base_version))?;
        let jdk = ensure_jdk_blocking(
            window.clone(),
            strip_windows_verbatim_prefix(&game_dir_path)
                .to_string_lossy()
                .to_string(),
            normalized_base_version.clone(),
        )?;
        let forge = install_forge_blocking_core(
            Some(&window),
            &game_dir_path,
            &selected_loader_version,
            &jdk.java_path,
            None,
        )?;
        source_version_id = forge.profile_id;
        resolved_loader_version = Some(forge.forge_version);
    }

    let source_dir = versions_dir.join(&source_version_id);
    let source_json = source_dir.join(format!("{source_version_id}.json"));
    if !source_dir.exists() || !source_json.exists() {
        return Err(format!(
            "Freshly installed instance files are missing: {}",
            source_dir.display()
        ));
    }

    let stage_dir = env::temp_dir().join(format!(
        ".fpsmaster-instance-repair-{}-{}",
        std::process::id(),
        now_epoch_millis()
    ));
    if stage_dir.exists() {
        fs::remove_dir_all(&stage_dir).map_err(|e| {
            format!(
                "Failed to reset instance repair staging directory {}: {e}",
                stage_dir.display()
            )
        })?;
    }
    copy_directory_contents(&source_dir, &stage_dir)?;
    retarget_version_runtime(&stage_dir, &source_version_id, &normalized_version_id)?;

    let target_dir = versions_dir.join(&normalized_version_id);
    copy_directory_contents(&stage_dir, &target_dir)?;
    let _ = fs::remove_dir_all(&stage_dir);
    if source_version_id != normalized_version_id && source_dir.exists() {
        let _ = fs::remove_dir_all(&source_dir);
    }

    Ok(InstanceRepairResult {
        version_id: normalized_version_id,
        base_version: normalized_base_version,
        loader: normalized_loader,
        loader_version: resolved_loader_version,
        reinstalled_from_version_id: source_version_id,
    })
}

#[tauri::command]
async fn import_instance_archive(
    game_dir: String,
    archive_name: String,
    archive_data: Vec<u8>,
    target_version_id: Option<String>,
) -> Result<InstanceImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_instance_archive_blocking(game_dir, archive_name, archive_data, target_version_id)
    })
    .await
    .map_err(|e| format!("Failed to join instance import task: {e}"))?
}

#[tauri::command]
async fn repair_instance_runtime(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    loader: String,
    base_version: String,
    loader_version: Option<String>,
) -> Result<InstanceRepairResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        repair_instance_runtime_blocking(
            window,
            game_dir,
            version_id,
            loader,
            base_version,
            loader_version,
        )
    })
    .await
    .map_err(|e| format!("Failed to join instance repair task: {e}"))?
}

fn rewrite_version_profile_id(json_path: &Path, version_id: &str) -> Result<(), String> {
    let profile_json_text = fs::read_to_string(json_path)
        .map_err(|e| format!("Failed to read profile json {}: {e}", json_path.display()))?;
    let mut profile_json: serde_json::Value = serde_json::from_str(&profile_json_text)
        .map_err(|e| format!("Failed to parse profile json {}: {e}", json_path.display()))?;
    if let Some(object) = profile_json.as_object_mut() {
        object.insert(
            "id".to_string(),
            serde_json::Value::String(version_id.to_string()),
        );
    }
    let encoded = serde_json::to_string_pretty(&profile_json)
        .map_err(|e| format!("Failed to encode profile json {}: {e}", json_path.display()))?;
    fs::write(json_path, format!("{encoded}\n"))
        .map_err(|e| format!("Failed to write profile json {}: {e}", json_path.display()))?;
    Ok(())
}

fn retarget_version_runtime(
    version_dir: &Path,
    from_version_id: &str,
    to_version_id: &str,
) -> Result<(), String> {
    let source_json = version_dir.join(format!("{from_version_id}.json"));
    let target_json = version_dir.join(format!("{to_version_id}.json"));
    if source_json.exists() && source_json != target_json {
        fs::rename(&source_json, &target_json).map_err(|e| {
            format!(
                "Failed to rename version json from {} to {}: {e}",
                source_json.display(),
                target_json.display()
            )
        })?;
    }
    if !target_json.exists() {
        return Err(format!(
            "Version json missing after retarget, expected {}",
            target_json.display()
        ));
    }

    let source_jar = version_dir.join(format!("{from_version_id}.jar"));
    let target_jar = version_dir.join(format!("{to_version_id}.jar"));
    if source_jar.exists() && source_jar != target_jar {
        if target_jar.exists() {
            fs::remove_file(&source_jar).map_err(|e| {
                format!(
                    "Failed to discard duplicate version jar {}: {e}",
                    source_jar.display()
                )
            })?;
        } else {
            fs::rename(&source_jar, &target_jar).map_err(|e| {
                format!(
                    "Failed to rename version jar from {} to {}: {e}",
                    source_jar.display(),
                    target_jar.display()
                )
            })?;
        }
    }

    rewrite_version_profile_id(&target_json, to_version_id)?;
    Ok(())
}

#[tauri::command]
fn get_default_game_dir() -> Result<String, String> {
    let path = default_game_dir_path()?;
    Ok(strip_windows_verbatim_prefix(&path)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn get_system_wallpaper() -> Result<Option<String>, String> {
    let path = match get_system_wallpaper_path()? {
        Some(path) => path,
        None => return Ok(None),
    };
    Ok(Some(read_image_file_as_data_url(Path::new(&path))?))
}

#[tauri::command]
fn extract_background_theme_accent(
    background_source: String,
    background_image: String,
    background_web_url: String,
) -> Result<String, String> {
    let image_bytes = load_background_image_bytes(
        background_source.trim(),
        background_image.trim(),
        background_web_url.trim(),
    )?;
    extract_theme_accent_hex_from_bytes(&image_bytes)
}

#[tauri::command]
async fn ensure_jdk(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
) -> Result<JdkEnsureResult, String> {
    let window_clone = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_jdk_blocking(window_clone, game_dir, version_id)
    })
    .await
    .map_err(|e| format!("Failed to join ensure_jdk task: {e}"))?
}

fn ensure_jdk_blocking(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
) -> Result<JdkEnsureResult, String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let resolved_game_dir = game_dir_path.to_string_lossy().to_string();
    let requirement_output = run_java_core(
        Some(&window),
        &[
            "resolve-java-major",
            "--version",
            &version_id,
            "--game-dir",
            &resolved_game_dir,
        ],
    )?;
    let requirement: JavaRuntimeRequirement = serde_json::from_str(&requirement_output)
        .map_err(|e| format!("Failed to parse java runtime requirement: {e}"))?;

    let major = requirement.major_version.max(8);
    let runtime_root = managed_jdk_runtime_root(&game_dir_path, major);
    let java_path = ensure_managed_jdk_runtime(Some(&window), &runtime_root, major)?;

    emit_log(
        Some(&window),
        "info",
        &format!(
            "JDK ready major={major} path={}",
            java_path.to_string_lossy()
        ),
    );

    Ok(JdkEnsureResult {
        major_version: major,
        java_path: java_path.to_string_lossy().to_string(),
        cached: false,
    })
}

#[tauri::command]
async fn launcher_login(
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
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let payload = LauncherLoginRequest {
        username_or_email: username_or_email.trim().to_string(),
        password,
    };
    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .map_err(|e| format!("Login request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read login response: {e}"))?;
    parse_launcher_login_response(status, &text)
}

#[tauri::command]
async fn launcher_list_available_versions(
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
async fn launcher_list_news(
    base_url: String,
    limit: Option<u32>,
) -> Result<Vec<LauncherNewsItem>, String> {
    tauri::async_runtime::spawn_blocking(move || launcher_list_news_blocking(base_url, limit))
        .await
        .map_err(|e| format!("Failed to join launcher news task: {e}"))?
}

#[tauri::command]
async fn launcher_get_dashboard(
    base_url: String,
    token: String,
) -> Result<LauncherDashboard, String> {
    tauri::async_runtime::spawn_blocking(move || launcher_get_dashboard_blocking(base_url, token))
        .await
        .map_err(|e| format!("Failed to join launcher dashboard task: {e}"))?
}

#[tauri::command]
async fn launcher_get_home(
    base_url: String,
    token: Option<String>,
) -> Result<LauncherHomePayload, String> {
    tauri::async_runtime::spawn_blocking(move || launcher_get_home_blocking(base_url, token))
        .await
        .map_err(|e| format!("Failed to join launcher home task: {e}"))?
}

#[tauri::command]
async fn launcher_get_app_update(
    app: tauri::AppHandle,
    base_url: String,
    channel: Option<String>,
) -> Result<LauncherAppUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || launcher_get_app_update_blocking(&app, base_url, channel))
        .await
        .map_err(|e| format!("Failed to join launcher app update task: {e}"))?
}

#[tauri::command]
async fn launcher_list_app_update_channels(
    base_url: String,
    token: Option<String>,
) -> Result<Vec<LauncherAppUpdateChannel>, String> {
    tauri::async_runtime::spawn_blocking(move || launcher_list_app_update_channels_blocking(base_url, token))
        .await
        .map_err(|e| format!("Failed to join launcher app update channels task: {e}"))?
}

#[tauri::command]
async fn download_launcher_app_update(
    app: tauri::AppHandle,
    download_url: String,
    version: String,
    checksum: Option<String>,
) -> Result<DownloadedLauncherUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        download_launcher_app_update_blocking(&app, download_url, version, checksum)
    })
    .await
    .map_err(|e| format!("Failed to join launcher app download task: {e}"))?
}

#[tauri::command]
fn open_downloaded_file(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(file_path.trim());
    if path.as_os_str().is_empty() {
        return Err("Downloaded file path is empty".to_string());
    }
    open_file_with_system(&path)
}

#[tauri::command]
fn get_minecraft_auth_config() -> MinecraftAuthConfigStatus {
    resolve_minecraft_auth_config_status()
}

#[tauri::command]
async fn start_minecraft_device_login() -> Result<MinecraftDeviceLoginStart, String> {
    tauri::async_runtime::spawn_blocking(start_minecraft_device_login_blocking)
        .await
        .map_err(|e| format!("Failed to join Minecraft device login task: {e}"))?
}

#[tauri::command]
async fn start_minecraft_browser_login(app: tauri::AppHandle) -> Result<MinecraftAccountPayload, String> {
    tauri::async_runtime::spawn_blocking(move || start_minecraft_browser_login_blocking(app))
        .await
        .map_err(|e| format!("Failed to join Minecraft browser login task: {e}"))?
}

#[tauri::command]
async fn poll_minecraft_device_login(
    device_code: String,
) -> Result<MinecraftDeviceLoginPollResult, String> {
    tauri::async_runtime::spawn_blocking(move || poll_minecraft_device_login_blocking(device_code))
        .await
        .map_err(|e| format!("Failed to join Minecraft device login polling task: {e}"))?
}

#[tauri::command]
async fn refresh_minecraft_account(
    refresh_token: String,
) -> Result<MinecraftAccountPayload, String> {
    tauri::async_runtime::spawn_blocking(move || refresh_minecraft_account_blocking(refresh_token))
        .await
        .map_err(|e| format!("Failed to join Minecraft refresh task: {e}"))?
}

#[tauri::command]
fn open_external_link(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|e| format!("Invalid external URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => open_target_with_system(parsed.as_str()),
        other => Err(format!("Unsupported external URL scheme: {other}")),
    }
}

#[tauri::command]
fn quit_launcher_app(app: tauri::AppHandle) {
    flush_launcher_telemetry_session(&app);
    app.exit(0);
}

#[tauri::command]
fn launcher_cache_telemetry_session(app: tauri::AppHandle, session: LauncherTelemetrySession) {
    cache_launcher_telemetry_session(&app, session);
}

#[tauri::command]
fn launcher_offline_telemetry_session(app: tauri::AppHandle) {
    flush_launcher_telemetry_session(&app);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherHeartbeatRequest {
    #[serde(rename = "clientName")]
    client_name: String,
    #[serde(rename = "clientKind")]
    client_kind: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(rename = "playerUuid", skip_serializing_if = "Option::is_none")]
    player_uuid: Option<String>,
}

fn post_launcher_heartbeat(session: &LauncherTelemetrySession) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build heartbeat HTTP client: {e}"))?;
    let normalized_base = normalize_api_base_url(&session.base_url)?;
    let url = reqwest::Url::parse(&format!("{normalized_base}/api/v1/telemetry/heartbeat"))
        .map_err(|e| format!("Invalid heartbeat endpoint URL: {e}"))?;
    let payload = LauncherHeartbeatRequest {
        client_name: session.client_name.clone(),
        client_kind: session.client_kind.clone(),
        session_id: session.session_id.clone(),
        username: session.username.clone(),
        player_uuid: session.player_uuid.clone(),
    };
    let response = client
        .post(url)
        .json(&payload)
        .send()
        .map_err(|e| format!("Failed to send heartbeat request: {e}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Heartbeat request failed with HTTP {}",
            response.status()
        ))
    }
}

#[tauri::command]
fn start_launcher_heartbeat(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<LauncherRuntimeState>();
    // Check if already running
    if state.heartbeat_running.load(Ordering::Relaxed) {
        return Ok(());
    }

    // Get session
    let session = state
        .telemetry_session
        .lock()
        .map_err(|e| format!("Failed to lock telemetry session: {e}"))?
        .clone()
        .ok_or("No telemetry session cached")?;

    // Set running flag
    state.heartbeat_running.store(true, Ordering::Relaxed);
    state.heartbeat_stop.store(false, Ordering::Relaxed);

    let stop_flag = state.heartbeat_stop.clone();
    let app_handle = app.clone();

    thread::spawn(move || {
        let mut interval = Duration::from_secs(90); // Base interval: 90 seconds
        let mut counter = 0u32;

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            // Send heartbeat
            if let Err(err) = post_launcher_heartbeat(&session) {
                push_ui_log("launcher", "warn", &format!("heartbeat failed: {}", err));
            }

            // Sleep with jitter
            let jitter = (rand::random::<u64>() % 15) as u64; // 0-14 seconds jitter
            let sleep_duration = interval + Duration::from_secs(jitter);
            thread::sleep(sleep_duration);

            counter += 1;
            // Every 10 heartbeats (~15 minutes), verify session still exists
            if counter >= 10 {
                counter = 0;
                let still_valid = app_handle
                    .state::<LauncherRuntimeState>()
                    .heartbeat_running
                    .load(Ordering::Relaxed);
                if !still_valid {
                    break;
                }
            }
        }

        // Clear running flag when stopped
        let _ = app
            .state::<LauncherRuntimeState>()
            .heartbeat_running
            .compare_exchange(true, false, Ordering::Relaxed, Ordering::Relaxed);
    });

    Ok(())
}

#[tauri::command]
fn stop_launcher_heartbeat(app: tauri::AppHandle) {
    app.state::<LauncherRuntimeState>()
        .heartbeat_stop
        .store(true, Ordering::Relaxed);
    app.state::<LauncherRuntimeState>()
        .heartbeat_running
        .store(false, Ordering::Relaxed);
}

fn launcher_list_news_blocking(
    base_url: String,
    limit: Option<u32>,
) -> Result<Vec<LauncherNewsItem>, String> {
    let normalized_base = normalize_api_base_url(&base_url)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut url = reqwest::Url::parse(&format!("{normalized_base}/api/v1/launcher/news"))
        .map_err(|e| format!("Invalid launcher news endpoint URL: {e}"))?;
    url.query_pairs_mut()
        .append_pair("limit", &limit.unwrap_or(4).clamp(1, 12).to_string())
        .append_pair("clientKind", "LAUNCHER");

    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Launcher news request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read launcher news response: {e}"))?;
    parse_launcher_news_response(status, &text)
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

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let url = reqwest::Url::parse(&format!("{normalized_base}/api/v1/launcher/dashboard"))
        .map_err(|e| format!("Invalid launcher dashboard endpoint URL: {e}"))?;
    let response = client
        .get(url)
        .bearer_auth(&normalized_token)
        .send()
        .map_err(|e| format!("Launcher dashboard request failed: {e}"))?;
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
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

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
        .map_err(|e| format!("Launcher home request failed: {e}"))?;
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
    let client = build_blocking_http_client()?;
    let install_id = get_or_create_launcher_install_id(app)?;
    let mut url = reqwest::Url::parse(&format!("{normalized_base}/api/v1/launcher/app-update"))
        .map_err(|e| format!("Invalid launcher app update endpoint URL: {e}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("target", &current_launcher_update_target());
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
        .map_err(|e| format!("Launcher app update request failed: {e}"))?;
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
    let client = build_blocking_http_client()?;
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
        .map_err(|e| format!("Launcher app update channels request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read launcher app update channels response: {e}"))?;
    parse_api_envelope(status, &text, "launcher app update channels")
}

fn download_launcher_app_update_blocking(
    app: &tauri::AppHandle,
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

    let client = build_blocking_http_client()?;
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
    download_file_quiet_blocking(&client, &normalized_download_url, &target_path)
        .map_err(|e| format!("Failed to download launcher installer: {e}"))?;

    if let Some(expected_checksum) = checksum
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
    {
        verify_file_sha256(&target_path, &expected_checksum)
            .map_err(|e| format!("Launcher installer checksum mismatch: {e}"))?;
    }

    Ok(DownloadedLauncherUpdate {
        version: normalized_version,
        file_name,
        file_path: target_path.to_string_lossy().to_string(),
    })
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
    let types: Vec<String> = if let Some(input) = version_type {
        let item = input.trim().to_uppercase();
        if item.is_empty() {
            vec!["EDGE".to_string(), "NOVA".to_string()]
        } else {
            vec![item]
        }
    } else {
        vec!["EDGE".to_string(), "NOVA".to_string()]
    };

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut merged = Vec::new();
    for version_type_item in types {
        let mut url = reqwest::Url::parse(&format!(
            "{normalized_base}/api/v1/launcher/versions/available"
        ))
        .map_err(|e| format!("Invalid versions endpoint URL: {e}"))?;
        url.query_pairs_mut()
            .append_pair("versionType", &version_type_item);
        let response = client
            .get(url)
            .bearer_auth(&normalized_token)
            .send()
            .map_err(|e| format!("Versions request failed: {e}"))?;
        let status = response.status();
        let text = response
            .text()
            .map_err(|e| format!("Failed to read versions response: {e}"))?;
        let mut items = parse_launcher_versions_response(status, &text)?;
        merged.append(&mut items);
    }
    Ok(merged)
}

#[tauri::command]
async fn modrinth_search_projects(
    query: String,
    project_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ModrinthSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        modrinth_search_projects_blocking(query, project_type, game_version, loader, limit)
    })
    .await
    .map_err(|e| format!("Failed to join Modrinth search task: {e}"))?
}

#[tauri::command]
async fn install_modrinth_project(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    project_id: String,
    project_title: String,
    project_type: String,
    game_version: String,
    loader: Option<String>,
) -> Result<ModrinthInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_modrinth_project_blocking(
            Some(window),
            game_dir,
            version_id,
            project_id,
            project_title,
            project_type,
            game_version,
            loader,
        )
    })
    .await
    .map_err(|e| format!("Failed to join Modrinth install task: {e}"))?
}

#[tauri::command]
async fn curseforge_search_projects(
    query: String,
    project_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    limit: Option<u32>,
    api_key: String,
) -> Result<Vec<ModrinthSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        curseforge_search_projects_blocking(
            query,
            project_type,
            game_version,
            loader,
            limit,
            api_key,
        )
    })
    .await
    .map_err(|e| format!("Failed to join CurseForge search task: {e}"))?
}

#[tauri::command]
async fn install_curseforge_project(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    project_id: String,
    project_title: String,
    project_type: String,
    game_version: String,
    loader: Option<String>,
    api_key: String,
) -> Result<ModrinthInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_curseforge_project_blocking(
            Some(window),
            game_dir,
            version_id,
            project_id,
            project_title,
            project_type,
            game_version,
            loader,
            api_key,
        )
    })
    .await
    .map_err(|e| format!("Failed to join CurseForge install task: {e}"))?
}

#[tauri::command]
async fn list_installed_content(
    game_dir: String,
    version_id: String,
) -> Result<Vec<InstalledContentItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_installed_content_blocking(game_dir, version_id)
    })
    .await
    .map_err(|e| format!("Failed to join installed content task: {e}"))?
}

#[tauri::command]
async fn uninstall_installed_content(
    game_dir: String,
    version_id: String,
    source: String,
    project_id: String,
    content_type: String,
) -> Result<InstalledContentItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uninstall_installed_content_blocking(game_dir, version_id, source, project_id, content_type)
    })
    .await
    .map_err(|e| format!("Failed to join uninstall content task: {e}"))?
}

#[tauri::command]
async fn check_installed_content_updates(
    game_dir: String,
    version_id: String,
    game_version: String,
    loader: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<InstalledContentUpdate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_installed_content_updates_blocking(
            game_dir,
            version_id,
            game_version,
            loader,
            api_key,
        )
    })
    .await
    .map_err(|e| format!("Failed to join content updates task: {e}"))?
}

#[tauri::command]
async fn import_world_archive(
    game_dir: String,
    version_id: String,
    archive_name: String,
    archive_data: Vec<u8>,
    world_name: Option<String>,
) -> Result<WorldInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_world_archive_blocking(game_dir, version_id, archive_name, archive_data, world_name)
    })
    .await
    .map_err(|e| format!("Failed to join world import task: {e}"))?
}

fn modrinth_search_projects_blocking(
    query: String,
    project_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ModrinthSearchResult>, String> {
    let normalized_query = query.trim().to_string();
    let normalized_project_type = normalize_content_project_type(&project_type)?;
    let client = build_blocking_http_client()?;
    let mut url = reqwest::Url::parse("https://api.modrinth.com/v2/search")
        .map_err(|e| format!("Invalid Modrinth search endpoint URL: {e}"))?;
    let facets = build_modrinth_search_facets(
        &normalized_project_type,
        game_version.as_deref(),
        loader.as_deref(),
    )?;

    url.query_pairs_mut()
        .append_pair("limit", &limit.unwrap_or(18).clamp(1, 50).to_string())
        .append_pair("index", "downloads")
        .append_pair("facets", &facets);
    if !normalized_query.is_empty() {
        url.query_pairs_mut()
            .append_pair("query", &normalized_query);
    }

    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Modrinth search request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Modrinth search response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Modrinth search failed with HTTP {}: {}",
            status.as_u16(),
            text.trim()
        ));
    }

    let payload = serde_json::from_str::<ModrinthSearchResponse>(&text)
        .map_err(|e| format!("Invalid Modrinth search response JSON: {e}"))?;
    Ok(payload
        .hits
        .into_iter()
        .filter(|item| item.project_type == normalized_project_type)
        .map(map_modrinth_search_hit)
        .collect())
}

fn install_modrinth_project_blocking(
    window: Option<tauri::Window>,
    game_dir: String,
    version_id: String,
    project_id: String,
    project_title: String,
    project_type: String,
    game_version: String,
    loader: Option<String>,
) -> Result<ModrinthInstallResult, String> {
    let normalized_project_type = normalize_content_project_type(&project_type)?;
    let normalized_project_id = project_id.trim().to_string();
    if normalized_project_id.is_empty() {
        return Err("Modrinth project id cannot be empty".to_string());
    }
    let normalized_version_id = version_id.trim().to_string();
    if normalized_version_id.is_empty() {
        return Err("Version id cannot be empty".to_string());
    }
    let normalized_game_version = game_version.trim().to_string();
    if normalized_game_version.is_empty() {
        return Err("Game version cannot be empty".to_string());
    }
    let project_key = format!(
        "modrinth:{}:{}",
        normalized_project_type, normalized_project_id
    );

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let runtime_root = resolve_version_runtime_dir(&game_dir_path, &normalized_version_id)?;
    let existing_item = find_installed_content_item(
        &runtime_root,
        "modrinth",
        &normalized_project_id,
        &normalized_project_type,
    )?;
    let client = build_blocking_http_client()?;
    let versions = fetch_modrinth_project_versions(
        &client,
        &normalized_project_id,
        &normalized_project_type,
        &normalized_game_version,
        loader.as_deref(),
    )?;
    let version = choose_best_modrinth_version(versions)?;
    let file = choose_modrinth_version_file(&version)?;

    let download_path = env::temp_dir().join(format!(
        "fpsmaster-content-{}-{}-{}",
        std::process::id(),
        now_epoch_millis(),
        sanitize_file_name(&file.filename)
    ));
    download_file_quiet_with_progress_blocking(
        &client,
        &file.url,
        &download_path,
        window.as_ref(),
        Some(&project_key),
    )
    .map_err(|err| format!("Failed to download Modrinth file {}: {err}", file.filename))?;

    if let Some(expected_size) = file.size {
        let actual_size = fs::metadata(&download_path)
            .map_err(|e| format!("Failed to inspect downloaded Modrinth file: {e}"))?
            .len();
        if actual_size != expected_size {
            let _ = fs::remove_file(&download_path);
            return Err(format!(
                "Modrinth file size mismatch: expected {}, got {}",
                expected_size, actual_size
            ));
        }
    }
    if let Some(expected_sha512) = file.hashes.get("sha512") {
        if let Err(err) = verify_file_sha512(&download_path, expected_sha512) {
            let _ = fs::remove_file(&download_path);
            return Err(format!("Modrinth checksum mismatch: {err}"));
        }
    }

    let resolved_version_number = if version.version_number.trim().is_empty() {
        version.name.clone()
    } else {
        version.version_number.clone()
    };
    if normalized_project_type == "world" {
        let archive_bytes = fs::read(&download_path).map_err(|e| {
            format!(
                "Failed to read downloaded Modrinth world archive {}: {e}",
                download_path.display()
            )
        })?;
        let _ = fs::remove_file(&download_path);
        let world_result = install_world_archive_with_metadata(
            game_dir.clone(),
            normalized_version_id.clone(),
            file.filename.clone(),
            archive_bytes,
            Some(project_title.trim().to_string()),
            "modrinth".to_string(),
            Some(normalized_project_id.clone()),
            Some(project_title.trim().to_string()),
            Some((version.id.clone(), resolved_version_number.clone())),
        )?;
        return Ok(ModrinthInstallResult {
            source: "modrinth".to_string(),
            project_id: normalized_project_id,
            project_title: project_title.trim().to_string(),
            content_type: normalized_project_type,
            version_id: version.id,
            version_number: resolved_version_number,
            file_name: file.filename,
            target_dir: Path::new(&world_result.installed_path)
                .parent()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|| runtime_root.to_string_lossy().to_string()),
            installed_path: world_result.installed_path,
            changelog: version.changelog,
        });
    }

    let next_target_path =
        build_content_target_path(&runtime_root, &normalized_project_type, &file.filename)?;
    if let Some(existing) = existing_item.as_ref() {
        let same_target = resolve_managed_content_path(&runtime_root, &existing.installed_path)?
            .map(|path| path == next_target_path)
            .unwrap_or(false);
        if !same_target {
            remove_content_install_path(&runtime_root, &existing.installed_path)?;
        }
    }

    let installed_path = install_content_file_by_type(
        &download_path,
        &runtime_root,
        &normalized_project_type,
        &file.filename,
    )?;
    let _ = fs::remove_file(&download_path);

    upsert_installed_content_item(
        &runtime_root,
        InstalledContentItem {
            source: "modrinth".to_string(),
            project_id: normalized_project_id.clone(),
            project_title: project_title.trim().to_string(),
            content_type: normalized_project_type.clone(),
            version_id: version.id.clone(),
            version_number: resolved_version_number.clone(),
            file_name: file.filename.clone(),
            installed_path: installed_path.to_string_lossy().to_string(),
            installed_at_epoch_sec: now_epoch_seconds(),
        },
    )?;

    Ok(ModrinthInstallResult {
        source: "modrinth".to_string(),
        project_id: normalized_project_id,
        project_title: project_title.trim().to_string(),
        content_type: normalized_project_type,
        version_id: version.id,
        version_number: resolved_version_number,
        file_name: file.filename,
        target_dir: installed_path
            .parent()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| runtime_root.to_string_lossy().to_string()),
        installed_path: installed_path.to_string_lossy().to_string(),
        changelog: version.changelog,
    })
}

fn curseforge_search_projects_blocking(
    query: String,
    project_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    limit: Option<u32>,
    api_key: String,
) -> Result<Vec<ModrinthSearchResult>, String> {
    let normalized_query = query.trim().to_string();
    let normalized_project_type = normalize_content_project_type(&project_type)?;
    let normalized_api_key = normalize_curseforge_api_key(&api_key)?;
    let client = build_blocking_http_client()?;
    let class_id = curseforge_class_id_for_project_type(&normalized_project_type)?;
    let mut url = reqwest::Url::parse("https://api.curseforge.com/v1/mods/search")
        .map_err(|e| format!("Invalid CurseForge search endpoint URL: {e}"))?;
    {
        let mut query_pairs = url.query_pairs_mut();
        query_pairs.append_pair("gameId", "432");
        query_pairs.append_pair("classId", &class_id.to_string());
        query_pairs.append_pair("sortField", "2");
        query_pairs.append_pair("sortOrder", "desc");
        query_pairs.append_pair("pageSize", &limit.unwrap_or(18).clamp(1, 50).to_string());
        if !normalized_query.is_empty() {
            query_pairs.append_pair("searchFilter", &normalized_query);
        }
        if let Some(version) = game_version
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query_pairs.append_pair("gameVersion", version);
        }
        if normalized_project_type == "mod" {
            if let Some(mod_loader_type) = curseforge_mod_loader_type(loader.as_deref()) {
                query_pairs.append_pair("modLoaderType", &mod_loader_type.to_string());
            }
        }
    }

    let response = client
        .get(url)
        .header("x-api-key", normalized_api_key)
        .send()
        .map_err(|e| format!("CurseForge search request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read CurseForge search response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "CurseForge search failed with HTTP {}: {}",
            status.as_u16(),
            text.trim()
        ));
    }

    let payload = serde_json::from_str::<CurseForgeEnvelope<Vec<CurseForgeSearchItem>>>(&text)
        .map_err(|e| format!("Invalid CurseForge search response JSON: {e}"))?;
    Ok(payload
        .data
        .into_iter()
        .map(|item| map_curseforge_search_item(item, &normalized_project_type))
        .collect())
}

fn install_curseforge_project_blocking(
    window: Option<tauri::Window>,
    game_dir: String,
    version_id: String,
    project_id: String,
    project_title: String,
    project_type: String,
    game_version: String,
    loader: Option<String>,
    api_key: String,
) -> Result<ModrinthInstallResult, String> {
    let normalized_project_type = normalize_content_project_type(&project_type)?;
    let normalized_api_key = normalize_curseforge_api_key(&api_key)?;
    let normalized_project_id = project_id.trim().to_string();
    if normalized_project_id.is_empty() {
        return Err("CurseForge project id cannot be empty".to_string());
    }
    let normalized_version_id = version_id.trim().to_string();
    if normalized_version_id.is_empty() {
        return Err("Version id cannot be empty".to_string());
    }
    let normalized_game_version = game_version.trim().to_string();
    if normalized_game_version.is_empty() {
        return Err("Game version cannot be empty".to_string());
    }
    let project_key = format!(
        "curseforge:{}:{}",
        normalized_project_type, normalized_project_id
    );

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let runtime_root = resolve_version_runtime_dir(&game_dir_path, &normalized_version_id)?;
    let existing_item = find_installed_content_item(
        &runtime_root,
        "curseforge",
        &normalized_project_id,
        &normalized_project_type,
    )?;
    let client = build_blocking_http_client()?;
    let files = fetch_curseforge_project_files(
        &client,
        &normalized_api_key,
        &normalized_project_id,
        &normalized_project_type,
        &normalized_game_version,
        loader.as_deref(),
    )?;
    let file = choose_best_curseforge_file(files)?;
    let download_url = match file
        .download_url
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => fetch_curseforge_file_download_url(
            &client,
            &normalized_api_key,
            &normalized_project_id,
            file.id,
        )?,
    };

    let download_path = env::temp_dir().join(format!(
        "fpsmaster-content-{}-{}-{}",
        std::process::id(),
        now_epoch_millis(),
        sanitize_file_name(&file.file_name)
    ));
    download_file_quiet_with_progress_blocking(
        &client,
        &download_url,
        &download_path,
        window.as_ref(),
        Some(&project_key),
    )
    .map_err(|err| {
        format!(
            "Failed to download CurseForge file {}: {err}",
            file.file_name
        )
    })?;

    let version_label = resolve_curseforge_version_label(&file);
    if normalized_project_type == "world" {
        let archive_bytes = fs::read(&download_path).map_err(|e| {
            format!(
                "Failed to read downloaded CurseForge world archive {}: {e}",
                download_path.display()
            )
        })?;
        let _ = fs::remove_file(&download_path);
        let world_result = install_world_archive_with_metadata(
            game_dir.clone(),
            normalized_version_id.clone(),
            file.file_name.clone(),
            archive_bytes,
            Some(project_title.trim().to_string()),
            "curseforge".to_string(),
            Some(normalized_project_id.clone()),
            Some(project_title.trim().to_string()),
            Some((file.id.to_string(), version_label.clone())),
        )?;
        return Ok(ModrinthInstallResult {
            source: "curseforge".to_string(),
            project_id: normalized_project_id,
            project_title: project_title.trim().to_string(),
            content_type: normalized_project_type,
            version_id: file.id.to_string(),
            version_number: version_label,
            file_name: file.file_name,
            target_dir: Path::new(&world_result.installed_path)
                .parent()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|| runtime_root.to_string_lossy().to_string()),
            installed_path: world_result.installed_path,
            changelog: None,
        });
    }

    let next_target_path =
        build_content_target_path(&runtime_root, &normalized_project_type, &file.file_name)?;
    if let Some(existing) = existing_item.as_ref() {
        let same_target = resolve_managed_content_path(&runtime_root, &existing.installed_path)?
            .map(|path| path == next_target_path)
            .unwrap_or(false);
        if !same_target {
            remove_content_install_path(&runtime_root, &existing.installed_path)?;
        }
    }

    let installed_path = install_content_file_by_type(
        &download_path,
        &runtime_root,
        &normalized_project_type,
        &file.file_name,
    )?;
    let _ = fs::remove_file(&download_path);

    upsert_installed_content_item(
        &runtime_root,
        InstalledContentItem {
            source: "curseforge".to_string(),
            project_id: normalized_project_id.clone(),
            project_title: project_title.trim().to_string(),
            content_type: normalized_project_type.clone(),
            version_id: file.id.to_string(),
            version_number: version_label.clone(),
            file_name: file.file_name.clone(),
            installed_path: installed_path.to_string_lossy().to_string(),
            installed_at_epoch_sec: now_epoch_seconds(),
        },
    )?;

    Ok(ModrinthInstallResult {
        source: "curseforge".to_string(),
        project_id: normalized_project_id,
        project_title: project_title.trim().to_string(),
        content_type: normalized_project_type,
        version_id: file.id.to_string(),
        version_number: version_label,
        file_name: file.file_name,
        target_dir: installed_path
            .parent()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| runtime_root.to_string_lossy().to_string()),
        installed_path: installed_path.to_string_lossy().to_string(),
        changelog: None,
    })
}

fn list_installed_content_blocking(
    game_dir: String,
    version_id: String,
) -> Result<Vec<InstalledContentItem>, String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let runtime_root = resolve_version_runtime_dir(&game_dir_path, version_id.trim())?;
    read_installed_content_index(&runtime_root)
}

fn uninstall_installed_content_blocking(
    game_dir: String,
    version_id: String,
    source: String,
    project_id: String,
    content_type: String,
) -> Result<InstalledContentItem, String> {
    let normalized_source = normalize_content_source(&source)?;
    let normalized_content_type = normalize_content_project_type(&content_type)?;
    let normalized_project_id = project_id.trim().to_string();
    if normalized_project_id.is_empty() {
        return Err("Project id cannot be empty".to_string());
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let runtime_root = resolve_version_runtime_dir(&game_dir_path, version_id.trim())?;
    remove_installed_content_item(
        &runtime_root,
        &normalized_source,
        &normalized_project_id,
        &normalized_content_type,
    )
}

fn check_installed_content_updates_blocking(
    game_dir: String,
    version_id: String,
    game_version: String,
    loader: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<InstalledContentUpdate>, String> {
    let normalized_game_version = game_version.trim().to_string();
    if normalized_game_version.is_empty() {
        return Err("Game version cannot be empty".to_string());
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let runtime_root = resolve_version_runtime_dir(&game_dir_path, version_id.trim())?;
    let items = read_installed_content_index(&runtime_root)?;
    if items.is_empty() {
        return Ok(Vec::new());
    }

    let client = build_blocking_http_client()?;
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        results.push(check_single_installed_content_update(
            &client,
            &item,
            &normalized_game_version,
            loader.as_deref(),
            api_key.as_deref(),
        ));
    }
    Ok(results)
}

fn import_world_archive_blocking(
    game_dir: String,
    version_id: String,
    archive_name: String,
    archive_data: Vec<u8>,
    world_name: Option<String>,
) -> Result<WorldInstallResult, String> {
    install_world_archive_with_metadata(
        game_dir,
        version_id,
        archive_name,
        archive_data,
        world_name,
        "local".to_string(),
        None,
        None,
        None,
    )
}

fn install_world_archive_with_metadata(
    game_dir: String,
    version_id: String,
    archive_name: String,
    archive_data: Vec<u8>,
    world_name: Option<String>,
    source: String,
    project_id_override: Option<String>,
    project_title_override: Option<String>,
    version_label_override: Option<(String, String)>,
) -> Result<WorldInstallResult, String> {
    if archive_data.is_empty() {
        return Err("World archive cannot be empty".to_string());
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let runtime_root = resolve_version_runtime_dir(&game_dir_path, version_id.trim())?;
    let saves_dir = runtime_root.join("saves");
    fs::create_dir_all(&saves_dir).map_err(|e| {
        format!(
            "Failed to create saves directory {}: {e}",
            saves_dir.display()
        )
    })?;

    let resolved_world_name = resolve_world_name(world_name.as_deref(), &archive_name)?;
    let stage_root = env::temp_dir().join(format!(
        ".fpsmaster-world-stage-{}-{}",
        std::process::id(),
        now_epoch_millis()
    ));
    if stage_root.exists() {
        fs::remove_dir_all(&stage_root).map_err(|e| {
            format!(
                "Failed to reset world staging directory {}: {e}",
                stage_root.display()
            )
        })?;
    }
    fs::create_dir_all(&stage_root).map_err(|e| {
        format!(
            "Failed to create world staging directory {}: {e}",
            stage_root.display()
        )
    })?;

    let extracted_entries = extract_world_archive_to_stage(&archive_data, &stage_root)?;
    if extracted_entries == 0 {
        let _ = fs::remove_dir_all(&stage_root);
        return Err("World archive does not contain importable files".to_string());
    }

    let extracted_root = determine_world_stage_root(&stage_root)?;
    if !extracted_root.join("level.dat").exists() {
        let _ = fs::remove_dir_all(&stage_root);
        return Err("World archive is missing level.dat at the save root".to_string());
    }

    let target_world_dir = saves_dir.join(&resolved_world_name);
    if target_world_dir.exists() {
        fs::remove_dir_all(&target_world_dir).map_err(|e| {
            format!(
                "Failed to replace existing world {}: {e}",
                target_world_dir.display()
            )
        })?;
    }

    move_or_copy_directory(&extracted_root, &target_world_dir)?;
    let _ = fs::remove_dir_all(&stage_root);

    let installed_at_epoch_sec = now_epoch_seconds();
    let project_title = project_title_override.unwrap_or_else(|| resolved_world_name.clone());
    let project_id = project_id_override
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("local-world-{}", slugify_content_key(&resolved_world_name)));
    let (resolved_version_id, resolved_version_number) = version_label_override
        .filter(|(version_id, _)| !version_id.trim().is_empty())
        .unwrap_or_else(|| {
            (
                format!("local-{}", installed_at_epoch_sec),
                "Imported".to_string(),
            )
        });
    let file_name = sanitize_file_name(&archive_name);
    upsert_installed_content_item(
        &runtime_root,
        InstalledContentItem {
            source: source.clone(),
            project_id: project_id.clone(),
            project_title: project_title.clone(),
            content_type: "world".to_string(),
            version_id: resolved_version_id,
            version_number: resolved_version_number,
            file_name: file_name.clone(),
            installed_path: target_world_dir.to_string_lossy().to_string(),
            installed_at_epoch_sec,
        },
    )?;

    Ok(WorldInstallResult {
        source,
        project_id,
        project_title,
        content_type: "world".to_string(),
        file_name,
        installed_path: target_world_dir.to_string_lossy().to_string(),
        installed_at_epoch_sec,
    })
}

#[tauri::command]
async fn install_launcher_version_mods(
    game_dir: String,
    version_id: String,
    download_url: String,
    version_tag: Option<String>,
    checksum: Option<String>,
    manifest_url: Option<String>,
    clean_existing: Option<bool>,
) -> Result<LauncherModsInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_launcher_version_mods_blocking(
            game_dir,
            version_id,
            download_url,
            version_tag,
            checksum,
            manifest_url,
            clean_existing,
        )
    })
    .await
    .map_err(|e| format!("Failed to join launcher mods install task: {e}"))?
}

#[tauri::command]
async fn get_launcher_package_state(
    game_dir: String,
    version_id: String,
    expected_version_tag: Option<String>,
    expected_checksum: Option<String>,
    expected_manifest_url: Option<String>,
    expected_download_url: Option<String>,
) -> Result<LauncherPackageState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        get_launcher_package_state_blocking(
            game_dir,
            version_id,
            expected_version_tag,
            expected_checksum,
            expected_manifest_url,
            expected_download_url,
        )
    })
    .await
    .map_err(|e| format!("Failed to join launcher package state task: {e}"))?
}

fn install_launcher_version_mods_blocking(
    game_dir: String,
    version_id: String,
    download_url: String,
    version_tag: Option<String>,
    checksum: Option<String>,
    manifest_url: Option<String>,
    clean_existing: Option<bool>,
) -> Result<LauncherModsInstallResult, String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let mods_dir = resolve_version_runtime_dir(&game_dir_path, &version_id)?.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| {
        format!(
            "Failed to create mods directory {}: {e}",
            mods_dir.display()
        )
    })?;

    let normalized_url = download_url.trim().to_string();
    if normalized_url.is_empty() {
        return Err("downloadUrl is empty".to_string());
    }
    let normalized_tag = version_tag
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| normalized_url.clone());
    let normalized_manifest_url = manifest_url
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let marker_path = mods_dir.join(".fpsmaster-launcher-mods.json");
    if is_mods_marker_up_to_date(
        &marker_path,
        &normalized_tag,
        checksum.as_deref(),
        normalized_manifest_url.as_deref(),
        Some(normalized_url.as_str()),
    )? && validate_installed_launcher_package(&mods_dir, &marker_path, None)?
    {
        return Ok(LauncherModsInstallResult {
            target_dir: mods_dir.to_string_lossy().to_string(),
            installed_files: 0,
            skipped: true,
            version_tag: normalized_tag,
            manifest_url: normalized_manifest_url,
        });
    }

    let previous_marker = read_mods_marker(&marker_path)?;
    let installed_files = if let Some(manifest_source) = normalized_manifest_url.as_deref() {
        install_launcher_manifest_package(
            manifest_source,
            &normalized_tag,
            &mods_dir,
            previous_marker.as_ref(),
            clean_existing.unwrap_or(false),
        )?
    } else {
        let download_file_name = infer_download_file_name(&normalized_url, &normalized_tag);
        let temp_download_path = env::temp_dir().join(format!(
            "fpsmaster-launcher-mods-{}-{}-{}",
            std::process::id(),
            now_epoch_millis(),
            download_file_name
        ));
        let download_result =
            download_file_blocking(None, "launcher-mods", &normalized_url, &temp_download_path);
        if let Err(err) = download_result {
            let _ = fs::remove_file(&temp_download_path);
            return Err(format!("Failed to download launcher package: {err}"));
        }
        if let Some(expected_checksum) = checksum.as_deref() {
            if let Err(err) = verify_file_sha256(&temp_download_path, expected_checksum) {
                let _ = fs::remove_file(&temp_download_path);
                return Err(format!("Launcher package checksum mismatch: {err}"));
            }
        }

        let stage_dir = create_launcher_mods_stage_dir(&mods_dir)?;
        let stage_result =
            stage_launcher_download_package(&temp_download_path, &download_file_name, &stage_dir);
        let _ = fs::remove_file(&temp_download_path);
        let installed_files = match stage_result {
            Ok(files) => files,
            Err(err) => {
                let _ = fs::remove_dir_all(&stage_dir);
                return Err(err);
            }
        };

        if let Err(err) = apply_staged_launcher_package(
            &mods_dir,
            &stage_dir,
            previous_marker.as_ref(),
            &installed_files,
            clean_existing.unwrap_or(false),
        ) {
            let _ = fs::remove_dir_all(&stage_dir);
            return Err(err);
        }
        installed_files
    };

    let marker = LauncherModsInstallMarker {
        version_tag: normalized_tag.clone(),
        checksum: checksum
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        manifest_url: normalized_manifest_url,
        download_url: normalized_url,
        files: installed_files.clone(),
        installed_at_epoch_sec: now_epoch_seconds(),
    };
    let marker_content = serde_json::to_string_pretty(&marker)
        .map_err(|e| format!("Failed to serialize mods marker: {e}"))?;
    fs::write(&marker_path, format!("{marker_content}\n")).map_err(|e| {
        format!(
            "Failed to write mods marker {}: {e}",
            marker_path.to_string_lossy()
        )
    })?;

    Ok(LauncherModsInstallResult {
        target_dir: mods_dir.to_string_lossy().to_string(),
        installed_files: installed_files.len(),
        skipped: false,
        version_tag: normalized_tag,
        manifest_url: marker.manifest_url.clone(),
    })
}

fn get_launcher_package_state_blocking(
    game_dir: String,
    version_id: String,
    expected_version_tag: Option<String>,
    expected_checksum: Option<String>,
    expected_manifest_url: Option<String>,
    expected_download_url: Option<String>,
) -> Result<LauncherPackageState, String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let mods_dir = resolve_version_runtime_dir(&game_dir_path, &version_id)?.join("mods");
    let marker_path = mods_dir.join(".fpsmaster-launcher-mods.json");
    let marker = read_mods_marker(&marker_path)?;
    let version_tag = marker.as_ref().map(|value| value.version_tag.clone());
    let checksum = marker.as_ref().and_then(|value| value.checksum.clone());
    let manifest_url = marker.as_ref().and_then(|value| value.manifest_url.clone());
    let installed = version_tag.is_some()
        && validate_installed_launcher_package(&mods_dir, &marker_path, marker.as_ref())?;
    let up_to_date = match (marker.as_ref(), expected_version_tag.as_ref()) {
        (Some(installed_marker), Some(expected_tag)) => {
            let version_matches = installed_marker.version_tag.trim() == expected_tag.trim();
            let checksum_matches = match (
                installed_marker.checksum.as_deref(),
                expected_checksum.as_deref(),
            ) {
                (Some(installed_checksum), Some(expected_checksum_value)) => {
                    installed_checksum.trim() == expected_checksum_value.trim()
                }
                (_, None) => true,
                _ => false,
            };
            let manifest_matches = match (
                installed_marker.manifest_url.as_deref(),
                expected_manifest_url.as_deref(),
            ) {
                (Some(installed_manifest), Some(expected_manifest)) => {
                    installed_manifest.trim() == expected_manifest.trim()
                }
                (_, None) => true,
                _ => false,
            };
            let url_matches = match expected_download_url.as_deref() {
                Some(expected_url) => installed_marker.download_url.trim() == expected_url.trim(),
                None => true,
            };
            version_matches && checksum_matches && manifest_matches && url_matches
        }
        (Some(_), None) => true,
        _ => false,
    };
    Ok(LauncherPackageState {
        installed,
        up_to_date: installed && up_to_date,
        version_tag,
        checksum,
        manifest_url,
    })
}

fn install_launcher_manifest_package(
    manifest_url: &str,
    expected_version_tag: &str,
    mods_dir: &Path,
    previous_marker: Option<&LauncherModsInstallMarker>,
    clean_existing: bool,
) -> Result<Vec<LauncherInstalledFileRecord>, String> {
    let manifest = fetch_launcher_package_manifest(manifest_url)?;
    if let Some(manifest_version_tag) = manifest
        .version_tag
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if manifest_version_tag != expected_version_tag.trim() {
            return Err(format!(
                "Launcher manifest version mismatch: expected {}, got {}",
                expected_version_tag.trim(),
                manifest_version_tag
            ));
        }
    }
    if manifest.files.is_empty() {
        return Err("Launcher manifest does not contain any files".to_string());
    }

    let stage_dir = create_launcher_mods_stage_dir(mods_dir)?;
    let install_result = install_manifest_files_into_stage(manifest_url, &manifest, &stage_dir);
    if let Err(err) = install_result {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(err);
    }
    let installed_files = install_result?;

    if let Err(err) = apply_staged_launcher_package(
        mods_dir,
        &stage_dir,
        previous_marker,
        &installed_files,
        clean_existing,
    ) {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(err);
    }

    Ok(installed_files)
}

fn create_launcher_mods_stage_dir(mods_dir: &Path) -> Result<PathBuf, String> {
    let runtime_dir = mods_dir
        .parent()
        .ok_or_else(|| format!("Invalid mods directory: {}", mods_dir.display()))?;
    let stage_dir = runtime_dir.join(format!(
        ".fpsmaster-launcher-mods-stage-{}-{}",
        std::process::id(),
        now_epoch_millis()
    ));
    if stage_dir.exists() {
        fs::remove_dir_all(&stage_dir).map_err(|e| {
            format!(
                "Failed to reset stage directory {}: {e}",
                stage_dir.display()
            )
        })?;
    }
    fs::create_dir_all(&stage_dir).map_err(|e| {
        format!(
            "Failed to create stage directory {}: {e}",
            stage_dir.display()
        )
    })?;
    Ok(stage_dir)
}

fn stage_launcher_download_package(
    archive_path: &Path,
    download_file_name: &str,
    stage_dir: &Path,
) -> Result<Vec<LauncherInstalledFileRecord>, String> {
    if is_jar_file_name(download_file_name) {
        let relative_path = PathBuf::from(download_file_name);
        let target_path = stage_dir.join(&relative_path);
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create launcher stage directory {}: {e}",
                    parent.display()
                )
            })?;
        }
        fs::copy(archive_path, &target_path).map_err(|e| {
            format!(
                "Failed to stage launcher mod {}: {e}",
                target_path.to_string_lossy()
            )
        })?;
        return Ok(vec![build_launcher_installed_file_record(
            &target_path,
            &relative_path,
        )?]);
    }

    extract_launcher_mod_archive(archive_path, stage_dir)
}

fn apply_staged_launcher_package(
    mods_dir: &Path,
    stage_dir: &Path,
    previous_marker: Option<&LauncherModsInstallMarker>,
    installed_files: &[LauncherInstalledFileRecord],
    clean_existing: bool,
) -> Result<(), String> {
    if clean_existing {
        return replace_directory_with_stage(mods_dir, stage_dir);
    }

    fs::create_dir_all(mods_dir).map_err(|e| {
        format!(
            "Failed to create mods directory {}: {e}",
            mods_dir.display()
        )
    })?;
    copy_directory_contents(stage_dir, mods_dir)?;
    remove_stale_launcher_managed_files(mods_dir, previous_marker, installed_files)?;
    let _ = fs::remove_dir_all(stage_dir);
    Ok(())
}

fn remove_stale_launcher_managed_files(
    mods_dir: &Path,
    previous_marker: Option<&LauncherModsInstallMarker>,
    installed_files: &[LauncherInstalledFileRecord],
) -> Result<(), String> {
    let Some(marker) = previous_marker else {
        return Ok(());
    };
    if marker.files.is_empty() {
        return Ok(());
    }

    let retained_paths: HashSet<PathBuf> = installed_files
        .iter()
        .map(|file| normalize_manifest_relative_path(&file.path))
        .collect::<Result<HashSet<_>, _>>()?;

    for file in &marker.files {
        let relative_path = normalize_manifest_relative_path(&file.path)?;
        if retained_paths.contains(&relative_path) {
            continue;
        }
        remove_launcher_managed_path(mods_dir, &relative_path)?;
    }
    Ok(())
}

fn remove_launcher_managed_path(mods_dir: &Path, relative_path: &Path) -> Result<(), String> {
    let target_path = mods_dir.join(relative_path);
    if !target_path.exists() {
        return Ok(());
    }

    if target_path.is_dir() {
        fs::remove_dir_all(&target_path).map_err(|e| {
            format!(
                "Failed to remove launcher managed directory {}: {e}",
                target_path.display()
            )
        })?;
    } else {
        fs::remove_file(&target_path).map_err(|e| {
            format!(
                "Failed to remove launcher managed file {}: {e}",
                target_path.display()
            )
        })?;
    }

    prune_empty_launcher_parent_dirs(mods_dir, relative_path)?;
    Ok(())
}

fn prune_empty_launcher_parent_dirs(mods_dir: &Path, relative_path: &Path) -> Result<(), String> {
    let Some(mut current_dir) = relative_path.parent().map(|path| mods_dir.join(path)) else {
        return Ok(());
    };
    while current_dir.starts_with(mods_dir) && current_dir != mods_dir {
        let mut entries = fs::read_dir(&current_dir).map_err(|e| {
            format!(
                "Failed to inspect launcher managed directory {}: {e}",
                current_dir.display()
            )
        })?;
        if entries
            .next()
            .transpose()
            .map_err(|e| e.to_string())?
            .is_some()
        {
            break;
        }
        fs::remove_dir(&current_dir).map_err(|e| {
            format!(
                "Failed to remove empty launcher directory {}: {e}",
                current_dir.display()
            )
        })?;
        let Some(parent) = current_dir.parent() else {
            break;
        };
        current_dir = parent.to_path_buf();
    }
    Ok(())
}

fn install_manifest_files_into_stage(
    manifest_url: &str,
    manifest: &LauncherPackageManifest,
    stage_dir: &Path,
) -> Result<Vec<LauncherInstalledFileRecord>, String> {
    let client = build_blocking_http_client()?;
    let base_url = resolve_manifest_base_url(manifest_url, manifest.base_url.as_deref())?;
    let mut installed_files = Vec::new();

    for entry in &manifest.files {
        let relative_path = normalize_manifest_relative_path(&entry.path)?;
        let resolved_url = resolve_manifest_file_url(&base_url, entry)?;
        let target_path = stage_dir.join(&relative_path);
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create manifest target directory {}: {e}",
                    parent.display()
                )
            })?;
        }

        download_file_quiet_blocking(&client, &resolved_url, &target_path).map_err(|err| {
            format!(
                "Failed to download manifest file {} from {}: {err}",
                relative_path.display(),
                resolved_url
            )
        })?;

        if let Some(expected_size) = entry.size {
            let actual_size = fs::metadata(&target_path)
                .map_err(|e| {
                    format!(
                        "Failed to inspect downloaded file {}: {e}",
                        target_path.display()
                    )
                })?
                .len();
            if actual_size != expected_size {
                return Err(format!(
                    "Manifest file size mismatch for {}: expected {}, got {}",
                    relative_path.display(),
                    expected_size,
                    actual_size
                ));
            }
        }
        if let Some(expected_sha256) = entry.sha256.as_deref() {
            verify_file_sha256(&target_path, expected_sha256).map_err(|err| {
                format!(
                    "Manifest file checksum mismatch for {}: {err}",
                    relative_path.display()
                )
            })?;
        }

        installed_files.push(build_launcher_installed_file_record(
            &target_path,
            &relative_path,
        )?);
    }

    if installed_files.is_empty() {
        return Err("Launcher manifest does not contain any downloadable files".to_string());
    }
    Ok(installed_files)
}

fn fetch_launcher_package_manifest(manifest_url: &str) -> Result<LauncherPackageManifest, String> {
    let client = build_blocking_http_client()?;
    let body = http_get_text_quiet_blocking(&client, manifest_url)?;

    if let Ok(manifest) = serde_json::from_str::<LauncherPackageManifest>(&body) {
        return Ok(manifest);
    }

    parse_api_envelope::<LauncherPackageManifest>(
        reqwest::StatusCode::OK,
        &body,
        "launcher manifest",
    )
    .map_err(|err| format!("Invalid launcher manifest JSON: {err}"))
}

fn build_blocking_http_client() -> Result<reqwest::blocking::Client, String> {
    const LAUNCHER_HTTP_USER_AGENT: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FPSMasterLauncher (+https://github.com/fpsmasterteam)";

    reqwest::blocking::Client::builder()
        .user_agent(LAUNCHER_HTTP_USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(60 * 30))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())
}

fn http_get_text_quiet_blocking(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Result<String, String> {
    let mut last_error = String::new();
    for attempt in 1..=3 {
        let response = client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send();

        let response = match response {
            Ok(value) => value,
            Err(err) => {
                last_error = format!("request failed on attempt {attempt}/3: {err}");
                continue;
            }
        };

        if !response.status().is_success() {
            last_error = format!("HTTP {}", response.status());
            continue;
        }

        return response
            .text()
            .map_err(|e| format!("Failed to read response body from {url}: {e}"));
    }
    Err(last_error)
}

fn normalize_content_project_type(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "mod" => Ok("mod".to_string()),
        "resourcepack" => Ok("resourcepack".to_string()),
        "shader" => Ok("shader".to_string()),
        "world" => Ok("world".to_string()),
        other => Err(format!(
            "Unsupported content project type '{other}'. Expected mod/resourcepack/shader/world"
        )),
    }
}

fn normalize_content_source(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "modrinth" => Ok("modrinth".to_string()),
        "curseforge" => Ok("curseforge".to_string()),
        "local" => Ok("local".to_string()),
        other => Err(format!(
            "Unsupported content source '{other}'. Expected modrinth/curseforge/local"
        )),
    }
}

fn build_modrinth_search_facets(
    project_type: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
) -> Result<String, String> {
    let mut facets = vec![vec![format!("project_type:{project_type}")]];

    if let Some(version) = game_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        facets.push(vec![format!("versions:{version}")]);
    }

    if project_type == "mod" {
        if let Some(loader_value) = loader.map(str::trim).filter(|value| !value.is_empty()) {
            facets.push(vec![format!(
                "categories:{}",
                loader_value.to_ascii_lowercase()
            )]);
        }
    }

    serde_json::to_string(&facets).map_err(|e| format!("Failed to serialize Modrinth facets: {e}"))
}

fn map_modrinth_search_hit(item: ModrinthSearchHit) -> ModrinthSearchResult {
    let latest_game_version = item.versions.first().cloned();
    ModrinthSearchResult {
        source: "modrinth".to_string(),
        project_id: item.project_id,
        slug: item.slug,
        title: item.title,
        description: item.description,
        author: item.author,
        icon_url: item.icon_url,
        downloads: item.downloads,
        categories: item.categories,
        display_categories: item.display_categories,
        project_type: item.project_type,
        latest_game_version,
        game_versions: item.versions,
        client_side: item.client_side,
        server_side: item.server_side,
    }
}

fn normalize_curseforge_api_key(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        // Built-in CurseForge API key
        Ok("$2a$10$4WrBbsNhZaZsxMjHlq48K.yP.NOT6GYZs.SVD/OBmOJJk229Ffb7m".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

fn curseforge_class_id_for_project_type(project_type: &str) -> Result<u64, String> {
    match project_type {
        "mod" => Ok(6),
        "resourcepack" => Ok(12),
        "world" => Ok(17),
        "shader" => Ok(6552),
        other => Err(format!(
            "Unsupported CurseForge class for content type '{other}'"
        )),
    }
}

fn curseforge_mod_loader_type(loader: Option<&str>) -> Option<u32> {
    match loader
        .map(str::trim)
        .map(|value| value.to_ascii_lowercase())
    {
        Some(value) if value == "forge" => Some(1),
        Some(value) if value == "fabric" => Some(4),
        _ => None,
    }
}

fn map_curseforge_search_item(
    item: CurseForgeSearchItem,
    project_type: &str,
) -> ModrinthSearchResult {
    let authors = item
        .authors
        .iter()
        .map(|author| author.name.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let game_versions = item
        .latest_files_indexes
        .iter()
        .filter_map(|entry| entry.game_version.as_ref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let latest_game_version = game_versions.first().cloned();
    let display_categories = item
        .categories
        .iter()
        .filter(|category| {
            category.class_id != curseforge_class_id_for_project_type(project_type).ok()
        })
        .map(|category| category.name.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();

    ModrinthSearchResult {
        source: "curseforge".to_string(),
        project_id: item.id.to_string(),
        slug: item.slug,
        title: item.name,
        description: item.summary,
        author: if authors.is_empty() {
            "Unknown".to_string()
        } else {
            authors.join(", ")
        },
        icon_url: item.logo.and_then(|logo| logo.url),
        downloads: item.download_count.unwrap_or(0.0).max(0.0) as u64,
        categories: item
            .categories
            .iter()
            .map(|category| category.name.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect(),
        display_categories,
        project_type: project_type.to_string(),
        latest_game_version,
        game_versions,
        client_side: None,
        server_side: None,
    }
}

fn fetch_curseforge_project_files(
    client: &reqwest::blocking::Client,
    api_key: &str,
    project_id: &str,
    project_type: &str,
    game_version: &str,
    loader: Option<&str>,
) -> Result<Vec<CurseForgeFile>, String> {
    let mut url = reqwest::Url::parse(&format!(
        "https://api.curseforge.com/v1/mods/{project_id}/files"
    ))
    .map_err(|e| format!("Invalid CurseForge files endpoint URL: {e}"))?;
    {
        let mut query_pairs = url.query_pairs_mut();
        query_pairs.append_pair("gameVersion", game_version.trim());
        query_pairs.append_pair("pageSize", if project_type == "mod" { "30" } else { "20" });
        if project_type == "mod" {
            if let Some(mod_loader_type) = curseforge_mod_loader_type(loader) {
                query_pairs.append_pair("modLoaderType", &mod_loader_type.to_string());
            }
        }
    }

    let response = client
        .get(url)
        .header("x-api-key", api_key)
        .send()
        .map_err(|e| format!("CurseForge files request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read CurseForge files response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "CurseForge files failed with HTTP {}: {}",
            status.as_u16(),
            text.trim()
        ));
    }

    let payload = serde_json::from_str::<CurseForgeEnvelope<Vec<CurseForgeFile>>>(&text)
        .map_err(|e| format!("Invalid CurseForge files response JSON: {e}"))?;
    Ok(payload.data)
}

fn fetch_curseforge_file_download_url(
    client: &reqwest::blocking::Client,
    api_key: &str,
    project_id: &str,
    file_id: u64,
) -> Result<String, String> {
    let url = reqwest::Url::parse(&format!(
        "https://api.curseforge.com/v1/mods/{project_id}/files/{file_id}/download-url"
    ))
    .map_err(|e| format!("Invalid CurseForge download URL endpoint URL: {e}"))?;

    let response = client
        .get(url)
        .header("x-api-key", api_key)
        .send()
        .map_err(|e| format!("CurseForge download URL request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read CurseForge download URL response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "CurseForge download URL lookup failed with HTTP {}: {}",
            status.as_u16(),
            text.trim()
        ));
    }

    let payload = serde_json::from_str::<CurseForgeEnvelope<String>>(&text)
        .map_err(|e| format!("Invalid CurseForge download URL response JSON: {e}"))?;
    let download_url = payload.data.trim().to_string();
    if download_url.is_empty() {
        return Err("CurseForge download URL response was empty".to_string());
    }
    Ok(download_url)
}

fn choose_best_curseforge_file(mut files: Vec<CurseForgeFile>) -> Result<CurseForgeFile, String> {
    if files.is_empty() {
        return Err("No compatible CurseForge file found for the current instance".to_string());
    }

    files.sort_by(|left, right| {
        let left_rank = curseforge_file_rank(left);
        let right_rank = curseforge_file_rank(right);
        right_rank.cmp(&left_rank)
    });
    files
        .into_iter()
        .next()
        .ok_or_else(|| "No compatible CurseForge file found for the current instance".to_string())
}

fn curseforge_file_rank(item: &CurseForgeFile) -> (u8, String) {
    let release_rank = match item.release_type.unwrap_or(3) {
        1 => 3,
        2 => 2,
        3 => 1,
        _ => 0,
    };
    (release_rank, item.file_date.clone().unwrap_or_default())
}

fn resolve_curseforge_version_label(file: &CurseForgeFile) -> String {
    let display_name = file.display_name.trim();
    if !display_name.is_empty() {
        return display_name.to_string();
    }
    let file_name = file.file_name.trim();
    if !file_name.is_empty() {
        return file_name.to_string();
    }
    format!("File #{}", file.id)
}

fn fetch_modrinth_project_versions(
    client: &reqwest::blocking::Client,
    project_id: &str,
    project_type: &str,
    game_version: &str,
    loader: Option<&str>,
) -> Result<Vec<ModrinthProjectVersion>, String> {
    let mut url = reqwest::Url::parse(&format!(
        "https://api.modrinth.com/v2/project/{project_id}/version"
    ))
    .map_err(|e| format!("Invalid Modrinth versions endpoint URL: {e}"))?;

    {
        let mut query_pairs = url.query_pairs_mut();
        query_pairs.append_pair(
            "game_versions",
            &serde_json::to_string(&vec![game_version.trim()])
                .map_err(|e| format!("Failed to encode Modrinth game_versions: {e}"))?,
        );

        let loader_filters = build_modrinth_loader_filters(project_type, loader);
        if !loader_filters.is_empty() {
            query_pairs.append_pair(
                "loaders",
                &serde_json::to_string(&loader_filters)
                    .map_err(|e| format!("Failed to encode Modrinth loaders: {e}"))?,
            );
        }
    }

    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Modrinth versions request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Modrinth versions response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Modrinth versions failed with HTTP {}: {}",
            status.as_u16(),
            text.trim()
        ));
    }

    serde_json::from_str::<Vec<ModrinthProjectVersion>>(&text)
        .map_err(|e| format!("Invalid Modrinth versions response JSON: {e}"))
}

fn check_single_installed_content_update(
    client: &reqwest::blocking::Client,
    item: &InstalledContentItem,
    game_version: &str,
    loader: Option<&str>,
    api_key: Option<&str>,
) -> InstalledContentUpdate {
    let checked_at_epoch_sec = now_epoch_seconds();
    if item.source.eq_ignore_ascii_case("curseforge") {
        let normalized_api_key = api_key.unwrap_or("").trim();
        if normalized_api_key.is_empty() {
            return InstalledContentUpdate {
                source: item.source.clone(),
                project_id: item.project_id.clone(),
                content_type: item.content_type.clone(),
                status: "unavailable".to_string(),
                update_available: false,
                installed_version_id: item.version_id.clone(),
                installed_version_number: item.version_number.clone(),
                latest_version_id: None,
                latest_version_number: None,
                changelog: None,
                error: Some(
                    "CurseForge API key is not configured in the launcher environment".to_string(),
                ),
                checked_at_epoch_sec,
            };
        }

        let files = match fetch_curseforge_project_files(
            client,
            normalized_api_key,
            &item.project_id,
            &item.content_type,
            game_version,
            loader,
        ) {
            Ok(value) => value,
            Err(err) => {
                return InstalledContentUpdate {
                    source: item.source.clone(),
                    project_id: item.project_id.clone(),
                    content_type: item.content_type.clone(),
                    status: "error".to_string(),
                    update_available: false,
                    installed_version_id: item.version_id.clone(),
                    installed_version_number: item.version_number.clone(),
                    latest_version_id: None,
                    latest_version_number: None,
                    changelog: None,
                    error: Some(err),
                    checked_at_epoch_sec,
                }
            }
        };

        let latest = match choose_best_curseforge_file(files) {
            Ok(value) => value,
            Err(err) => {
                return InstalledContentUpdate {
                    source: item.source.clone(),
                    project_id: item.project_id.clone(),
                    content_type: item.content_type.clone(),
                    status: "unavailable".to_string(),
                    update_available: false,
                    installed_version_id: item.version_id.clone(),
                    installed_version_number: item.version_number.clone(),
                    latest_version_id: None,
                    latest_version_number: None,
                    changelog: None,
                    error: Some(err),
                    checked_at_epoch_sec,
                }
            }
        };

        let latest_version_id = latest.id.to_string();
        let latest_version_number = resolve_curseforge_version_label(&latest);
        let update_available = latest_version_id != item.version_id;

        return InstalledContentUpdate {
            source: item.source.clone(),
            project_id: item.project_id.clone(),
            content_type: item.content_type.clone(),
            status: if update_available {
                "update-available".to_string()
            } else {
                "up-to-date".to_string()
            },
            update_available,
            installed_version_id: item.version_id.clone(),
            installed_version_number: item.version_number.clone(),
            latest_version_id: Some(latest_version_id),
            latest_version_number: Some(latest_version_number),
            changelog: None,
            error: None,
            checked_at_epoch_sec,
        };
    }

    if !item.source.eq_ignore_ascii_case("modrinth") {
        return InstalledContentUpdate {
            source: item.source.clone(),
            project_id: item.project_id.clone(),
            content_type: item.content_type.clone(),
            status: "unavailable".to_string(),
            update_available: false,
            installed_version_id: item.version_id.clone(),
            installed_version_number: item.version_number.clone(),
            latest_version_id: None,
            latest_version_number: None,
            changelog: None,
            error: Some("Unsupported content source".to_string()),
            checked_at_epoch_sec,
        };
    }

    let versions = match fetch_modrinth_project_versions(
        client,
        &item.project_id,
        &item.content_type,
        game_version,
        loader,
    ) {
        Ok(value) => value,
        Err(err) => {
            return InstalledContentUpdate {
                source: item.source.clone(),
                project_id: item.project_id.clone(),
                content_type: item.content_type.clone(),
                status: "error".to_string(),
                update_available: false,
                installed_version_id: item.version_id.clone(),
                installed_version_number: item.version_number.clone(),
                latest_version_id: None,
                latest_version_number: None,
                changelog: None,
                error: Some(err),
                checked_at_epoch_sec,
            }
        }
    };

    let latest = match choose_best_modrinth_version(versions) {
        Ok(value) => value,
        Err(err) => {
            return InstalledContentUpdate {
                source: item.source.clone(),
                project_id: item.project_id.clone(),
                content_type: item.content_type.clone(),
                status: "unavailable".to_string(),
                update_available: false,
                installed_version_id: item.version_id.clone(),
                installed_version_number: item.version_number.clone(),
                latest_version_id: None,
                latest_version_number: None,
                changelog: None,
                error: Some(err),
                checked_at_epoch_sec,
            }
        }
    };

    let latest_version_number = if latest.version_number.trim().is_empty() {
        latest.name.clone()
    } else {
        latest.version_number.clone()
    };
    let update_available = latest.id != item.version_id;

    InstalledContentUpdate {
        source: item.source.clone(),
        project_id: item.project_id.clone(),
        content_type: item.content_type.clone(),
        status: if update_available {
            "update-available".to_string()
        } else {
            "up-to-date".to_string()
        },
        update_available,
        installed_version_id: item.version_id.clone(),
        installed_version_number: item.version_number.clone(),
        latest_version_id: Some(latest.id),
        latest_version_number: Some(latest_version_number),
        changelog: latest.changelog,
        error: None,
        checked_at_epoch_sec,
    }
}

fn build_modrinth_loader_filters(project_type: &str, loader: Option<&str>) -> Vec<String> {
    match project_type {
        "mod" => loader
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| vec![value.to_ascii_lowercase()])
            .unwrap_or_default(),
        "resourcepack" => vec!["minecraft".to_string()],
        _ => Vec::new(),
    }
}

fn choose_best_modrinth_version(
    mut versions: Vec<ModrinthProjectVersion>,
) -> Result<ModrinthProjectVersion, String> {
    if versions.is_empty() {
        return Err("No compatible Modrinth version found for the current instance".to_string());
    }

    versions.sort_by(|left, right| {
        let left_rank = modrinth_version_rank(left);
        let right_rank = modrinth_version_rank(right);
        right_rank.cmp(&left_rank)
    });
    versions
        .into_iter()
        .next()
        .ok_or_else(|| "No compatible Modrinth version found for the current instance".to_string())
}

fn modrinth_version_rank(item: &ModrinthProjectVersion) -> (u8, u8, String) {
    let featured = if item.featured { 1 } else { 0 };
    let release_rank = match item
        .version_type
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("release") => 3,
        Some("beta") => 2,
        Some("alpha") => 1,
        _ => 0,
    };
    let published = item.date_published.clone().unwrap_or_default();
    (featured, release_rank, published)
}

fn choose_modrinth_version_file(
    version: &ModrinthProjectVersion,
) -> Result<ModrinthVersionFile, String> {
    version
        .files
        .iter()
        .find(|file| file.primary)
        .cloned()
        .or_else(|| version.files.first().cloned())
        .ok_or_else(|| {
            format!(
                "Modrinth version {} does not contain downloadable files",
                version.id
            )
        })
}

fn install_content_file_by_type(
    download_path: &Path,
    runtime_root: &Path,
    project_type: &str,
    filename: &str,
) -> Result<PathBuf, String> {
    let target_dir = content_target_dir(runtime_root, project_type)?;
    move_file_into_directory(download_path, &target_dir, filename)
}

fn content_target_dir(runtime_root: &Path, project_type: &str) -> Result<PathBuf, String> {
    match project_type {
        "mod" => Ok(runtime_root.join("mods")),
        "resourcepack" => Ok(runtime_root.join("resourcepacks")),
        "shader" => Ok(runtime_root.join("shaderpacks")),
        "world" => Ok(runtime_root.join("saves")),
        other => Err(format!(
            "Unsupported install target for content type '{other}'"
        )),
    }
}

fn build_content_target_path(
    runtime_root: &Path,
    project_type: &str,
    filename: &str,
) -> Result<PathBuf, String> {
    Ok(content_target_dir(runtime_root, project_type)?.join(sanitize_file_name(filename)))
}

fn move_file_into_directory(
    source_path: &Path,
    target_dir: &Path,
    filename: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create directory {}: {e}", target_dir.display()))?;
    let safe_name = sanitize_file_name(filename);
    let target_path = target_dir.join(safe_name);
    if target_path.exists() {
        fs::remove_file(&target_path).map_err(|e| {
            format!(
                "Failed to replace existing file {}: {e}",
                target_path.display()
            )
        })?;
    }
    fs::rename(source_path, &target_path).or_else(|_| {
        fs::copy(source_path, &target_path)
            .map(|_| ())
            .map_err(|e| {
                format!(
                    "Failed to move downloaded file from {} to {}: {e}",
                    source_path.display(),
                    target_path.display()
                )
            })
    })?;
    Ok(target_path)
}

fn sanitize_file_name(raw: &str) -> String {
    let candidate = Path::new(raw)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "download.bin".to_string());
    let mut output = String::with_capacity(candidate.len());
    for ch in candidate.chars() {
        if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            output.push('_');
        } else {
            output.push(ch);
        }
    }
    if output.trim().is_empty() {
        "download.bin".to_string()
    } else {
        output
    }
}

fn installed_content_index_path(runtime_root: &Path) -> PathBuf {
    runtime_root.join(".fpsmaster-content-index.json")
}

fn write_installed_content_index(
    runtime_root: &Path,
    items: &[InstalledContentItem],
) -> Result<(), String> {
    let index_path = installed_content_index_path(runtime_root);
    let serialized = serde_json::to_string_pretty(items)
        .map_err(|e| format!("Failed to serialize installed content index: {e}"))?;
    fs::write(&index_path, format!("{serialized}\n")).map_err(|e| {
        format!(
            "Failed to write installed content index {}: {e}",
            index_path.display()
        )
    })
}

fn read_installed_content_index(runtime_root: &Path) -> Result<Vec<InstalledContentItem>, String> {
    let index_path = installed_content_index_path(runtime_root);
    if !index_path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&index_path).map_err(|e| {
        format!(
            "Failed to read installed content index {}: {e}",
            index_path.display()
        )
    })?;
    serde_json::from_str::<Vec<InstalledContentItem>>(&content).map_err(|e| {
        format!(
            "Invalid installed content index {}: {e}",
            index_path.display()
        )
    })
}

fn upsert_installed_content_item(
    runtime_root: &Path,
    item: InstalledContentItem,
) -> Result<(), String> {
    let mut items = read_installed_content_index(runtime_root)?;
    items.retain(|existing| {
        !(existing.source == item.source
            && existing.project_id == item.project_id
            && existing.content_type == item.content_type)
    });
    items.push(item);
    items.sort_by(|left, right| {
        right
            .installed_at_epoch_sec
            .cmp(&left.installed_at_epoch_sec)
            .then_with(|| left.project_title.cmp(&right.project_title))
    });
    write_installed_content_index(runtime_root, &items)
}

fn find_installed_content_item(
    runtime_root: &Path,
    source: &str,
    project_id: &str,
    content_type: &str,
) -> Result<Option<InstalledContentItem>, String> {
    let items = read_installed_content_index(runtime_root)?;
    Ok(items.into_iter().find(|item| {
        item.source.eq_ignore_ascii_case(source)
            && item.project_id == project_id
            && item.content_type == content_type
    }))
}

fn remove_installed_content_item(
    runtime_root: &Path,
    source: &str,
    project_id: &str,
    content_type: &str,
) -> Result<InstalledContentItem, String> {
    let mut items = read_installed_content_index(runtime_root)?;
    let position = items
        .iter()
        .position(|item| {
            item.source.eq_ignore_ascii_case(source)
                && item.project_id == project_id
                && item.content_type == content_type
        })
        .ok_or_else(|| {
            format!("Installed content record not found for {source}:{content_type}:{project_id}")
        })?;

    let removed = items.remove(position);
    remove_content_install_path(runtime_root, &removed.installed_path)?;
    write_installed_content_index(runtime_root, &items)?;
    Ok(removed)
}

fn resolve_managed_content_path(
    runtime_root: &Path,
    raw_path: &str,
) -> Result<Option<PathBuf>, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let candidate = PathBuf::from(trimmed);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        runtime_root.join(candidate)
    };

    let canonical_runtime =
        fs::canonicalize(runtime_root).unwrap_or_else(|_| runtime_root.to_path_buf());
    if resolved.exists() {
        let canonical_target = fs::canonicalize(&resolved).map_err(|e| {
            format!(
                "Failed to resolve installed content path {}: {e}",
                resolved.display()
            )
        })?;
        if !canonical_target.starts_with(&canonical_runtime) {
            return Err(format!(
                "Refusing to manage content outside runtime root: {}",
                canonical_target.display()
            ));
        }
    } else if !resolved.starts_with(&canonical_runtime) && !resolved.starts_with(runtime_root) {
        return Err(format!(
            "Refusing to manage missing content outside runtime root: {}",
            resolved.display()
        ));
    }

    Ok(Some(resolved))
}

fn remove_content_install_path(runtime_root: &Path, raw_path: &str) -> Result<(), String> {
    let Some(resolved) = resolve_managed_content_path(runtime_root, raw_path)? else {
        return Ok(());
    };
    if !resolved.exists() {
        return Ok(());
    }
    if resolved.is_dir() {
        fs::remove_dir_all(&resolved).map_err(|e| {
            format!(
                "Failed to remove installed content directory {}: {e}",
                resolved.display()
            )
        })?;
    } else {
        fs::remove_file(&resolved).map_err(|e| {
            format!(
                "Failed to remove installed content file {}: {e}",
                resolved.display()
            )
        })?;
    }
    Ok(())
}

fn resolve_world_name(world_name: Option<&str>, archive_name: &str) -> Result<String, String> {
    let base = world_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| {
            Path::new(archive_name)
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "Imported World".to_string())
        });
    let sanitized = sanitize_file_name(&base)
        .trim()
        .trim_matches('.')
        .to_string();
    if sanitized.is_empty() {
        return Err("World name cannot be empty".to_string());
    }
    Ok(sanitized)
}

fn slugify_content_key(raw: &str) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.chars() {
        let normalized = ch.to_ascii_lowercase();
        if normalized.is_ascii_alphanumeric() {
            output.push(normalized);
            last_dash = false;
        } else if !last_dash {
            output.push('-');
            last_dash = true;
        }
    }
    let normalized = output.trim_matches('-').to_string();
    if normalized.is_empty() {
        format!("content-{}", now_epoch_seconds())
    } else {
        normalized
    }
}

fn normalize_version_identifier(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Version id cannot be empty".to_string());
    }

    let mut output = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            output.push(ch);
        } else {
            output.push('-');
        }
    }

    let normalized = output.trim_matches(['-', '.']).to_string();
    if normalized.is_empty() {
        return Err("Version id cannot be empty".to_string());
    }
    Ok(normalized)
}

fn normalize_loader_kind(raw: &str) -> Result<String, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "vanilla" => Ok("vanilla".to_string()),
        "fabric" => Ok("fabric".to_string()),
        "forge" => Ok("forge".to_string()),
        other => Err(format!(
            "Unsupported loader '{other}'. Expected vanilla/fabric/forge"
        )),
    }
}

fn archive_file_stem(raw: &str) -> Option<String> {
    Path::new(raw)
        .file_stem()
        .map(|value| value.to_string_lossy().trim().to_string())
        .filter(|value| !value.is_empty())
}

fn extract_archive_to_stage(
    archive_data: &[u8],
    stage_root: &Path,
    archive_label: &str,
) -> Result<usize, String> {
    let cursor = Cursor::new(archive_data.to_vec());
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Invalid {archive_label} archive ZIP: {e}"))?;
    let mut extracted_entries = 0usize;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let Some(relative_path) = entry.enclosed_name().map(|value| value.to_path_buf()) else {
            continue;
        };
        if relative_path.as_os_str().is_empty() {
            continue;
        }
        if relative_path.components().any(|part| {
            part.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case("__MACOSX")
        }) {
            continue;
        }

        let out_path = stage_root.join(&relative_path);
        if entry.name().ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| {
                format!(
                    "Failed to create extracted {archive_label} directory {}: {e}",
                    out_path.display()
                )
            })?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create extracted {archive_label} directory {}: {e}",
                    parent.display()
                )
            })?;
        }

        let mut output = fs::File::create(&out_path).map_err(|e| {
            format!(
                "Failed to create extracted {archive_label} file {}: {e}",
                out_path.display()
            )
        })?;
        std::io::copy(&mut entry, &mut output).map_err(|e| {
            format!(
                "Failed to extract {archive_label} file {}: {e}",
                out_path.display()
            )
        })?;
        output.flush().map_err(|e| {
            format!(
                "Failed to flush extracted {archive_label} file {}: {e}",
                out_path.display()
            )
        })?;
        extracted_entries += 1;
    }

    Ok(extracted_entries)
}

fn determine_archive_stage_root(stage_root: &Path, archive_label: &str) -> Result<PathBuf, String> {
    let mut child_dirs = Vec::new();
    let mut child_files = 0usize;
    for entry in fs::read_dir(stage_root).map_err(|e| {
        format!(
            "Failed to inspect extracted {archive_label} directory {}: {e}",
            stage_root.display()
        )
    })? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            child_dirs.push(path);
        } else {
            child_files += 1;
        }
    }

    if child_dirs.len() == 1 && child_files == 0 {
        Ok(child_dirs.remove(0))
    } else {
        Ok(stage_root.to_path_buf())
    }
}

fn find_instance_profile_json(root_dir: &Path) -> Result<PathBuf, String> {
    let mut queue = VecDeque::from([root_dir.to_path_buf()]);
    let mut fallback: Option<PathBuf> = None;
    while let Some(current) = queue.pop_front() {
        let entries = fs::read_dir(&current).map_err(|e| {
            format!(
                "Failed to inspect imported instance directory {}: {e}",
                current.display()
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                queue.push_back(path);
                continue;
            }
            if path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("json"))
                != Some(true)
            {
                continue;
            }
            match parse_instance_profile_metadata(&path) {
                Ok(metadata) => {
                    let file_stem = path
                        .file_stem()
                        .map(|value| value.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if file_stem.eq_ignore_ascii_case(&metadata.version_id) {
                        return Ok(path);
                    }
                    if fallback.is_none() {
                        fallback = Some(path);
                    }
                }
                Err(_) => continue,
            }
        }
    }

    fallback.ok_or_else(|| "No importable instance profile JSON found in archive".to_string())
}

fn parse_instance_profile_metadata(json_path: &Path) -> Result<InstanceProfileMetadata, String> {
    let profile_json_text = fs::read_to_string(json_path).map_err(|e| {
        format!(
            "Failed to read instance profile {}: {e}",
            json_path.display()
        )
    })?;
    let profile_json: serde_json::Value =
        serde_json::from_str(&profile_json_text).map_err(|e| {
            format!(
                "Failed to parse instance profile {}: {e}",
                json_path.display()
            )
        })?;
    let object = profile_json.as_object().ok_or_else(|| {
        format!(
            "Instance profile {} is not a JSON object",
            json_path.display()
        )
    })?;

    let version_id = object
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| {
            json_path
                .file_stem()
                .map(|value| value.to_string_lossy().trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| format!("Instance profile {} is missing id", json_path.display()))?;

    let inherits_from = object
        .get("inheritsFrom")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let lower_text = profile_json_text.to_ascii_lowercase();
    let lower_version_id = version_id.to_ascii_lowercase();
    let loader = if lower_version_id.contains("fabric")
        || lower_text.contains("net.fabricmc")
        || lower_text.contains("fabric-loader")
    {
        "fabric".to_string()
    } else if lower_version_id.contains("forge")
        || lower_text.contains("net.minecraftforge")
        || lower_text.contains("fmlloader")
    {
        "forge".to_string()
    } else {
        "vanilla".to_string()
    };

    let base_version = inherits_from
        .clone()
        .or_else(|| detect_base_version_from_profile_id(&version_id, &loader))
        .unwrap_or_else(|| version_id.clone());
    let loader_version = detect_loader_version_from_profile_id(&version_id, &loader, &base_version);

    Ok(InstanceProfileMetadata {
        version_id,
        base_version,
        loader,
        loader_version,
    })
}

fn detect_base_version_from_profile_id(version_id: &str, loader: &str) -> Option<String> {
    if loader == "fabric" {
        if let Some(rest) = version_id.strip_prefix("fabric-loader-") {
            if let Some((_, base_version)) = rest.split_once('-') {
                return Some(base_version.to_string());
            }
        }
    } else if loader == "forge" {
        if let Some((base_version, _)) = version_id.split_once("-forge-") {
            return Some(base_version.to_string());
        }
        if let Some(rest) = version_id.strip_prefix("forge-") {
            if let Some((base_version, _)) = rest.split_once('-') {
                return Some(base_version.to_string());
            }
        }
    }
    None
}

fn detect_loader_version_from_profile_id(
    version_id: &str,
    loader: &str,
    base_version: &str,
) -> Option<String> {
    if loader == "fabric" {
        if let Some(rest) = version_id.strip_prefix("fabric-loader-") {
            let suffix = format!("-{base_version}");
            if let Some(stripped) = rest.strip_suffix(&suffix) {
                return Some(stripped.to_string());
            }
            if let Some((loader_version, _)) = rest.split_once('-') {
                return Some(loader_version.to_string());
            }
        }
        return None;
    }

    if loader == "forge" {
        if let Some(rest) = version_id.strip_prefix(&format!("{base_version}-forge-")) {
            return Some(rest.to_string());
        }
        if let Some(rest) = version_id.strip_prefix("forge-") {
            let prefix = format!("{base_version}-");
            if let Some(stripped) = rest.strip_prefix(&prefix) {
                return Some(stripped.to_string());
            }
            if let Some((_, loader_version)) = rest.split_once('-') {
                return Some(loader_version.to_string());
            }
        }
    }

    None
}

fn extract_world_archive_to_stage(archive_data: &[u8], stage_root: &Path) -> Result<usize, String> {
    let cursor = Cursor::new(archive_data.to_vec());
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid world archive ZIP: {e}"))?;
    let mut extracted_entries = 0usize;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let Some(relative_path) = entry.enclosed_name().map(|value| value.to_path_buf()) else {
            continue;
        };
        if relative_path.as_os_str().is_empty() {
            continue;
        }
        if relative_path.components().any(|part| {
            part.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case("__MACOSX")
        }) {
            continue;
        }

        let out_path = stage_root.join(&relative_path);
        if entry.name().ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| {
                format!(
                    "Failed to create extracted world directory {}: {e}",
                    out_path.display()
                )
            })?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create extracted world directory {}: {e}",
                    parent.display()
                )
            })?;
        }

        let mut output = fs::File::create(&out_path).map_err(|e| {
            format!(
                "Failed to create extracted world file {}: {e}",
                out_path.display()
            )
        })?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|e| format!("Failed to extract world file {}: {e}", out_path.display()))?;
        output.flush().map_err(|e| {
            format!(
                "Failed to flush extracted world file {}: {e}",
                out_path.display()
            )
        })?;
        extracted_entries += 1;
    }

    Ok(extracted_entries)
}

fn determine_world_stage_root(stage_root: &Path) -> Result<PathBuf, String> {
    let mut child_dirs = Vec::new();
    let mut child_files = 0usize;
    for entry in fs::read_dir(stage_root).map_err(|e| {
        format!(
            "Failed to inspect extracted world directory {}: {e}",
            stage_root.display()
        )
    })? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            child_dirs.push(path);
        } else {
            child_files += 1;
        }
    }

    if child_dirs.len() == 1 && child_files == 0 {
        Ok(child_dirs.remove(0))
    } else {
        Ok(stage_root.to_path_buf())
    }
}

fn move_or_copy_directory(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    if let Some(parent) = target_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create parent directory {}: {e}",
                parent.display()
            )
        })?;
    }

    match fs::rename(source_dir, target_dir) {
        Ok(_) => Ok(()),
        Err(_) => {
            fs::create_dir_all(target_dir).map_err(|e| {
                format!(
                    "Failed to create target world directory {}: {e}",
                    target_dir.display()
                )
            })?;
            copy_directory_contents(source_dir, target_dir)
        }
    }
}

fn write_instance_archive(
    source_dir: &Path,
    archive_path: &Path,
    archive_root_name: &str,
) -> Result<(), String> {
    let file = fs::File::create(archive_path).map_err(|e| {
        format!(
            "Failed to create export archive {}: {e}",
            archive_path.display()
        )
    })?;
    let mut writer = zip::ZipWriter::new(file);
    let root_name = sanitize_file_name(archive_root_name);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    writer
        .add_directory(format!("{root_name}/"), options)
        .map_err(|e| format!("Failed to initialize export archive: {e}"))?;
    append_directory_to_zip(&mut writer, source_dir, Path::new(&root_name), options)?;
    writer
        .finish()
        .map_err(|e| format!("Failed to finalize export archive: {e}"))?;
    Ok(())
}

fn append_directory_to_zip(
    writer: &mut zip::ZipWriter<fs::File>,
    source_dir: &Path,
    archive_root: &Path,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(source_dir).map_err(|e| {
        format!(
            "Failed to read export source directory {}: {e}",
            source_dir.display()
        )
    })? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source_path = entry.path();
        let archive_path = archive_root.join(entry.file_name());
        let archive_name = zip_archive_path(&archive_path)?;

        if source_path.is_dir() {
            writer
                .add_directory(format!("{archive_name}/"), options)
                .map_err(|e| format!("Failed to add archive directory {archive_name}: {e}"))?;
            append_directory_to_zip(writer, &source_path, &archive_path, options)?;
        } else {
            writer
                .start_file(archive_name.clone(), options)
                .map_err(|e| format!("Failed to add archive file {archive_name}: {e}"))?;
            let mut input = fs::File::open(&source_path).map_err(|e| {
                format!(
                    "Failed to open export source file {}: {e}",
                    source_path.display()
                )
            })?;
            std::io::copy(&mut input, writer).map_err(|e| {
                format!(
                    "Failed to write archive file {}: {e}",
                    source_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn zip_archive_path(path: &Path) -> Result<String, String> {
    let mut output = String::new();
    for component in path.components() {
        let part = component.as_os_str().to_string_lossy();
        if part.is_empty() {
            continue;
        }
        if !output.is_empty() {
            output.push('/');
        }
        output.push_str(&part);
    }
    if output.is_empty() {
        return Err("Invalid archive path".to_string());
    }
    Ok(output)
}

fn download_file_quiet_blocking(
    client: &reqwest::blocking::Client,
    url: &str,
    target: &Path,
) -> Result<(), String> {
    download_file_quiet_with_progress_blocking(client, url, target, None, None)
}

fn emit_content_install_progress(
    window: Option<&tauri::Window>,
    project_key: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    let Some(target_window) = window else {
        return;
    };
    let percent = total_bytes
        .filter(|value| *value > 0)
        .map(|value| {
            downloaded_bytes
                .saturating_mul(100)
                .min(value.saturating_mul(100))
                / value
        })
        .and_then(|value| u8::try_from(value).ok());
    let _ = target_window.emit(
        "content-install-progress",
        ContentInstallProgressEvent {
            project_key: project_key.to_string(),
            downloaded_bytes,
            total_bytes,
            percent,
        },
    );
}

fn download_file_quiet_with_progress_blocking(
    client: &reqwest::blocking::Client,
    url: &str,
    target: &Path,
    window: Option<&tauri::Window>,
    project_key: Option<&str>,
) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create download directory {}: {e}",
                parent.display()
            )
        })?;
    }

    let tmp = target.with_extension("download");
    let mut last_error = String::new();
    for attempt in 1..=3 {
        let response = client
            .get(url)
            .header(reqwest::header::ACCEPT, "*/*")
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send();

        let mut response = match response {
            Ok(value) => value,
            Err(err) => {
                last_error = format!("request failed on attempt {attempt}/3: {err}");
                continue;
            }
        };
        if !response.status().is_success() {
            last_error = format!("HTTP {}", response.status());
            continue;
        }
        let total_bytes = response.content_length();
        if let Some(key) = project_key {
            emit_content_install_progress(window, key, 0, total_bytes);
        }

        let mut file = fs::File::create(&tmp)
            .map_err(|e| format!("Failed to create temp file {}: {e}", tmp.display()))?;
        let mut write_result = Ok(0_u64);
        let mut downloaded_bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = match response.read(&mut buffer) {
                Ok(0) => break,
                Ok(value) => value,
                Err(err) => {
                    write_result = Err(err);
                    break;
                }
            };
            if let Err(err) = file.write_all(&buffer[..read]) {
                write_result = Err(err);
                break;
            }
            downloaded_bytes += read as u64;
            if let Some(key) = project_key {
                emit_content_install_progress(window, key, downloaded_bytes, total_bytes);
            }
        }
        match write_result {
            Ok(_) => {
                file.flush()
                    .map_err(|e| format!("Failed to flush temp file {}: {e}", tmp.display()))?;
                if target.exists() {
                    fs::remove_file(target).map_err(|e| {
                        format!("Failed to replace existing file {}: {e}", target.display())
                    })?;
                }
                fs::rename(&tmp, target).map_err(|e| {
                    format!(
                        "Failed to move downloaded file from {} to {}: {e}",
                        tmp.display(),
                        target.display()
                    )
                })?;
                if let Some(key) = project_key {
                    let final_total = total_bytes.or(Some(downloaded_bytes));
                    emit_content_install_progress(window, key, downloaded_bytes, final_total);
                }
                return Ok(());
            }
            Err(err) => {
                last_error = format!("read failed on attempt {attempt}/3: {err}");
                let _ = fs::remove_file(&tmp);
            }
        }
    }

    let _ = fs::remove_file(&tmp);
    Err(last_error)
}

fn resolve_manifest_base_url(
    manifest_url: &str,
    manifest_base_url: Option<&str>,
) -> Result<reqwest::Url, String> {
    let manifest_url = reqwest::Url::parse(manifest_url)
        .map_err(|e| format!("Invalid manifestUrl {}: {e}", manifest_url))?;
    if let Some(base_url) = manifest_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Ok(parsed) = reqwest::Url::parse(base_url) {
            return Ok(parsed);
        }
        return manifest_url
            .join(base_url)
            .map_err(|e| format!("Invalid manifest baseUrl {}: {e}", base_url));
    }
    Ok(manifest_url)
}

fn resolve_manifest_file_url(
    base_url: &reqwest::Url,
    entry: &LauncherPackageManifestFile,
) -> Result<String, String> {
    let source = entry
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.replace('\\', "/"))
        .unwrap_or_else(|| entry.path.trim().replace('\\', "/"));
    if let Ok(parsed) = reqwest::Url::parse(&source) {
        return Ok(parsed.to_string());
    }
    base_url
        .join(&source)
        .map(|url| url.to_string())
        .map_err(|e| format!("Invalid manifest file url {}: {e}", source))
}

fn normalize_manifest_relative_path(raw: &str) -> Result<PathBuf, String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("Manifest file path cannot be empty".to_string());
    }
    let candidate = PathBuf::from(normalized);
    let mut relative = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::Normal(part) => relative.push(part),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(format!("Manifest file path is not allowed: {}", raw.trim()));
            }
        }
    }
    if relative.as_os_str().is_empty() {
        return Err(format!("Manifest file path is not allowed: {}", raw.trim()));
    }
    Ok(relative)
}

fn replace_directory_with_stage(target_dir: &Path, stage_dir: &Path) -> Result<(), String> {
    let parent_dir = target_dir
        .parent()
        .ok_or_else(|| format!("Invalid target directory: {}", target_dir.display()))?;
    let backup_dir = parent_dir.join(format!(
        ".fpsmaster-launcher-mods-backup-{}-{}",
        std::process::id(),
        now_epoch_millis()
    ));
    if backup_dir.exists() {
        fs::remove_dir_all(&backup_dir).map_err(|e| {
            format!(
                "Failed to reset backup directory {}: {e}",
                backup_dir.display()
            )
        })?;
    }

    let had_existing = target_dir.exists();
    if had_existing {
        fs::rename(target_dir, &backup_dir).map_err(|e| {
            format!(
                "Failed to move existing mods directory {} to backup {}: {e}",
                target_dir.display(),
                backup_dir.display()
            )
        })?;
    }

    let promote_result = fs::rename(stage_dir, target_dir);
    if let Err(err) = promote_result {
        if had_existing {
            let _ = fs::rename(&backup_dir, target_dir);
        }
        return Err(format!(
            "Failed to promote staged mods directory {} to {}: {err}",
            stage_dir.display(),
            target_dir.display()
        ));
    }

    if had_existing {
        fs::remove_dir_all(&backup_dir).map_err(|e| {
            format!(
                "Failed to remove backup directory {}: {e}",
                backup_dir.display()
            )
        })?;
    }

    Ok(())
}

fn copy_directory_contents(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    if !source_dir.exists() {
        return Ok(());
    }
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create directory {}: {e}", target_dir.display()))?;
    for entry in fs::read_dir(source_dir).map_err(|e| {
        format!(
            "Failed to read staged directory {}: {e}",
            source_dir.display()
        )
    })? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source_path = entry.path();
        let target_path = target_dir.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory_contents(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Failed to create target directory {}: {e}",
                        parent.display()
                    )
                })?;
            }
            fs::copy(&source_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy file from {} to {}: {e}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn verify_file_sha256(path: &Path, expected_checksum: &str) -> Result<(), String> {
    let expected = normalize_sha256_value(expected_checksum)
        .ok_or_else(|| format!("Unsupported checksum value: {}", expected_checksum.trim()))?;
    let actual = compute_file_sha256_hex(path)?;
    if actual != expected {
        return Err(format!("expected {}, got {}", expected, actual));
    }
    Ok(())
}

fn verify_file_sha512(path: &Path, expected_checksum: &str) -> Result<(), String> {
    let expected = normalize_sha512_value(expected_checksum)
        .ok_or_else(|| format!("Unsupported checksum value: {}", expected_checksum.trim()))?;
    let actual = compute_file_sha512_hex(path)?;
    if actual != expected {
        return Err(format!("expected {}, got {}", expected, actual));
    }
    Ok(())
}

fn compute_file_sha256_hex(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|e| format!("Failed to open file {} for checksum: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read file {} for checksum: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    let digest = hasher.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    Ok(output)
}

fn compute_file_sha512_hex(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|e| format!("Failed to open file {} for checksum: {e}", path.display()))?;
    let mut hasher = Sha512::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read file {} for checksum: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    let digest = hasher.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    Ok(output)
}

fn normalize_sha256_value(raw: &str) -> Option<String> {
    let mut normalized = raw.trim().to_ascii_lowercase();
    if let Some(stripped) = normalized.strip_prefix("sha256:") {
        normalized = stripped.trim().to_string();
    }
    if normalized.len() == 64 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(normalized)
    } else {
        None
    }
}

fn normalize_sha512_value(raw: &str) -> Option<String> {
    let mut normalized = raw.trim().to_ascii_lowercase();
    if let Some(stripped) = normalized.strip_prefix("sha512:") {
        normalized = stripped.trim().to_string();
    }
    if normalized.len() == 128 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(normalized)
    } else {
        None
    }
}

fn push_download_source_arg(command: &mut Vec<String>, download_source: Option<&str>) {
    let Some(source) = download_source
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    command.push("--download-source".to_string());
    command.push(source.to_string());
}

#[tauri::command]
async fn list_vanilla_versions(
    window: tauri::Window,
    download_source: Option<String>,
) -> Result<Vec<String>, String> {
    let mut command = vec!["list-versions".to_string()];
    push_download_source_arg(&mut command, download_source.as_deref());
    let output = run_java_core_async(Some(window), command).await?;
    serde_json::from_str::<Vec<String>>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
async fn install_vanilla(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    download_source: Option<String>,
    ipc_session: Option<String>,
) -> Result<InstallResult, String> {
    let game_dir = resolve_game_dir_path(&game_dir)?
        .to_string_lossy()
        .to_string();
    let mut command = vec![
        "install-vanilla".to_string(),
        "--game-dir".to_string(),
        game_dir,
        "--version".to_string(),
        version_id,
    ];
    push_download_source_arg(&mut command, download_source.as_deref());
    if let Some(session) = ipc_session {
        if !session.trim().is_empty() {
            command.push("--ipc-session".to_string());
            command.push(session);
        }
    }
    let output = run_java_core_async(Some(window), command).await?;
    serde_json::from_str::<InstallResult>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

fn install_vanilla_blocking_core(
    window: Option<&tauri::Window>,
    game_dir: &Path,
    version_id: &str,
    download_source: Option<&str>,
) -> Result<InstallResult, String> {
    let normalized_version_id = version_id.trim();
    if normalized_version_id.is_empty() {
        return Err("Version id cannot be empty".to_string());
    }
    let command = vec![
        "install-vanilla".to_string(),
        "--game-dir".to_string(),
        strip_windows_verbatim_prefix(game_dir)
            .to_string_lossy()
            .to_string(),
        "--version".to_string(),
        normalized_version_id.to_string(),
    ];
    let mut command = command;
    push_download_source_arg(&mut command, download_source);
    let refs: Vec<&str> = command.iter().map(String::as_str).collect();
    let output = run_java_core(window, &refs)?;
    serde_json::from_str::<InstallResult>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
async fn build_vanilla_launch_plan(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    player_name: String,
    uuid: String,
    access_token: String,
    max_memory_mb: i32,
    java_path: Option<String>,
    download_source: Option<String>,
) -> Result<LaunchPlan, String> {
    let game_dir = resolve_game_dir_path(&game_dir)?
        .to_string_lossy()
        .to_string();
    let max_memory = max_memory_mb.to_string();
    let mut command = vec![
        "build-launch-plan".to_string(),
        "--game-dir".to_string(),
        game_dir,
        "--version".to_string(),
        version_id,
        "--player".to_string(),
        player_name,
        "--uuid".to_string(),
        uuid,
        "--access-token".to_string(),
        access_token,
        "--max-memory".to_string(),
        max_memory,
    ];
    if let Some(java) = java_path {
        command.push("--java".to_string());
        command.push(java);
    }
    push_download_source_arg(&mut command, download_source.as_deref());

    let output = run_java_core_async(Some(window), command).await?;
    serde_json::from_str::<LaunchPlan>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
async fn launch_vanilla(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    player_name: String,
    uuid: String,
    access_token: String,
    max_memory_mb: i32,
    java_path: Option<String>,
    download_source: Option<String>,
    wait_for_exit: Option<bool>,
    server_address: Option<String>,
) -> Result<LaunchExecutionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        launch_vanilla_blocking(
            window,
            game_dir,
            version_id,
            player_name,
            uuid,
            access_token,
            max_memory_mb,
            java_path,
            download_source,
            wait_for_exit,
            server_address,
        )
    })
    .await
    .map_err(|e| format!("Failed to join launch task: {e}"))?
}

fn launch_vanilla_blocking(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    player_name: String,
    uuid: String,
    access_token: String,
    max_memory_mb: i32,
    java_path: Option<String>,
    download_source: Option<String>,
    wait_for_exit: Option<bool>,
    server_address: Option<String>,
) -> Result<LaunchExecutionResult, String> {
    if let Some(pid) = detect_active_game_pid() {
        return Err(format!(
            "Another game process is already running (pid={pid}). Stop it before launching a new instance."
        ));
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let resolved_game_dir = game_dir_path.to_string_lossy().to_string();
    let plan = resolve_launch_plan_blocking(
        &window,
        &resolved_game_dir,
        &version_id,
        &player_name,
        &uuid,
        &access_token,
        max_memory_mb,
        java_path.as_deref(),
        download_source.as_deref(),
        server_address.as_deref(),
    )?;

    let mut normalized_command = normalize_game_command_tokens(plan.command.clone());
    if normalized_command.is_empty() {
        return Err("Launch command is empty".to_string());
    }
    let runtime_dir = resolve_version_runtime_dir(&game_dir_path, &version_id)?;
    rewrite_launch_game_dir_argument(&mut normalized_command, &runtime_dir);

    let executable = normalized_command[0].clone();
    let args = normalized_command[1..].to_vec();
    let command_preview = format_quoted_command(&executable, &args);
    emit_log(
        Some(&window),
        "info",
        &format!("launch game: {command_preview}"),
    );

    let should_wait = wait_for_exit.unwrap_or(false);
    let mut child = spawn_game_process(&runtime_dir, &executable, &args)?;
    let pid = i64::from(child.id());
    if let Ok(mut store) = game_runtime_starts().lock() {
        store.insert(pid, std::time::Instant::now());
    }
    ensure_game_runtime_sampler();
    let _ = window.emit(
        "game-log",
        CoreLogEvent {
            level: "stdout".to_string(),
            message: format!("[process] started pid={pid}"),
        },
    );
    push_ui_log("game", "stdout", &format!("[process] started pid={pid}"));

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture game stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture game stderr".to_string())?;

    let stdout_handle = pump_game_stream(stdout, window.clone(), "stdout");
    let stderr_handle = pump_game_stream(stderr, window.clone(), "stderr");
    if should_wait {
        let status = child
            .wait()
            .map_err(|e| format!("Failed waiting game process: {e}"))?;
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();
        let exit_code = status.code().unwrap_or(-1);
        let _ = window.emit("game-exit", GameExitEvent { pid, exit_code });
        push_ui_log(
            "game",
            "exit",
            &format!("process exited pid={pid} code={exit_code}"),
        );
        clear_runtime_pid(pid);

        return Ok(LaunchExecutionResult {
            version_id,
            pid,
            wait_for_exit: true,
            exit_code: Some(exit_code),
            main_class: plan.main_class,
            shell: "direct".to_string(),
            command: normalized_command,
        });
    }

    let wait_window = window.clone();
    thread::spawn(move || {
        let exit_code = child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(-1);
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();
        let _ = wait_window.emit("game-exit", GameExitEvent { pid, exit_code });
        push_ui_log(
            "game",
            "exit",
            &format!("process exited pid={pid} code={exit_code}"),
        );
        clear_runtime_pid(pid);
    });

    Ok(LaunchExecutionResult {
        version_id,
        pid,
        wait_for_exit: should_wait,
        exit_code: None,
        main_class: plan.main_class,
        shell: if cfg!(windows) {
            "direct".to_string()
        } else {
            "direct".to_string()
        },
        command: normalized_command,
    })
}

fn clear_runtime_pid(pid: i64) {
    if let Ok(mut store) = game_runtime_starts().lock() {
        store.remove(&pid);
    }
    if let Ok(mut cache) = game_runtime_cache().lock() {
        cache.remove(&pid);
    }
}

fn detect_active_game_pid() -> Option<i64> {
    let pids = if let Ok(store) = game_runtime_starts().lock() {
        store.keys().copied().collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let mut active = None;
    let mut stale = Vec::new();
    for pid in pids {
        match query_process_memory_kb(pid) {
            Ok(Some(_)) => {
                active = Some(pid);
                break;
            }
            _ => stale.push(pid),
        }
    }

    if !stale.is_empty() {
        if let Ok(mut store) = game_runtime_starts().lock() {
            for pid in stale {
                store.remove(&pid);
            }
        }
    }

    active
}

fn resolve_launch_plan_blocking(
    window: &tauri::Window,
    game_dir: &str,
    version_id: &str,
    player_name: &str,
    uuid: &str,
    access_token: &str,
    max_memory_mb: i32,
    java_path: Option<&str>,
    download_source: Option<&str>,
    server_address: Option<&str>,
) -> Result<LaunchPlan, String> {
    let mut command = vec![
        "build-launch-plan".to_string(),
        "--game-dir".to_string(),
        game_dir.to_string(),
        "--version".to_string(),
        version_id.to_string(),
        "--player".to_string(),
        player_name.to_string(),
        "--uuid".to_string(),
        uuid.to_string(),
        "--access-token".to_string(),
        access_token.to_string(),
        "--max-memory".to_string(),
        max_memory_mb.to_string(),
    ];
    if let Some(java) = java_path {
        command.push("--java".to_string());
        command.push(java.to_string());
    }
    if let Some(server) = server_address {
        command.push("--server".to_string());
        command.push(server.to_string());
    }
    push_download_source_arg(&mut command, download_source);

    let refs: Vec<&str> = command.iter().map(String::as_str).collect();
    let output = run_java_core(Some(window), &refs)?;
    serde_json::from_str::<LaunchPlan>(&output)
        .map_err(|e| format!("Invalid launch plan output: {e}"))
}

fn normalize_game_command_tokens(command: Vec<String>) -> Vec<String> {
    if command.is_empty() {
        return command;
    }

    let executable = command[0].clone();
    let mut normalized_args: Vec<String> = Vec::with_capacity(command.len().saturating_sub(1));
    let mut i = 1;
    while i < command.len() {
        let current = &command[i];
        if current == "-Djava" && i + 1 < command.len() {
            let next = &command[i + 1];
            if next.starts_with(".library.path=") {
                normalized_args.push(format!("-Djava{next}"));
                i += 2;
                continue;
            }
        }

        if current == "-Djava.library.path" && i + 1 < command.len() {
            normalized_args.push(format!("-Djava.library.path={}", command[i + 1]));
            i += 2;
            continue;
        }

        normalized_args.push(current.clone());
        i += 1;
    }

    let mut normalized = Vec::with_capacity(normalized_args.len() + 1);
    normalized.push(executable);
    normalized.extend(normalized_args);
    normalized
}

fn resolve_version_runtime_dir(game_dir: &Path, version_id: &str) -> Result<PathBuf, String> {
    let version = version_id.trim();
    if version.is_empty() {
        return Err("Version id is empty".to_string());
    }
    let runtime_dir = game_dir.join("versions").join(version);
    fs::create_dir_all(&runtime_dir).map_err(|e| {
        format!(
            "Failed to create isolated runtime directory {}: {e}",
            runtime_dir.display()
        )
    })?;
    Ok(runtime_dir)
}

fn resolve_instance_section_dir(
    game_dir: &Path,
    version_id: &str,
    section: &str,
) -> Result<PathBuf, String> {
    let normalized = match section.trim().to_lowercase().as_str() {
        "saves" => "saves",
        "mods" => "mods",
        "resourcepacks" => "resourcepacks",
        "shaderpacks" => "shaderpacks",
        "logs" => "logs",
        "crash-reports" => "crash-reports",
        other => {
            return Err(format!(
            "Unsupported instance section '{other}'. Expected saves/mods/resourcepacks/shaderpacks/logs/crash-reports"
        ))
        }
    };
    Ok(resolve_version_runtime_dir(game_dir, version_id)?.join(normalized))
}

#[tauri::command]
fn list_instance_section_entries(
    game_dir: String,
    version_id: String,
    section: String,
) -> Result<Vec<InstanceSectionEntry>, String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let section_dir = resolve_instance_section_dir(&game_dir_path, &version_id, &section)?;
    if !section_dir.exists() {
        return Ok(Vec::new());
    }

    let read_dir = fs::read_dir(&section_dir).map_err(|e| {
        format!(
            "Failed to read instance section directory {}: {e}",
            section_dir.display()
        )
    })?;
    let mut entries = Vec::new();
    for item in read_dir {
        let item = item.map_err(|e| {
            format!(
                "Failed reading an entry in section directory {}: {e}",
                section_dir.display()
            )
        })?;
        let metadata = item.metadata().map_err(|e| {
            format!(
                "Failed reading metadata in section directory {}: {e}",
                section_dir.display()
            )
        })?;
        let file_name = item.file_name();
        let file_name_str = file_name.to_string_lossy().to_string();

        // Check if the file is disabled (for mods)
        let disabled = if section == "mods" {
            file_name_str.ends_with(".disabled") || file_name_str.ends_with(".jar.disabled")
        } else {
            false
        };

        entries.push(InstanceSectionEntry {
            name: file_name_str,
            is_dir: metadata.is_dir(),
            disabled,
        });
    }

    entries.sort_by(|left, right| match (left.is_dir, right.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
fn open_instance_section(
    game_dir: String,
    version_id: String,
    section: String,
) -> Result<(), String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let section_dir = resolve_instance_section_dir(&game_dir_path, &version_id, &section)?;
    fs::create_dir_all(&section_dir).map_err(|e| {
        format!(
            "Failed to create instance section directory {}: {e}",
            section_dir.display()
        )
    })?;
    open_path_in_explorer(&section_dir)
}

#[tauri::command]
fn delete_instance_section_entry(
    game_dir: String,
    version_id: String,
    section: String,
    entry_name: String,
) -> Result<(), String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let section_dir = resolve_instance_section_dir(&game_dir_path, &version_id, &section)?;
    let entry_path = section_dir.join(&entry_name);

    if !entry_path.exists() {
        return Err(format!("Entry does not exist: {}", entry_name));
    }

    if entry_path.is_dir() {
        fs::remove_dir_all(&entry_path)
            .map_err(|e| format!("Failed to delete directory {}: {e}", entry_path.display()))?;
    } else {
        fs::remove_file(&entry_path)
            .map_err(|e| format!("Failed to delete file {}: {e}", entry_path.display()))?;
    }

    Ok(())
}

#[tauri::command]
fn toggle_mod_disabled(
    game_dir: String,
    version_id: String,
    mod_name: String,
    disable: bool,
) -> Result<(), String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let mods_dir = resolve_instance_section_dir(&game_dir_path, &version_id, "mods")?;
    let mod_path = mods_dir.join(&mod_name);

    if !mod_path.exists() {
        return Err(format!("Mod does not exist: {}", mod_name));
    }

    if disable {
        // Disable by adding .disabled extension
        let new_name = format!("{}.disabled", mod_name);
        let new_path = mods_dir.join(&new_name);
        fs::rename(&mod_path, &new_path)
            .map_err(|e| format!("Failed to disable mod {}: {e}", mod_name))?;
    } else {
        // Enable by removing .disabled extension
        if !mod_name.ends_with(".disabled") {
            return Err(format!("Mod is not disabled: {}", mod_name));
        }
        let new_name = mod_name
            .strip_suffix(".disabled")
            .ok_or_else(|| "Invalid mod name".to_string())?;
        let new_path = mods_dir.join(new_name);
        fs::rename(&mod_path, &new_path)
            .map_err(|e| format!("Failed to enable mod {}: {e}", mod_name))?;
    }

    Ok(())
}

fn open_path_in_explorer(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Windows explorer returns non-zero exit code even when successful.
        // Just spawn the process and ignore the exit status.
        let mut command = Command::new("explorer");
        command.arg(path);
        apply_windows_silent_spawn(&mut command);
        command
            .spawn()
            .map_err(|e| format!("Failed to open folder with explorer: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg(path)
            .status()
            .map_err(|e| format!("Failed to open folder with open: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("open returned non-zero status: {status}"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = Command::new("xdg-open")
            .arg(path)
            .status()
            .map_err(|e| format!("Failed to open folder with xdg-open: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("xdg-open returned non-zero status: {status}"));
    }
}

fn open_file_with_system(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", &path.to_string_lossy()]);
        apply_windows_silent_spawn(&mut command);
        let status = command
            .status()
            .map_err(|e| format!("Failed to open file with start: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("start returned non-zero status: {status}"));
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg(path)
            .status()
            .map_err(|e| format!("Failed to open file with open: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("open returned non-zero status: {status}"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = Command::new("xdg-open")
            .arg(path)
            .status()
            .map_err(|e| format!("Failed to open file with xdg-open: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("xdg-open returned non-zero status: {status}"));
    }
}

fn rewrite_launch_game_dir_argument(command: &mut Vec<String>, runtime_dir: &Path) {
    let runtime_value = runtime_dir.to_string_lossy().to_string();
    let mut replaced = false;
    let mut i = 1;
    while i < command.len() {
        let token = &command[i];
        if (token == "--gameDir" || token == "--game-dir") && i + 1 < command.len() {
            command[i + 1] = runtime_value.clone();
            replaced = true;
            i += 2;
            continue;
        }
        if token.starts_with("--gameDir=") {
            command[i] = format!("--gameDir={runtime_value}");
            replaced = true;
            i += 1;
            continue;
        }
        if token.starts_with("--game-dir=") {
            command[i] = format!("--game-dir={runtime_value}");
            replaced = true;
            i += 1;
            continue;
        }
        i += 1;
    }

    if !replaced {
        command.push("--gameDir".to_string());
        command.push(runtime_value);
    }
}

fn format_quoted_command(executable: &str, args: &[String]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(quote_arg(executable));
    for arg in args {
        parts.push(quote_arg(arg));
    }
    parts.join(" ")
}

fn quote_arg(arg: &str) -> String {
    let escaped = arg.replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn spawn_game_process(
    game_dir: &Path,
    executable: &str,
    args: &[String],
) -> Result<std::process::Child, String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(game_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_windows_silent_spawn(&mut command);

    command
        .spawn()
        .map_err(|e| format!("Failed to launch game process: {e}"))
}

fn resolve_game_dir_path(game_dir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(game_dir.trim());
    if path.is_absolute() {
        return Ok(path);
    }
    env::current_dir()
        .map(|cwd| cwd.join(path))
        .map_err(|e| format!("Failed resolving game dir: {e}"))
}

fn default_game_dir_path() -> Result<PathBuf, String> {
    if cfg!(windows) {
        if let Some(appdata) = env::var_os("APPDATA") {
            return Ok(PathBuf::from(appdata).join("FPSMaster"));
        }
    }

    if let Some(home) = env::var_os("HOME") {
        return Ok(PathBuf::from(home).join(".fpsmaster"));
    }

    env::current_dir()
        .map(|cwd| cwd.join(".fpsmaster"))
        .map_err(|e| format!("Failed resolving default game dir: {e}"))
}

fn query_process_memory_kb(pid: i64) -> Result<Option<u64>, String> {
    if cfg!(windows) {
        return query_windows_process_memory_kb(pid);
    }
    query_unix_process_memory_kb(pid)
}

fn query_windows_process_memory_kb(pid: i64) -> Result<Option<u64>, String> {
    let filter = format!("PID eq {pid}");
    let mut command = Command::new("tasklist");
    command.args(["/FI", &filter, "/FO", "CSV", "/NH"]);
    apply_windows_silent_spawn(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("Failed to query tasklist: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "tasklist failed with status {:?}",
            output.status.code()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|item| !item.is_empty())
        .unwrap_or("");

    if line.is_empty() {
        return Ok(None);
    }

    if !line.starts_with('"') {
        return Ok(None);
    }

    let lower = line.to_ascii_lowercase();
    if lower.starts_with("info:") || lower.contains("no tasks are running") {
        return Ok(None);
    }

    let fields = parse_csv_line(line);
    if fields.len() < 5 {
        return Ok(Some(0));
    }

    let digits: String = fields[4].chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return Ok(Some(0));
    }
    let kb = digits.parse::<u64>().unwrap_or(0);
    Ok(Some(kb))
}

#[cfg(not(windows))]
fn query_unix_process_memory_kb(pid: i64) -> Result<Option<u64>, String> {
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .map_err(|e| format!("Failed to query ps: {e}"))?;

    if !output.status.success() {
        return Ok(None);
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    let kb = value
        .parse::<u64>()
        .map_err(|e| format!("Failed parsing rss value: {e}"))?;
    Ok(Some(kb))
}

#[cfg(windows)]
fn query_unix_process_memory_kb(_pid: i64) -> Result<Option<u64>, String> {
    Ok(None)
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '"' {
            if in_quotes && i + 1 < chars.len() && chars[i + 1] == '"' {
                current.push('"');
                i += 2;
                continue;
            }
            in_quotes = !in_quotes;
            i += 1;
            continue;
        }
        if ch == ',' && !in_quotes {
            fields.push(current.clone());
            current.clear();
            i += 1;
            continue;
        }
        current.push(ch);
        i += 1;
    }
    fields.push(current);
    fields
}

fn build_platform_command(
    executable: &str,
    args: &[String],
    current_dir: Option<&Path>,
) -> Command {
    if cfg!(windows) {
        let mut command = Command::new(executable);
        command.args(args);
        apply_windows_silent_spawn(&mut command);
        if let Some(dir) = current_dir {
            command.current_dir(dir);
        }
        return command;
    }

    let mut command = Command::new(executable);
    command.args(args);
    if let Some(dir) = current_dir {
        command.current_dir(dir);
    }
    command
}

fn resolve_java_core_executable(
    window: Option<&tauri::Window>,
    args: &[&str],
) -> Result<PathBuf, String> {
    let game_dir = extract_cli_option_path(args, &["--game-dir", "--gameDir"])?
        .unwrap_or(default_game_dir_path()?);
    let runtime_root = managed_jdk_runtime_root(&game_dir, 17);
    ensure_managed_jdk_runtime(window, &runtime_root, 17)
}

fn extract_cli_option_path(args: &[&str], names: &[&str]) -> Result<Option<PathBuf>, String> {
    let mut index = 0;
    while index < args.len() {
        let current = args[index];
        for name in names {
            if current == *name {
                if index + 1 >= args.len() {
                    return Err(format!("Missing value for {}", name));
                }
                return Ok(Some(resolve_game_dir_path(args[index + 1])?));
            }
            if let Some(value) = current.strip_prefix(&format!("{name}=")) {
                return Ok(Some(resolve_game_dir_path(value)?));
            }
        }
        index += 1;
    }
    Ok(None)
}

fn managed_jdk_runtime_root(game_dir: &Path, major: i32) -> PathBuf {
    game_dir.join("runtime").join(format!("jdk-{major}"))
}

fn ensure_managed_jdk_runtime(
    window: Option<&tauri::Window>,
    runtime_root: &Path,
    major: i32,
) -> Result<PathBuf, String> {
    fs::create_dir_all(runtime_root).map_err(|e| {
        format!(
            "Failed creating runtime dir {}: {e}",
            runtime_root.display()
        )
    })?;

    if let Some(java_path) = locate_java_binary(runtime_root) {
        emit_log(
            window,
            "info",
            &format!(
                "Managed JDK already exists major={major} path={}",
                java_path.to_string_lossy()
            ),
        );
        return Ok(java_path);
    }

    let archive_ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let archive_path = runtime_root.join(format!("jdk-{major}.{archive_ext}"));
    let sources = jdk_download_sources(major);
    if sources.is_empty() {
        return Err("No JDK download source configured".to_string());
    }

    let mut source_errors: Vec<String> = Vec::new();
    let mut downloaded = false;
    for (index, source) in sources.iter().enumerate() {
        emit_log(
            window,
            "info",
            &format!(
                "Downloading JDK {major} [{}/{}] {}: {}",
                index + 1,
                sources.len(),
                source.name,
                source.url
            ),
        );

        match download_file_blocking(window, &source.name, &source.url, &archive_path) {
            Ok(()) => {
                downloaded = true;
                emit_log(
                    window,
                    "info",
                    &format!("JDK download succeeded from {}", source.name),
                );
                break;
            }
            Err(err) => {
                source_errors.push(format!("{} => {}", source.name, err));
                emit_log(
                    window,
                    "stderr",
                    &format!(
                        "JDK source {} failed: {}. Switching to next source...",
                        source.name, err
                    ),
                );
                let _ = fs::remove_file(&archive_path);
            }
        }
    }

    if !downloaded {
        let merged_error = format!(
            "Failed downloading JDK archive from all sources: {}",
            source_errors.join(" | ")
        );
        emit_log(window, "stderr", &merged_error);
        return Err(merged_error);
    }

    emit_log(
        window,
        "info",
        &format!("Extracting JDK archive {}", archive_path.to_string_lossy()),
    );
    if cfg!(windows) {
        extract_zip(&archive_path, runtime_root)
            .map_err(|e| format!("Failed extracting JDK zip: {e}"))?;
    } else {
        extract_tar_gz(&archive_path, runtime_root)
            .map_err(|e| format!("Failed extracting JDK tar.gz: {e}"))?;
    }
    let _ = fs::remove_file(&archive_path);

    locate_java_binary(runtime_root)
        .ok_or_else(|| "JDK extracted but java executable not found".to_string())
}

#[cfg(windows)]
fn apply_windows_silent_spawn(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_windows_silent_spawn(_command: &mut Command) {}

fn pump_game_stream<R: Read + Send + 'static>(
    stream: R,
    window: tauri::Window,
    level: &'static str,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buffer)
                        .trim_end_matches(['\r', '\n'])
                        .to_string();
                    if line.is_empty() {
                        continue;
                    }
                    let line_for_emit = line.clone();
                    let _ = window.emit(
                        "game-log",
                        CoreLogEvent {
                            level: level.to_string(),
                            message: line_for_emit,
                        },
                    );
                    push_ui_log("game", level, &line);
                }
                Err(_) => break,
            }
        }
    })
}

#[tauri::command]
async fn list_fabric_loaders(
    window: tauri::Window,
    game_version: String,
    download_source: Option<String>,
) -> Result<Vec<String>, String> {
    list_fabric_loaders_blocking_core(
        Some(&window),
        game_version.trim(),
        download_source.as_deref(),
    )
}

fn list_fabric_loaders_blocking_core(
    window: Option<&tauri::Window>,
    game_version: &str,
    download_source: Option<&str>,
) -> Result<Vec<String>, String> {
    let normalized_game_version = game_version.trim();
    if normalized_game_version.is_empty() {
        return Err("Game version cannot be empty".to_string());
    }
    let command = vec![
        "list-fabric-loaders".to_string(),
        "--game-version".to_string(),
        normalized_game_version.to_string(),
    ];
    let mut command = command;
    push_download_source_arg(&mut command, download_source);
    let refs: Vec<&str> = command.iter().map(String::as_str).collect();
    let output = run_java_core(window, &refs)?;
    serde_json::from_str::<Vec<String>>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
async fn install_fabric(
    window: tauri::Window,
    game_dir: String,
    game_version: String,
    loader_version: String,
    download_source: Option<String>,
    ipc_session: Option<String>,
) -> Result<FabricInstallResult, String> {
    let game_dir = resolve_game_dir_path(&game_dir)?
        .to_string_lossy()
        .to_string();
    let mut command = vec![
        "install-fabric".to_string(),
        "--game-dir".to_string(),
        game_dir,
        "--game-version".to_string(),
        game_version,
        "--loader-version".to_string(),
        loader_version,
    ];
    push_download_source_arg(&mut command, download_source.as_deref());
    if let Some(session) = ipc_session {
        if !session.trim().is_empty() {
            command.push("--ipc-session".to_string());
            command.push(session);
        }
    }
    let output = run_java_core_async(Some(window), command).await?;
    serde_json::from_str::<FabricInstallResult>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

fn install_fabric_blocking_core(
    window: Option<&tauri::Window>,
    game_dir: &Path,
    game_version: &str,
    loader_version: &str,
    download_source: Option<&str>,
) -> Result<FabricInstallResult, String> {
    let normalized_game_version = game_version.trim();
    if normalized_game_version.is_empty() {
        return Err("Game version cannot be empty".to_string());
    }
    let normalized_loader_version = loader_version.trim();
    if normalized_loader_version.is_empty() {
        return Err("Loader version cannot be empty".to_string());
    }
    let command = vec![
        "install-fabric".to_string(),
        "--game-dir".to_string(),
        strip_windows_verbatim_prefix(game_dir)
            .to_string_lossy()
            .to_string(),
        "--game-version".to_string(),
        normalized_game_version.to_string(),
        "--loader-version".to_string(),
        normalized_loader_version.to_string(),
    ];
    let mut command = command;
    push_download_source_arg(&mut command, download_source);
    let refs: Vec<&str> = command.iter().map(String::as_str).collect();
    let output = run_java_core(window, &refs)?;
    serde_json::from_str::<FabricInstallResult>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
async fn list_forge_versions(
    window: tauri::Window,
    game_version: String,
    download_source: Option<String>,
) -> Result<Vec<String>, String> {
    list_forge_versions_blocking_core(
        Some(&window),
        game_version.trim(),
        download_source.as_deref(),
    )
}

fn list_forge_versions_blocking_core(
    window: Option<&tauri::Window>,
    game_version: &str,
    download_source: Option<&str>,
) -> Result<Vec<String>, String> {
    let normalized_game_version = game_version.trim();
    if normalized_game_version.is_empty() {
        return Err("Game version cannot be empty".to_string());
    }
    let command = vec![
        "list-forge-versions".to_string(),
        "--game-version".to_string(),
        normalized_game_version.to_string(),
    ];
    let mut command = command;
    push_download_source_arg(&mut command, download_source);
    let refs: Vec<&str> = command.iter().map(String::as_str).collect();
    let output = run_java_core(window, &refs)?;
    serde_json::from_str::<Vec<String>>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
async fn install_forge(
    window: tauri::Window,
    game_dir: String,
    forge_version: String,
    java_path: Option<String>,
    download_source: Option<String>,
    ipc_session: Option<String>,
) -> Result<ForgeInstallResult, String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let java_exe = match java_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => ensure_managed_jdk_runtime(
            Some(&window),
            &managed_jdk_runtime_root(&game_dir_path, 17),
            17,
        )?
        .to_string_lossy()
        .to_string(),
    };
    let game_dir = game_dir_path.to_string_lossy().to_string();
    let mut command = vec![
        "install-forge".to_string(),
        "--game-dir".to_string(),
        game_dir,
        "--forge-version".to_string(),
        forge_version,
        "--java".to_string(),
        java_exe,
    ];
    push_download_source_arg(&mut command, download_source.as_deref());
    if let Some(session) = ipc_session {
        if !session.trim().is_empty() {
            command.push("--ipc-session".to_string());
            command.push(session);
        }
    }
    let output = run_java_core_async(Some(window), command).await?;
    serde_json::from_str::<ForgeInstallResult>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

fn install_forge_blocking_core(
    window: Option<&tauri::Window>,
    game_dir: &Path,
    forge_version: &str,
    java_path: &str,
    download_source: Option<&str>,
) -> Result<ForgeInstallResult, String> {
    let normalized_forge_version = forge_version.trim();
    if normalized_forge_version.is_empty() {
        return Err("Forge version cannot be empty".to_string());
    }
    let normalized_java = if java_path.trim().is_empty() {
        "java"
    } else {
        java_path.trim()
    };
    let command = vec![
        "install-forge".to_string(),
        "--game-dir".to_string(),
        strip_windows_verbatim_prefix(game_dir)
            .to_string_lossy()
            .to_string(),
        "--forge-version".to_string(),
        normalized_forge_version.to_string(),
        "--java".to_string(),
        normalized_java.to_string(),
    ];
    let mut command = command;
    push_download_source_arg(&mut command, download_source);
    let refs: Vec<&str> = command.iter().map(String::as_str).collect();
    let output = run_java_core(window, &refs)?;
    serde_json::from_str::<ForgeInstallResult>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

async fn run_java_core_async(
    window: Option<tauri::Window>,
    args: Vec<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_java_core(window.as_ref(), &refs)
    })
    .await
    .map_err(|e| format!("Failed to join java-core task: {e}"))?
}

fn run_java_core(window: Option<&tauri::Window>, args: &[&str]) -> Result<String, String> {
    let jar = java_core_jar_path()?;
    let java_executable = resolve_java_core_executable(window, args)?;
    let mut full_args: Vec<String> = vec!["-jar".to_string(), jar.to_string_lossy().to_string()];
    full_args.extend(args.iter().map(|x| (*x).to_string()));
    let command_preview =
        format_quoted_command(java_executable.to_string_lossy().as_ref(), &full_args);
    emit_log(window, "info", &format!("run: {command_preview}"));

    let mut java_cmd =
        build_platform_command(java_executable.to_string_lossy().as_ref(), &full_args, None);
    let mut child = java_cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run java core: {e}"))?;

    let log_tailer_stop = start_core_latest_log_tailer(window.cloned(), args);

    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture java-core stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture java-core stderr".to_string())?;

    let stdout_buf_clone = Arc::clone(&stdout_buf);
    let window_for_stdout = window.cloned();
    let stdout_reader_handle = thread::spawn(move || -> Result<(), String> {
        pump_core_stream(
            stdout,
            stdout_buf_clone,
            window_for_stdout,
            "core-log",
            "stdout",
        )
    });

    let stderr_buf_clone = Arc::clone(&stderr_buf);
    let window_for_stderr = window.cloned();
    let stderr_reader_handle = thread::spawn(move || -> Result<(), String> {
        pump_core_stream(
            stderr,
            stderr_buf_clone,
            window_for_stderr,
            "core-log",
            "stderr",
        )
    });

    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting java core: {e}"))?;

    if let Some(stop) = log_tailer_stop {
        stop.store(true, Ordering::Relaxed);
    }

    stdout_reader_handle
        .join()
        .map_err(|_| "Failed joining stdout thread".to_string())??;
    stderr_reader_handle
        .join()
        .map_err(|_| "Failed joining stderr thread".to_string())??;

    let stdout_text = stdout_buf
        .lock()
        .map_err(|_| "Failed to lock stdout buffer after completion".to_string())?
        .trim()
        .to_string();
    let stderr_text = stderr_buf
        .lock()
        .map_err(|_| "Failed to lock stderr buffer after completion".to_string())?
        .trim()
        .to_string();

    if !status.success() {
        if let Some(ipc_error) = extract_install_ipc_error(&stderr_text) {
            return Err(ipc_error);
        }
        let concise = summarize_command_failure(&stdout_text, &stderr_text);
        return Err(format!(
            "java-core command failed. shell={}; command={command_preview}; error={concise}",
            "direct",
        ));
    }

    emit_log(window, "info", "java-core command completed");
    Ok(stdout_text)
}

fn extract_install_ipc_error(stderr_text: &str) -> Option<String> {
    for line in stderr_text.lines().rev() {
        let Some(payload) = line.strip_prefix("[ipc]") else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload.trim()) else {
            continue;
        };
        if value.get("channel").and_then(|v| v.as_str()) != Some("install") {
            continue;
        }
        if value.get("event").and_then(|v| v.as_str()) != Some("error") {
            continue;
        }
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            let trimmed = error.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(message) = value.get("message").and_then(|v| v.as_str()) {
            let trimmed = message.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn summarize_command_failure(stdout: &str, stderr: &str) -> String {
    let mut candidates: Vec<String> = Vec::new();
    if !stderr.trim().is_empty() {
        candidates.extend(stderr.lines().filter_map(normalize_error_line));
    }
    if !stdout.trim().is_empty() {
        candidates.extend(stdout.lines().filter_map(normalize_error_line));
    }

    for candidate in candidates.iter().rev() {
        if is_useful_error_line(candidate) {
            return candidate.clone();
        }
    }

    candidates
        .into_iter()
        .rev()
        .find(|line| !line.is_empty())
        .unwrap_or_else(|| "Unknown java-core failure".to_string())
}

fn normalize_error_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("[ipc]") {
        return None;
    }
    if trimmed.starts_with("[launcher-core]") {
        if let Some(idx) = trimmed.rfind(']') {
            let msg = trimmed[idx + 1..].trim();
            if !msg.is_empty() {
                return Some(msg.to_string());
            }
        }
    }
    Some(trimmed.to_string())
}

fn is_useful_error_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("download failed")
        || lower.contains("sha1 mismatch")
        || lower.contains("connection reset")
        || lower.contains("exception")
        || lower.contains("failed")
        || lower.contains("error")
}

fn start_core_latest_log_tailer(
    window: Option<tauri::Window>,
    args: &[&str],
) -> Option<Arc<AtomicBool>> {
    if window.is_none() || args.is_empty() || args[0] != "launch-vanilla" {
        return None;
    }

    let mut game_dir: Option<String> = None;
    let mut i = 1;
    while i + 1 < args.len() {
        if args[i] == "--game-dir" {
            game_dir = Some(args[i + 1].to_string());
            break;
        }
        i += 1;
    }

    let game_dir = game_dir?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let target_window = window?;

    thread::spawn(move || {
        let latest_log = Path::new(&game_dir).join("logs").join("latest.log");
        let mut offset: u64 = 0;

        while !stop_flag.load(Ordering::Relaxed) {
            if let Ok(mut file) = fs::File::open(&latest_log) {
                if let Ok(meta) = file.metadata() {
                    if meta.len() < offset {
                        offset = 0;
                    }
                }

                if file.seek(SeekFrom::Start(offset)).is_ok() {
                    let mut reader = BufReader::new(file);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Ok(_) => {
                                let content = line.trim_end_matches(['\r', '\n']);
                                if !content.is_empty() {
                                    let message = format!("[launcher-core][latest.log] {content}");
                                    let _ = target_window.emit(
                                        "core-log",
                                        CoreLogEvent {
                                            level: "latest-log".to_string(),
                                            message: message.clone(),
                                        },
                                    );
                                    push_ui_log("core", "latest-log", &message);
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    if let Ok(pos) = reader.stream_position() {
                        offset = pos;
                    }
                }
            }

            thread::sleep(Duration::from_millis(300));
        }
    });

    Some(stop)
}

fn pump_core_stream<R: Read>(
    stream: R,
    sink: Arc<Mutex<String>>,
    window: Option<tauri::Window>,
    event_name: &'static str,
    level: &str,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::new();

    loop {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }

        let line = String::from_utf8_lossy(&buffer)
            .trim_end_matches(['\r', '\n'])
            .to_string();
        if line.is_empty() {
            continue;
        }

        {
            let mut buf = sink
                .lock()
                .map_err(|_| "Failed to lock stream buffer".to_string())?;
            buf.push_str(&line);
            buf.push('\n');
        }

        if let Some(ref target_window) = window {
            let line_for_emit = line.clone();
            let _ = target_window.emit(
                event_name,
                CoreLogEvent {
                    level: level.to_string(),
                    message: line_for_emit,
                },
            );
        }
        push_ui_log("core", level, &line);
    }

    Ok(())
}

fn emit_log(window: Option<&tauri::Window>, level: &str, message: &str) {
    push_ui_log("core", level, message);
    if let Some(target_window) = window {
        let _ = target_window.emit(
            "core-log",
            CoreLogEvent {
                level: level.to_string(),
                message: message.to_string(),
            },
        );
    }
}

fn java_core_jar_path() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Some(resource_jar) = JAVA_CORE_RESOURCE_JAR.get() {
        candidates.push(resource_jar.clone());
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.extend([
                exe_dir.join("resources").join("java").join("java-core.jar"),
                exe_dir.join("java").join("java-core.jar"),
                exe_dir
                    .join("src-tauri")
                    .join("resources")
                    .join("java")
                    .join("java-core.jar"),
            ]);
        }
    }

    candidates.extend([
        PathBuf::from("src-tauri/resources/java/java-core.jar"),
        PathBuf::from("./src-tauri/resources/java/java-core.jar"),
        PathBuf::from("../java-core/build/libs/fpsmaster-launcher-core-0.1.0-all.jar"),
        PathBuf::from("../java-core/build/libs/fpsmaster-launcher-core-0.1.0.jar"),
        PathBuf::from("../../java-core/build/libs/fpsmaster-launcher-core-0.1.0-all.jar"),
        PathBuf::from("../../java-core/build/libs/fpsmaster-launcher-core-0.1.0.jar"),
    ]);

    for candidate in candidates {
        if candidate.exists() {
            return candidate
                .absolutize()
                .map_err(|e| format!("Failed to resolve java-core jar path: {e}"))
                .map(|p| strip_windows_verbatim_prefix(p.as_ref()));
        }
    }

    Err(
        "java-core jar not found. Run `npm run prepare:java-core` or build the installer so Tauri bundles `java-core.jar` automatically."
            .to_string(),
    )
}

trait Absolutize {
    fn absolutize(&self) -> Result<PathBuf, std::io::Error>;
}

impl Absolutize for PathBuf {
    fn absolutize(&self) -> Result<PathBuf, std::io::Error> {
        if self.is_absolute() {
            return Ok(self.clone());
        }
        std::env::current_dir().map(|cwd| cwd.join(self))
    }
}

fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if cfg!(windows) {
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path.to_path_buf()
}

#[derive(Debug, Clone)]
struct JdkDownloadSource {
    name: String,
    url: String,
}

fn jdk_download_sources(major: i32) -> Vec<JdkDownloadSource> {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    };

    let arch = match env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        other => {
            if other.contains("64") {
                "x64"
            } else {
                "x32"
            }
        }
    };

    let package = "jdk";
    let archive_ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let mut sources = vec![
        JdkDownloadSource {
            name: "Eclipse Temurin (Adoptium)".to_string(),
            url: format!(
                "https://api.adoptium.net/v3/binary/latest/{major}/ga/{os}/{arch}/{package}/hotspot/normal/eclipse"
            ),
        },
        JdkDownloadSource {
            name: "Amazon Corretto".to_string(),
            url: format!(
                "https://corretto.aws/downloads/latest/amazon-corretto-{major}-{arch}-{os}-{package}.{archive_ext}"
            ),
        },
    ];

    if major >= 11 {
        let microsoft_os = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macOS"
        } else {
            "linux"
        };
        let microsoft_arch = if arch == "x64" { "x64" } else { "aarch64" };
        let microsoft_ext = if cfg!(windows) { "zip" } else { "tar.gz" };
        sources.push(JdkDownloadSource {
            name: "Microsoft Build of OpenJDK".to_string(),
            url: format!(
                "https://aka.ms/download-jdk/microsoft-jdk-{major}-{microsoft_os}-{microsoft_arch}.{microsoft_ext}"
            ),
        });
    }

    sources
}

fn download_file_blocking(
    window: Option<&tauri::Window>,
    source_name: &str,
    url: &str,
    target: &Path,
) -> Result<(), String> {
    const JDK_DOWNLOAD_USER_AGENT: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FPSMasterLauncher/0.1 (+https://github.com/fpsmaster)";

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent(JDK_DOWNLOAD_USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(60 * 30))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_error = String::new();
    for attempt in 1..=3 {
        let tmp = target.with_extension("download");
        let mut response = match client
            .get(url)
            .header(reqwest::header::USER_AGENT, JDK_DOWNLOAD_USER_AGENT)
            .header(reqwest::header::ACCEPT, "*/*")
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
        {
            Ok(resp) => resp,
            Err(err) => {
                last_error = err.to_string();
                emit_log(
                    window,
                    "stderr",
                    &format!(
                        "JDK download ({source_name}) attempt {attempt}/3 request failed: {last_error}"
                    ),
                );
                continue;
            }
        };

        if !response.status().is_success() {
            last_error = format!("HTTP {}", response.status());
            emit_log(
                window,
                "stderr",
                &format!("JDK download ({source_name}) attempt {attempt}/3 failed: {last_error}"),
            );
            continue;
        }

        let total = response.content_length();
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut downloaded: u64 = 0;
        let mut buffer = [0_u8; 64 * 1024];
        let mut last_percent = 0_u64;

        loop {
            let read = response.read(&mut buffer).map_err(|e| {
                format!(
                    "attempt {attempt}/3 read failed after {} bytes: {e}",
                    downloaded
                )
            });

            let read = match read {
                Ok(value) => value,
                Err(err) => {
                    last_error = err;
                    emit_log(
                        window,
                        "stderr",
                        &format!("JDK download ({source_name}) {last_error}"),
                    );
                    let _ = fs::remove_file(&tmp);
                    break;
                }
            };

            if read == 0 {
                file.flush().map_err(|e| e.to_string())?;
                fs::rename(&tmp, target).map_err(|e| e.to_string())?;
                emit_log(window, "info", "JDK download progress: 100%");
                return Ok(());
            }

            file.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
            downloaded += read as u64;

            if let Some(total_size) = total {
                if total_size > 0 {
                    let percent = downloaded.saturating_mul(100) / total_size;
                    if percent >= last_percent + 2 || percent == 100 {
                        last_percent = percent;
                        emit_log(
                            window,
                            "info",
                            &format!("JDK download progress: {percent}% ({downloaded}/{total_size} bytes)"),
                        );
                    }
                }
            } else if downloaded % (1024 * 1024) < 64 * 1024 {
                emit_log(
                    window,
                    "info",
                    &format!("JDK download progress: {downloaded} bytes"),
                );
            }
        }
    }

    emit_log(
        window,
        "stderr",
        &format!("JDK download ({source_name}) failed after 3 attempts: {last_error}"),
    );
    Err(last_error)
}

fn resolve_minecraft_auth_config_status() -> MinecraftAuthConfigStatus {
    match resolve_minecraft_client_id() {
        Ok((_, source)) => MinecraftAuthConfigStatus {
            configured: true,
            client_id_source: Some(source),
            configuration_hint: None,
        },
        Err(_) => MinecraftAuthConfigStatus {
            configured: false,
            client_id_source: None,
            configuration_hint: Some(minecraft_auth_configuration_hint()),
        },
    }
}

fn start_minecraft_device_login_blocking() -> Result<MinecraftDeviceLoginStart, String> {
    let (client_id, _) = resolve_minecraft_client_id()?;
    let client = build_minecraft_auth_http_client()?;
    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scope", MINECRAFT_MICROSOFT_SCOPE),
        ])
        .send()
        .map_err(|e| format!("Failed to start Microsoft device login: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Microsoft device login response: {e}"))?;
    if !status.is_success() {
        return Err(parse_microsoft_error_response(
            status,
            &text,
            "Failed to start Microsoft device login",
        ));
    }
    let payload: MicrosoftDeviceCodeResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to decode Microsoft device login response: {e}"))?;
    let interval = payload.interval.unwrap_or(5).max(1);
    Ok(MinecraftDeviceLoginStart {
        device_code: payload.device_code,
        user_code: payload.user_code,
        verification_uri: payload.verification_uri,
        verification_uri_complete: payload.verification_uri_complete,
        expires_in: payload.expires_in,
        expires_at: unix_timestamp_millis().saturating_add(
            i64::try_from(payload.expires_in.saturating_mul(1000)).unwrap_or(i64::MAX),
        ),
        interval,
        message: payload.message,
    })
}

fn start_minecraft_browser_login_blocking(app: AppHandle) -> Result<MinecraftAccountPayload, String> {
    let (client_id, _) = resolve_minecraft_client_id()?;
    let redirect_url = resolve_minecraft_redirect_url()?;
    let client = build_minecraft_auth_http_client()?;
    let state = create_oauth_random_token(24);
    let code_verifier = create_oauth_random_token(64);
    let code_challenge = create_pkce_code_challenge(&code_verifier);

    let listener = bind_minecraft_redirect_listener(&redirect_url)?;
    let authorize_url = build_minecraft_authorize_url(
        &client_id,
        &redirect_url,
        &state,
        &code_challenge,
    )?;

    let auth_window_label = format!("minecraft-auth-{}", create_oauth_random_token(8));
    let auth_window_data_dir =
        open_minecraft_auth_window(&app, &auth_window_label, authorize_url.as_str())?;
    let code = match wait_for_minecraft_oauth_callback(
        listener,
        &redirect_url,
        &state,
        &app,
        &auth_window_label,
    ) {
        Ok(code) => {
            close_auth_window(&app, &auth_window_label, Some(&auth_window_data_dir));
            code
        }
        Err(error) => {
            close_auth_window(&app, &auth_window_label, Some(&auth_window_data_dir));
            return Err(error);
        }
    };

    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", redirect_url.as_str()),
            ("code_verifier", code_verifier.as_str()),
            ("scope", MINECRAFT_MICROSOFT_SCOPE),
        ])
        .send()
        .map_err(|e| format!("Failed to exchange Microsoft authorization code: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Microsoft authorization response: {e}"))?;
    if !status.is_success() {
        close_auth_window(&app, &auth_window_label, Some(&auth_window_data_dir));
        return Err(parse_microsoft_error_response(
            status,
            &text,
            "Microsoft browser login failed",
        ));
    }
    let token: MicrosoftTokenSuccessResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to decode Microsoft authorization response: {e}"))?;
    let result = complete_minecraft_microsoft_account(&client, token.access_token, token.refresh_token);
    close_auth_window(&app, &auth_window_label, Some(&auth_window_data_dir));
    result
}

fn poll_minecraft_device_login_blocking(
    device_code: String,
) -> Result<MinecraftDeviceLoginPollResult, String> {
    let trimmed_device_code = device_code.trim().to_string();
    if trimmed_device_code.is_empty() {
        return Err("Minecraft device code is empty".to_string());
    }
    let (client_id, _) = resolve_minecraft_client_id()?;
    let client = build_minecraft_auth_http_client()?;
    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id.as_str()),
            ("device_code", trimmed_device_code.as_str()),
        ])
        .send()
        .map_err(|e| format!("Failed to poll Microsoft device login: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Microsoft token response: {e}"))?;
    if status.is_success() {
        let token: MicrosoftTokenSuccessResponse = serde_json::from_str(&text)
            .map_err(|e| format!("Failed to decode Microsoft token response: {e}"))?;
        let account = complete_minecraft_microsoft_account(
            &client,
            token.access_token,
            token.refresh_token,
        )?;
        return Ok(MinecraftDeviceLoginPollResult {
            status: "completed".to_string(),
            interval: None,
            account: Some(account),
            error: None,
        });
    }

    let error_response: MicrosoftTokenErrorResponse = serde_json::from_str(&text).map_err(|e| {
        format!(
            "{} ({e})",
            parse_microsoft_error_response(status, &text, "Failed to poll Microsoft device login")
        )
    })?;
    let error_code = error_response.error.trim().to_ascii_lowercase();
    let error_text = normalize_microsoft_error_description(
        error_response.error_description.as_deref(),
        "Microsoft device login has not completed yet.",
    );
    match error_code.as_str() {
        "authorization_pending" => Ok(MinecraftDeviceLoginPollResult {
            status: "pending".to_string(),
            interval: Some(5),
            account: None,
            error: Some(error_text),
        }),
        "slow_down" => Ok(MinecraftDeviceLoginPollResult {
            status: "slow_down".to_string(),
            interval: Some(8),
            account: None,
            error: Some(error_text),
        }),
        "authorization_declined" | "access_denied" => Ok(MinecraftDeviceLoginPollResult {
            status: "denied".to_string(),
            interval: None,
            account: None,
            error: Some(normalize_microsoft_error_description(
                error_response.error_description.as_deref(),
                "Microsoft device login was cancelled.",
            )),
        }),
        "expired_token" | "bad_verification_code" => Ok(MinecraftDeviceLoginPollResult {
            status: "expired".to_string(),
            interval: None,
            account: None,
            error: Some(normalize_microsoft_error_description(
                error_response.error_description.as_deref(),
                "Microsoft device login code expired. Please start again.",
            )),
        }),
        _ => Err(format!(
            "Microsoft device login failed: {}",
            normalize_microsoft_error_description(
                error_response.error_description.as_deref(),
                &error_response.error
            )
        )),
    }
}

fn refresh_minecraft_account_blocking(
    refresh_token: String,
) -> Result<MinecraftAccountPayload, String> {
    let trimmed_refresh_token = refresh_token.trim().to_string();
    if trimmed_refresh_token.is_empty() {
        return Err("Minecraft refresh token is empty".to_string());
    }
    let (client_id, _) = resolve_minecraft_client_id()?;
    let client = build_minecraft_auth_http_client()?;
    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", trimmed_refresh_token.as_str()),
            ("scope", MINECRAFT_MICROSOFT_SCOPE),
        ])
        .send()
        .map_err(|e| format!("Failed to refresh Microsoft login: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Microsoft refresh response: {e}"))?;
    if !status.is_success() {
        let fallback = "Microsoft premium account refresh failed. Please sign in again.";
        let error = serde_json::from_str::<MicrosoftTokenErrorResponse>(&text)
            .ok()
            .map(|value| {
                normalize_microsoft_error_description(value.error_description.as_deref(), fallback)
            })
            .unwrap_or_else(|| parse_microsoft_error_response(status, &text, fallback));
        return Err(error);
    }
    let token: MicrosoftTokenSuccessResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to decode Microsoft refresh response: {e}"))?;
    complete_minecraft_microsoft_account(
        &client,
        token.access_token,
        token.refresh_token.or(Some(trimmed_refresh_token)),
    )
}

fn complete_minecraft_microsoft_account(
    client: &reqwest::blocking::Client,
    microsoft_access_token: String,
    refresh_token: Option<String>,
) -> Result<MinecraftAccountPayload, String> {
    let xbox_response = client
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .json(&serde_json::json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={microsoft_access_token}"),
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT",
        }))
        .send()
        .map_err(|e| format!("Failed to authenticate with Xbox Live: {e}"))?;
    let xbox_status = xbox_response.status();
    let xbox_text = xbox_response
        .text()
        .map_err(|e| format!("Failed to read Xbox Live authentication response: {e}"))?;
    if !xbox_status.is_success() {
        return Err(parse_microsoft_error_response(
            xbox_status,
            &xbox_text,
            "Xbox Live authentication failed",
        ));
    }
    let xbox_payload: XboxAuthResponse = serde_json::from_str(&xbox_text)
        .map_err(|e| format!("Failed to decode Xbox Live authentication response: {e}"))?;
    let xbox_user = xbox_payload
        .display_claims
        .users
        .into_iter()
        .next()
        .ok_or_else(|| "Xbox Live authentication response did not include a user hash".to_string())?;
    let user_hash = xbox_user
        .uhs
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Xbox Live authentication response did not include a user hash".to_string())?;

    let xsts_response = client
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .json(&serde_json::json!({
            "Properties": {
                "SandboxId": "RETAIL",
                "UserTokens": [xbox_payload.token],
            },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT",
        }))
        .send()
        .map_err(|e| format!("Failed to authorize XSTS token: {e}"))?;
    let xsts_status = xsts_response.status();
    let xsts_text = xsts_response
        .text()
        .map_err(|e| format!("Failed to read XSTS response: {e}"))?;
    if !xsts_status.is_success() {
        return Err(parse_microsoft_error_response(
            xsts_status,
            &xsts_text,
            "Minecraft premium account is not eligible for Xbox authorization",
        ));
    }
    let xsts_payload: XboxAuthResponse = serde_json::from_str(&xsts_text)
        .map_err(|e| format!("Failed to decode XSTS response: {e}"))?;
    let xsts_user = xsts_payload
        .display_claims
        .users
        .into_iter()
        .next()
        .unwrap_or(XboxUserClaim {
            uhs: Some(user_hash.clone()),
            xid: None,
        });

    let minecraft_login_response = client
        .post("https://api.minecraftservices.com/authentication/login_with_xbox")
        .json(&serde_json::json!({
            "identityToken": format!("XBL3.0 x={};{}", user_hash, xsts_payload.token),
        }))
        .send()
        .map_err(|e| format!("Failed to sign in to Minecraft Services: {e}"))?;
    let minecraft_login_status = minecraft_login_response.status();
    let minecraft_login_text = minecraft_login_response
        .text()
        .map_err(|e| format!("Failed to read Minecraft Services login response: {e}"))?;
    if !minecraft_login_status.is_success() {
        return Err(parse_microsoft_error_response(
            minecraft_login_status,
            &minecraft_login_text,
            "Minecraft Services login failed",
        ));
    }
    let minecraft_login_payload: MinecraftLoginResponse = serde_json::from_str(&minecraft_login_text)
        .map_err(|e| format!("Failed to decode Minecraft Services login response: {e}"))?;

    let entitlements_response = client
        .get("https://api.minecraftservices.com/entitlements/mcstore")
        .bearer_auth(&minecraft_login_payload.access_token)
        .send()
        .map_err(|e| format!("Failed to fetch Minecraft entitlements: {e}"))?;
    let entitlements_status = entitlements_response.status();
    let entitlements_text = entitlements_response
        .text()
        .map_err(|e| format!("Failed to read Minecraft entitlements response: {e}"))?;
    if !entitlements_status.is_success() {
        let fallback = if entitlements_status.as_u16() == 403 {
            "Minecraft Services API access was denied. Make sure this Azure app has been granted Minecraft API access."
        } else {
            "Failed to fetch Minecraft entitlements"
        };
        return Err(parse_microsoft_error_response(
            entitlements_status,
            &entitlements_text,
            fallback,
        ));
    }
    let entitlements_payload: MinecraftEntitlementsResponse = serde_json::from_str(&entitlements_text)
        .map_err(|e| format!("Failed to decode Minecraft entitlements response: {e}"))?;
    let has_minecraft_license = entitlements_payload.items.iter().any(|item| {
        let name = item.name.trim();
        name.eq_ignore_ascii_case("product_minecraft") || name.eq_ignore_ascii_case("game_minecraft")
    });
    if !has_minecraft_license {
        return Err(
            "This Microsoft account does not own Minecraft Java Edition, or its entitlement is unavailable."
                .to_string(),
        );
    }

    let profile_response = client
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(&minecraft_login_payload.access_token)
        .send()
        .map_err(|e| format!("Failed to fetch Minecraft profile: {e}"))?;
    let profile_status = profile_response.status();
    let profile_text = profile_response
        .text()
        .map_err(|e| format!("Failed to read Minecraft profile response: {e}"))?;
    if !profile_status.is_success() {
        let fallback = match profile_status.as_u16() {
            403 => {
                "Minecraft Services API access was denied. Make sure this Azure app has been granted Minecraft API access."
            }
            404 => "This Microsoft account does not have a Minecraft Java Edition profile yet.",
            _ => "Failed to fetch Minecraft profile",
        };
        return Err(parse_microsoft_error_response(profile_status, &profile_text, fallback));
    }
    let profile_payload: MinecraftProfileResponse = serde_json::from_str(&profile_text)
        .map_err(|e| format!("Failed to decode Minecraft profile response: {e}"))?;
    let now = unix_timestamp_millis();
    let expires_at = now.saturating_add(
        i64::try_from(minecraft_login_payload.expires_in.saturating_mul(1000))
            .unwrap_or(i64::MAX),
    );
    Ok(MinecraftAccountPayload {
        id: create_microsoft_account_id(&profile_payload.id),
        account_type: "microsoft".to_string(),
        username: profile_payload.name,
        uuid: profile_payload.id,
        access_token: minecraft_login_payload.access_token,
        refresh_token,
        xuid: xsts_user.xid.filter(|value| !value.trim().is_empty()),
        expires_at,
        added_at: now,
    })
}

fn resolve_minecraft_redirect_url() -> Result<String, String> {
    if let Some(value) = read_runtime_env("FPSMASTER_MINECRAFT_REDIRECT_URL") {
        return validate_minecraft_redirect_url(&value);
    }
    if let Some(value) = read_runtime_env("MICROSOFT_REDIRECT_URL") {
        return validate_minecraft_redirect_url(&value);
    }
    if let Some(value) = option_env!("FPSMASTER_MINECRAFT_REDIRECT_URL")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return validate_minecraft_redirect_url(value);
    }
    if let Some(value) = option_env!("MICROSOFT_REDIRECT_URL")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return validate_minecraft_redirect_url(value);
    }
    validate_minecraft_redirect_url(DEFAULT_MINECRAFT_MICROSOFT_REDIRECT_URL)
}

fn validate_minecraft_redirect_url(raw: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(raw.trim())
        .map_err(|e| format!("Invalid Minecraft redirect URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Minecraft redirect URL must use http or https".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("Minecraft redirect URL must include a host".to_string());
    }
    Ok(parsed.to_string())
}

fn bind_minecraft_redirect_listener(redirect_url: &str) -> Result<TcpListener, String> {
    let parsed = reqwest::Url::parse(redirect_url)
        .map_err(|e| format!("Invalid Minecraft redirect URL: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Minecraft redirect URL is missing host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "Minecraft redirect URL is missing port".to_string())?;
    let bind_target = format!("{host}:{port}");
    let listener = TcpListener::bind(&bind_target)
        .map_err(|e| format!("Failed to bind Minecraft OAuth redirect listener on {bind_target}: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to configure Minecraft OAuth redirect listener: {e}"))?;
    Ok(listener)
}

fn build_minecraft_authorize_url(
    client_id: &str,
    redirect_url: &str,
    state: &str,
    code_challenge: &str,
) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize")
        .map_err(|e| format!("Failed to prepare Microsoft authorize URL: {e}"))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_url)
        .append_pair("response_mode", "query")
        .append_pair("scope", MINECRAFT_MICROSOFT_SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url)
}

fn wait_for_minecraft_oauth_callback(
    listener: TcpListener,
    redirect_url: &str,
    expected_state: &str,
    app: &AppHandle,
    auth_window_label: &str,
) -> Result<String, String> {
    let redirect_base = reqwest::Url::parse(redirect_url)
        .map_err(|e| format!("Invalid Minecraft redirect URL: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        if app.get_webview_window(auth_window_label).is_none() {
            return Err("Microsoft login window was closed before authentication completed.".to_string());
        }
        if Instant::now() >= deadline {
            return Err("Timed out waiting for Microsoft browser login callback".to_string());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut request_line = String::new();
                {
                    let mut reader = BufReader::new(&mut stream);
                    reader
                        .read_line(&mut request_line)
                        .map_err(|e| format!("Failed to read Microsoft OAuth callback request: {e}"))?;
                }
                let path = request_line
                    .split_whitespace()
                    .nth(1)
                    .ok_or_else(|| "Microsoft OAuth callback request line is invalid".to_string())?;
                let callback_url = reqwest::Url::parse(&format!(
                    "{}://{}{}",
                    redirect_base.scheme(),
                    redirect_base
                        .host_str()
                        .ok_or_else(|| "Minecraft redirect URL is missing host".to_string())?,
                    if let Some(port) = redirect_base.port() {
                        format!(":{port}{path}")
                    } else {
                        path.to_string()
                    }
                ))
                    .or_else(|_| reqwest::Url::parse(&format!("http://callback{path}")))
                    .map_err(|e| format!("Failed to parse Microsoft OAuth callback URL: {e}"))?;

                let query: HashMap<String, String> = callback_url.query_pairs().into_owned().collect();
                if let Some(error) = query.get("error") {
                    let description = query
                        .get("error_description")
                        .map(String::as_str)
                        .unwrap_or(error);
                    let message = normalize_microsoft_error_description(
                        Some(description),
                        "Microsoft login was cancelled.",
                    );
                    let _ = write_browser_callback_page(
                        &mut stream,
                        400,
                        "Microsoft login failed",
                        &message,
                    );
                    return Err(message);
                }
                let returned_state = query
                    .get("state")
                    .map(String::as_str)
                    .unwrap_or_default();
                if returned_state != expected_state {
                    let message = "Microsoft login callback state did not match the launcher session.";
                    let _ = write_browser_callback_page(
                        &mut stream,
                        400,
                        "Microsoft login failed",
                        message,
                    );
                    return Err(message.to_string());
                }
                let code = query
                    .get("code")
                    .cloned()
                    .ok_or_else(|| "Microsoft login callback did not contain an authorization code".to_string())?;
                let _ = write_browser_callback_page(
                    &mut stream,
                    200,
                    "Microsoft login completed",
                    "You can return to FPSMaster Launcher now.",
                );
                return Ok(code);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(150));
            }
            Err(error) => {
                return Err(format!("Failed while waiting for Microsoft OAuth callback: {error}"));
            }
        }
    }
}

fn open_minecraft_auth_window(
    app: &AppHandle,
    label: &str,
    authorize_url: &str,
) -> Result<PathBuf, String> {
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.close();
    }
    let url = reqwest::Url::parse(authorize_url)
        .map_err(|e| format!("Invalid Microsoft authorize URL: {e}"))?;
    let data_dir = create_minecraft_auth_data_directory(label)?;
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Microsoft Login")
        .inner_size(980.0, 760.0)
        .min_inner_size(720.0, 560.0)
        .resizable(true)
        .focused(true)
        .center()
        .incognito(true)
        .data_directory(data_dir.clone())
        .build()
        .map_err(|e| format!("Failed to create Microsoft login window: {e}"))?;
    Ok(data_dir)
}

fn close_auth_window(app: &AppHandle, label: &str, data_dir: Option<&Path>) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }
    if let Some(path) = data_dir {
        cleanup_minecraft_auth_data_directory(path);
    }
}

fn create_minecraft_auth_data_directory(label: &str) -> Result<PathBuf, String> {
    let dir = env::temp_dir()
        .join("fpsmaster-launcher")
        .join("microsoft-auth")
        .join(label);
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to reset Microsoft auth data directory: {e}"))?;
    }
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create Microsoft auth data directory: {e}"))?;
    Ok(dir)
}

fn cleanup_minecraft_auth_data_directory(path: &Path) {
    for _ in 0..8 {
        if !path.exists() {
            return;
        }
        match fs::remove_dir_all(path) {
            Ok(_) => return,
            Err(_) => thread::sleep(Duration::from_millis(120)),
        }
    }
}

fn write_browser_callback_page(
    stream: &mut std::net::TcpStream,
    status_code: u16,
    title: &str,
    message: &str,
) -> Result<(), String> {
    let body = format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body style=\"font-family:Segoe UI,sans-serif;background:#10161c;color:#eef3f7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;\"><div style=\"max-width:480px;padding:32px;border-radius:20px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);box-shadow:0 18px 40px rgba(0,0,0,0.22);\"><h1 style=\"margin:0 0 12px;font-size:22px;\">{}</h1><p style=\"margin:0;font-size:14px;line-height:1.7;color:#c7d2de;\">{}</p></div></body></html>",
        title, title, message
    );
    let response = format!(
        "HTTP/1.1 {} OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_code,
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|e| format!("Failed to write Microsoft OAuth callback response: {e}"))
}

fn create_oauth_random_token(bytes_len: usize) -> String {
    let mut bytes = vec![0_u8; bytes_len];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn create_pkce_code_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn build_minecraft_auth_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build Minecraft auth HTTP client: {e}"))
}

fn resolve_minecraft_client_id() -> Result<(String, String), String> {
    if let Some(value) = read_runtime_env("FPSMASTER_MINECRAFT_CLIENT_ID") {
        return Ok((
            value,
            "environment:FPSMASTER_MINECRAFT_CLIENT_ID".to_string(),
        ));
    }
    if let Some(value) = read_runtime_env("MICROSOFT_CLIENT_ID") {
        return Ok((value, "environment:MICROSOFT_CLIENT_ID".to_string()));
    }
    if let Some(value) = option_env!("FPSMASTER_MINECRAFT_CLIENT_ID")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok((
            value.to_string(),
            "build:FPSMASTER_MINECRAFT_CLIENT_ID".to_string(),
        ));
    }
    if let Some(value) = option_env!("MICROSOFT_CLIENT_ID")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok((value.to_string(), "build:MICROSOFT_CLIENT_ID".to_string()));
    }
    Ok((
        DEFAULT_MINECRAFT_MICROSOFT_CLIENT_ID.to_string(),
        "builtin:DEFAULT_MINECRAFT_MICROSOFT_CLIENT_ID".to_string(),
    ))
}

fn read_runtime_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn minecraft_auth_configuration_hint() -> String {
    "Minecraft premium login is not configured. Set FPSMASTER_MINECRAFT_CLIENT_ID (or MICROSOFT_CLIENT_ID) before launching the launcher.".to_string()
}

fn normalize_microsoft_error_description(raw: Option<&str>, fallback: &str) -> String {
    raw.map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.replace("\r\n", " ").replace('\n', " "))
        .unwrap_or_else(|| fallback.to_string())
}

fn parse_microsoft_error_response(
    status: reqwest::StatusCode,
    text: &str,
    fallback: &str,
) -> String {
    if let Ok(payload) = serde_json::from_str::<MicrosoftTokenErrorResponse>(text) {
        return format!(
            "{}: {}",
            fallback,
            normalize_microsoft_error_description(
                payload.error_description.as_deref(),
                &payload.error
            )
        );
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return format!("{fallback}: HTTP {status}");
    }
    format!("{fallback}: {trimmed}")
}

fn create_microsoft_account_id(uuid: &str) -> String {
    format!("microsoft-{}", uuid.trim().to_ascii_lowercase())
}

fn unix_timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn open_target_with_system(target: &str) -> Result<(), String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("External target is empty".to_string());
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler").arg(trimmed);
        apply_windows_silent_spawn(&mut command);
        command
            .spawn()
            .map_err(|e| format!("Failed to open target with rundll32.exe: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg(trimmed)
            .status()
            .map_err(|e| format!("Failed to open target with open: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("open returned non-zero status: {status}"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = Command::new("xdg-open")
            .arg(trimmed)
            .status()
            .map_err(|e| format!("Failed to open target with xdg-open: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("xdg-open returned non-zero status: {status}"));
    }
}

fn normalize_api_base_url(base_url: &str) -> Result<String, String> {
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

fn infer_download_file_name(download_url: &str, version: &str) -> String {
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

fn is_jar_file_name(file_name: &str) -> bool {
    Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("jar"))
        .unwrap_or(false)
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

    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Invalid login response JSON: {e}"))?;

    if !status.is_success() {
        return Err(extract_api_error_message(body)
            .unwrap_or_else(|| format!("login failed with HTTP {}", status.as_u16())));
    }

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
    if let Ok(items) = parse_api_envelope::<Vec<LauncherVersion>>(status, body, "versions list") {
        return Ok(items);
    }

    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid versions list response JSON: {e}"))?;

    if !status.is_success() {
        let is_auth_error = status.as_u16() == 401 || status.as_u16() == 403;
        if let Some(msg) = extract_api_error_message(body) {
            if is_auth_error {
                return Err(format!("HTTP {} - {}", status.as_u16(), msg));
            }
            return Err(msg);
        }
        return Err(format!(
            "versions list failed with HTTP {}",
            status.as_u16()
        ));
    }

    extract_launcher_versions(&value)
        .ok_or_else(|| "versions list response missing data".to_string())
}

fn parse_launcher_news_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<Vec<LauncherNewsItem>, String> {
    if let Ok(items) = parse_api_envelope::<Vec<LauncherNewsItem>>(status, body, "launcher news") {
        return Ok(items);
    }

    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid launcher news response JSON: {e}"))?;

    if !status.is_success() {
        return Err(extract_api_error_message(body)
            .unwrap_or_else(|| format!("launcher news failed with HTTP {}", status.as_u16())));
    }

    extract_launcher_news(&value).ok_or_else(|| "launcher news response missing data".to_string())
}

fn parse_launcher_dashboard_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<LauncherDashboard, String> {
    if let Ok(item) = parse_api_envelope::<LauncherDashboard>(status, body, "launcher dashboard") {
        return Ok(item);
    }

    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid launcher dashboard response JSON: {e}"))?;

    if !status.is_success() {
        let is_auth_error = status.as_u16() == 401 || status.as_u16() == 403;
        if let Some(msg) = extract_api_error_message(body) {
            if is_auth_error {
                return Err(format!("HTTP {} - {}", status.as_u16(), msg));
            }
            return Err(msg);
        }
        return Err(format!(
            "launcher dashboard failed with HTTP {}",
            status.as_u16()
        ));
    }

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

    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid launcher home response JSON: {e}"))?;

    if !status.is_success() {
        let is_auth_error = status.as_u16() == 401 || status.as_u16() == 403;
        if let Some(msg) = extract_api_error_message(body) {
            if is_auth_error {
                return Err(format!("HTTP {} - {}", status.as_u16(), msg));
            }
            return Err(msg);
        }
        return Err(format!(
            "launcher home failed with HTTP {}",
            status.as_u16()
        ));
    }

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

    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid launcher app update response JSON: {e}"))?;

    if !status.is_success() {
        return Err(extract_api_error_message(body).unwrap_or_else(|| {
            format!("launcher app update failed with HTTP {}", status.as_u16())
        }));
    }

    serde_json::from_value::<LauncherAppUpdateInfo>(value)
        .map_err(|e| format!("launcher app update response missing data: {e}"))
}

fn parse_api_envelope<T: for<'de> Deserialize<'de>>(
    status: reqwest::StatusCode,
    body: &str,
    context: &str,
) -> Result<T, String> {
    match serde_json::from_str::<ApiEnvelope<T>>(body) {
        Ok(payload) => {
            if !status.is_success() || !payload.success {
                let is_auth_error = status.as_u16() == 401 || status.as_u16() == 403;
                let message = payload
                    .message
                    .and_then(|value| {
                        let trimmed = value.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    })
                    .or_else(|| extract_api_error_message(body))
                    .map(|msg| {
                        if is_auth_error {
                            format!("HTTP {} - {}", status.as_u16(), msg)
                        } else {
                            msg
                        }
                    })
                    .unwrap_or_else(|| format!("{context} failed with HTTP {}", status.as_u16()));
                return Err(message);
            }
            payload
                .data
                .ok_or_else(|| format!("{context} response missing data"))
        }
        Err(err) => {
            let is_auth_error = status.as_u16() == 401 || status.as_u16() == 403;
            if let Some(message) = extract_api_error_message(body) {
                if is_auth_error {
                    return Err(format!("HTTP {} - {}", status.as_u16(), message));
                }
                return Err(message);
            }
            if status.is_success() {
                return Err(format!("Invalid {context} response JSON: {err}"));
            }
            let compact = body.trim();
            if compact.is_empty() {
                return Err(format!("{context} failed with HTTP {}", status.as_u16()));
            }
            Err(format!(
                "{context} failed with HTTP {}: {}",
                status.as_u16(),
                compact
            ))
        }
    }
}

fn login_payload_container<'a>(value: &'a serde_json::Value) -> &'a serde_json::Value {
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

fn extract_api_error_message(body: &str) -> Option<String> {
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

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_secs()
}

fn now_epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis()
}

fn is_mods_marker_up_to_date(
    marker_path: &Path,
    version_tag: &str,
    expected_checksum: Option<&str>,
    expected_manifest_url: Option<&str>,
    expected_download_url: Option<&str>,
) -> Result<bool, String> {
    let marker = match read_mods_marker(marker_path)? {
        Some(value) => value,
        None => return Ok(false),
    };
    if marker.version_tag.trim() != version_tag.trim() {
        return Ok(false);
    }
    if let Some(expected_checksum_value) = expected_checksum {
        let installed_checksum = marker.checksum.as_deref().unwrap_or("").trim();
        if installed_checksum != expected_checksum_value.trim() {
            return Ok(false);
        }
    }
    match (marker.manifest_url.as_deref(), expected_manifest_url) {
        (Some(installed_manifest_url), Some(expected_manifest_url_value)) => {
            if installed_manifest_url.trim() != expected_manifest_url_value.trim() {
                return Ok(false);
            }
        }
        (None, Some(_)) => return Ok(false),
        _ => {}
    }
    if let Some(expected_url) = expected_download_url {
        if marker.download_url.trim() != expected_url.trim() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn read_mods_marker(marker_path: &Path) -> Result<Option<LauncherModsInstallMarker>, String> {
    if !marker_path.exists() {
        return Ok(None);
    }
    let content = match fs::read_to_string(marker_path) {
        Ok(text) => text,
        Err(_) => return Ok(None),
    };
    let marker = match serde_json::from_str::<LauncherModsInstallMarker>(&content) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if marker.version_tag.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(marker))
}

fn validate_installed_launcher_package(
    mods_dir: &Path,
    marker_path: &Path,
    marker_override: Option<&LauncherModsInstallMarker>,
) -> Result<bool, String> {
    let owned_marker;
    let marker = if let Some(value) = marker_override {
        value
    } else {
        owned_marker = match read_mods_marker(marker_path)? {
            Some(value) => value,
            None => return Ok(false),
        };
        &owned_marker
    };

    if marker.files.is_empty() {
        return mods_dir_has_payload(mods_dir, marker_path);
    }

    for file in &marker.files {
        let relative_path = normalize_manifest_relative_path(&file.path)?;
        let target_path = mods_dir.join(&relative_path);
        let metadata = match fs::metadata(&target_path) {
            Ok(value) if value.is_file() => value,
            _ => return Ok(false),
        };
        if let Some(expected_size) = file.size {
            if metadata.len() != expected_size {
                return Ok(false);
            }
        }
        if let Some(expected_checksum) = file.checksum.as_deref() {
            if let Err(_) = verify_file_sha256(&target_path, expected_checksum) {
                return Ok(false);
            }
        }
    }

    Ok(true)
}

fn build_launcher_installed_file_record(
    path: &Path,
    relative_path: &Path,
) -> Result<LauncherInstalledFileRecord, String> {
    let metadata = fs::metadata(path).map_err(|e| {
        format!(
            "Failed to inspect installed launcher file {}: {e}",
            path.display()
        )
    })?;
    let checksum = compute_file_sha256_hex(path)?;
    Ok(LauncherInstalledFileRecord {
        path: relative_path.to_string_lossy().replace('\\', "/"),
        size: Some(metadata.len()),
        checksum: Some(checksum),
    })
}

fn mods_dir_has_payload(mods_dir: &Path, marker_path: &Path) -> Result<bool, String> {
    if !mods_dir.exists() {
        return Ok(false);
    }
    let read_dir = fs::read_dir(mods_dir).map_err(|e| {
        format!(
            "Failed to inspect mods directory {}: {e}",
            mods_dir.to_string_lossy()
        )
    })?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path == marker_path {
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

fn extract_launcher_mod_archive(
    archive: &Path,
    mods_dir: &Path,
) -> Result<Vec<LauncherInstalledFileRecord>, String> {
    let file = fs::File::open(archive)
        .map_err(|e| format!("Failed to open launcher archive {}: {e}", archive.display()))?;
    let mut zip_archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid launcher zip archive {}: {e}", archive.display()))?;

    let mut has_mods_paths = false;
    for i in 0..zip_archive.len() {
        let entry = zip_archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.name().ends_with('/') {
            continue;
        }
        if let Some(path) = entry.enclosed_name() {
            if path_contains_mods_component(&path) {
                has_mods_paths = true;
                break;
            }
        }
    }

    let mut installed_files = Vec::new();
    for i in 0..zip_archive.len() {
        let mut entry = zip_archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.name().ends_with('/') {
            continue;
        }
        let enclosed = match entry.enclosed_name() {
            Some(path) => path.to_path_buf(),
            None => continue,
        };

        let relative_path = if has_mods_paths {
            match trim_to_mods_relative_path(&enclosed) {
                Some(path) => path,
                None => continue,
            }
        } else {
            match enclosed.file_name() {
                Some(file_name) => PathBuf::from(file_name),
                None => continue,
            }
        };

        if relative_path.as_os_str().is_empty() {
            continue;
        }

        let out_path = mods_dir.join(&relative_path);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create mod output directory {}: {e}",
                    parent.to_string_lossy()
                )
            })?;
        }

        let mut out_file = fs::File::create(&out_path).map_err(|e| {
            format!(
                "Failed to create mod output file {}: {e}",
                out_path.to_string_lossy()
            )
        })?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| {
            format!(
                "Failed to write mod output file {}: {e}",
                out_path.to_string_lossy()
            )
        })?;
        installed_files.push(build_launcher_installed_file_record(
            &out_path,
            &relative_path,
        )?);
    }

    if installed_files.is_empty() {
        return Err("Launcher package does not contain any mod files".to_string());
    }
    Ok(installed_files)
}

fn path_contains_mods_component(path: &Path) -> bool {
    for component in path.components() {
        if let std::path::Component::Normal(part) = component {
            if part.to_string_lossy().eq_ignore_ascii_case("mods") {
                return true;
            }
        }
    }
    false
}

fn trim_to_mods_relative_path(path: &Path) -> Option<PathBuf> {
    let mut found_mods = false;
    let mut relative = PathBuf::new();
    for component in path.components() {
        let std::path::Component::Normal(part) = component else {
            continue;
        };
        let as_text = part.to_string_lossy();
        if !found_mods && as_text.eq_ignore_ascii_case("mods") {
            found_mods = true;
            continue;
        }
        if found_mods {
            relative.push(part);
        }
    }
    if !found_mods || relative.as_os_str().is_empty() {
        return None;
    }
    Some(relative)
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip_archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip_archive.len() {
        let mut entry = zip_archive.by_index(i).map_err(|e| e.to_string())?;
        let out_path = match entry.enclosed_name() {
            Some(path) => dest.join(path),
            None => continue,
        };
        if entry.name().ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out_file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    tar.unpack(dest).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{FabricInstallResult, ForgeInstallResult};

    #[test]
    fn fabric_install_result_matches_java_core_payload() {
        let payload = r#"{
            "profileId":"fabric-loader-0.16.10-1.20.1",
            "loaderVersion":"0.16.10",
            "profileJsonPath":"E:\\test\\fabric-loader-0.16.10-1.20.1.json",
            "librariesDownloaded":8
        }"#;

        let result: FabricInstallResult =
            serde_json::from_str(payload).expect("fabric payload should deserialize");
        assert_eq!(result.profile_id, "fabric-loader-0.16.10-1.20.1");
        assert_eq!(result.loader_version.as_deref(), Some("0.16.10"));
        assert_eq!(
            result.profile_json_path,
            r"E:\test\fabric-loader-0.16.10-1.20.1.json"
        );
        assert_eq!(result.libraries_downloaded, 8);
    }

    #[test]
    fn forge_install_result_matches_java_core_payload() {
        let payload = r#"{
            "profileId":"1.20.1-forge-47.4.18",
            "forgeVersion":"1.20.1-47.4.18",
            "profileJsonPath":"E:\\test\\1.20.1-forge-47.4.18.json",
            "installerUrl":"https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.18/forge-1.20.1-47.4.18-installer.jar"
        }"#;

        let result: ForgeInstallResult =
            serde_json::from_str(payload).expect("forge payload should deserialize");
        assert_eq!(result.profile_id, "1.20.1-forge-47.4.18");
        assert_eq!(result.forge_version, "1.20.1-47.4.18");
        assert_eq!(
            result.profile_json_path,
            r"E:\test\1.20.1-forge-47.4.18.json"
        );
    }
}

fn locate_java_binary(runtime_root: &Path) -> Option<PathBuf> {
    let mut stack = vec![runtime_root.to_path_buf()];
    let expected = if cfg!(windows) { "java.exe" } else { "java" };
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let file_name = path.file_name()?.to_string_lossy().to_lowercase();
            if file_name == expected {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(windows)]
struct ComScope {
    should_uninitialize: bool,
}

#[cfg(windows)]
impl Drop for ComScope {
    fn drop(&mut self) {
        if self.should_uninitialize {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

#[cfg(windows)]
fn initialize_com_scope() -> Result<ComScope, String> {
    let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if result.is_ok() {
        return Ok(ComScope {
            should_uninitialize: true,
        });
    }
    if result == RPC_E_CHANGED_MODE {
        return Ok(ComScope {
            should_uninitialize: false,
        });
    }
    Err(format!("Failed to initialize COM: {result}"))
}

#[cfg(windows)]
fn pwstr_to_string(value: PWSTR) -> Result<String, String> {
    if value.is_null() {
        return Ok(String::new());
    }
    let text = unsafe { value.to_string() }.map_err(|e| format!("Invalid UTF-16 string: {e}"))?;
    unsafe {
        CoTaskMemFree(Some(value.0 as _));
    }
    Ok(text)
}

#[cfg(windows)]
fn get_primary_monitor_rect() -> Result<RECT, String> {
    let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
    let mut monitor_info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetMonitorInfoW(monitor, &mut monitor_info as *mut MONITORINFO) };
    if ok.as_bool() {
        Ok(monitor_info.rcMonitor)
    } else {
        Err("Failed to query primary monitor information".to_string())
    }
}

#[cfg(windows)]
fn rect_contains_origin(rect: &RECT) -> bool {
    rect.left <= 0 && rect.top <= 0 && rect.right > 0 && rect.bottom > 0
}

#[cfg(windows)]
fn get_system_wallpaper_path() -> Result<Option<String>, String> {
    let _com_scope = initialize_com_scope()?;
    let wallpaper: IDesktopWallpaper =
        unsafe { CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL) }
            .map_err(|e| format!("Failed to create DesktopWallpaper COM instance: {e}"))?;

    let slideshow_state = unsafe { wallpaper.GetStatus() }
        .map_err(|e| format!("Failed to query wallpaper slideshow state: {e}"))?;
    if (slideshow_state.0 & 0x02) != 0 {
        return Ok(None);
    }

    let primary_rect = get_primary_monitor_rect()?;
    let monitor_count = unsafe { wallpaper.GetMonitorDevicePathCount() }
        .map_err(|e| format!("Failed to enumerate wallpaper monitors: {e}"))?;

    let mut fallback_monitor_id: Option<String> = None;
    for index in 0..monitor_count {
        let monitor_id = pwstr_to_string(
            unsafe { wallpaper.GetMonitorDevicePathAt(index) }
                .map_err(|e| format!("Failed to read wallpaper monitor id: {e}"))?,
        )?;
        let monitor_id_text = HSTRING::from(monitor_id.as_str());
        if fallback_monitor_id.is_none() {
            fallback_monitor_id = Some(monitor_id.clone());
        }
        let monitor_rect = unsafe { wallpaper.GetMonitorRECT(&monitor_id_text) }
            .map_err(|e| format!("Failed to query wallpaper monitor rect: {e}"))?;
        if monitor_rect == primary_rect || rect_contains_origin(&monitor_rect) {
            let path = pwstr_to_string(
                unsafe { wallpaper.GetWallpaper(&monitor_id_text) }
                    .map_err(|e| format!("Failed to query primary wallpaper path: {e}"))?,
            )?;
            return normalize_system_wallpaper_path(path);
        }
    }

    if let Some(monitor_id) = fallback_monitor_id {
        let monitor_id_text = HSTRING::from(monitor_id.as_str());
        let path = pwstr_to_string(
            unsafe { wallpaper.GetWallpaper(&monitor_id_text) }
                .map_err(|e| format!("Failed to query wallpaper path: {e}"))?,
        )?;
        return normalize_system_wallpaper_path(path);
    }

    Ok(None)
}

#[cfg(windows)]
fn normalize_system_wallpaper_path(path: String) -> Result<Option<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let resolved = PathBuf::from(trimmed);
    if !resolved.is_file() {
        return Ok(None);
    }
    Ok(Some(
        strip_windows_verbatim_prefix(&resolved)
            .to_string_lossy()
            .to_string(),
    ))
}

fn read_image_file_as_data_url(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read wallpaper image: {e}"))?;
    let mime = detect_image_mime(path, &bytes)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn detect_image_mime(path: &Path, bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Ok("image/jpeg");
    }
    if bytes.len() >= 8
        && bytes[0] == 0x89
        && bytes[1] == 0x50
        && bytes[2] == 0x4E
        && bytes[3] == 0x47
        && bytes[4] == 0x0D
        && bytes[5] == 0x0A
        && bytes[6] == 0x1A
        && bytes[7] == 0x0A
    {
        return Ok("image/png");
    }
    if bytes.len() >= 6 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
        return Ok("image/gif");
    }
    if bytes.len() >= 2 && bytes[0] == 0x42 && bytes[1] == 0x4D {
        return Ok("image/bmp");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok("image/webp");
    }
    if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
        match ext.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" => return Ok("image/jpeg"),
            "png" => return Ok("image/png"),
            "gif" => return Ok("image/gif"),
            "bmp" => return Ok("image/bmp"),
            "webp" => return Ok("image/webp"),
            _ => {}
        }
    }
    Err(format!(
        "Unsupported wallpaper image format: {}",
        path.display()
    ))
}

fn load_background_image_bytes(
    background_source: &str,
    background_image: &str,
    background_web_url: &str,
) -> Result<Vec<u8>, String> {
    match background_source {
        "web-random" => load_remote_image_bytes(background_web_url),
        "local" | "system" => load_inline_image_bytes(background_image),
        other => Err(format!("Unsupported background source: {other}")),
    }
}

fn load_inline_image_bytes(value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty() {
        return Err("Background image is empty".to_string());
    }
    if value.starts_with("data:") {
        return decode_data_url_bytes(value);
    }
    fs::read(value).map_err(|e| format!("Failed to read background image file: {e}"))
}

fn load_remote_image_bytes(url: &str) -> Result<Vec<u8>, String> {
    if url.is_empty() {
        return Err("Background image URL is empty".to_string());
    }
    let client = build_blocking_http_client()?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "image/*,*/*;q=0.8")
        .send()
        .map_err(|e| format!("Failed to fetch background image: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch background image: HTTP {}",
            response.status()
        ));
    }
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|e| format!("Failed to read background image response: {e}"))
}

fn decode_data_url_bytes(value: &str) -> Result<Vec<u8>, String> {
    let (metadata, payload) = value
        .split_once(',')
        .ok_or_else(|| "Invalid data URL".to_string())?;
    if !metadata.ends_with(";base64") {
        return Err("Unsupported data URL encoding".to_string());
    }
    base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("Invalid base64 data URL: {e}"))
}

#[derive(Default, Clone, Copy)]
struct AccentBucket {
    total_weight: f64,
    total_r: f64,
    total_g: f64,
    total_b: f64,
    count: u32,
}

fn extract_theme_accent_hex_from_bytes(bytes: &[u8]) -> Result<String, String> {
    let image = image::load_from_memory(bytes)
        .map_err(|e| format!("Failed to decode background image: {e}"))?;
    let thumbnail = image.thumbnail(96, 96).to_rgba8();
    let mut buckets: HashMap<(u8, u8, u8), AccentBucket> = HashMap::new();
    let mut fallback = AccentBucket::default();

    for pixel in thumbnail.pixels() {
        let [r, g, b, a] = pixel.0;
        if a < 24 {
            continue;
        }
        let alpha = a as f64 / 255.0;
        let (hue, saturation, lightness) = rgb_to_hsl_components(r, g, b);
        let bucket_key = ((r / 24).min(10), (g / 24).min(10), (b / 24).min(10));

        let fallback_weight = alpha * (0.25 + lightness.max(0.08));
        accumulate_accent_bucket(&mut fallback, r, g, b, fallback_weight);

        if lightness < 0.08 || lightness > 0.92 {
            continue;
        }

        let hue_weight = if hue.is_finite() { 1.0 } else { 0.7 };
        let vividness = (0.25 + saturation * 0.75) * hue_weight;
        let balance = (1.0 - (lightness - 0.56).abs() * 1.4).clamp(0.1, 1.0);
        let weight = alpha * vividness * balance;
        if weight <= 0.0 {
            continue;
        }
        let bucket = buckets.entry(bucket_key).or_default();
        accumulate_accent_bucket(bucket, r, g, b, weight);
    }

    let mut best = buckets
        .values()
        .filter(|bucket| bucket.count > 0 && bucket.total_weight > 0.0)
        .max_by(|left, right| left.total_weight.total_cmp(&right.total_weight))
        .copied()
        .unwrap_or_default();

    if best.count == 0 || best.total_weight <= 0.0 {
        best = fallback;
    }
    if best.count == 0 || best.total_weight <= 0.0 {
        return Err("Background image did not contain any usable pixels".to_string());
    }

    let rgb = normalize_theme_accent_color(resolve_bucket_rgb(best));
    Ok(format!("#{:02x}{:02x}{:02x}", rgb.0, rgb.1, rgb.2))
}

fn accumulate_accent_bucket(bucket: &mut AccentBucket, r: u8, g: u8, b: u8, weight: f64) {
    if weight <= 0.0 {
        return;
    }
    bucket.total_weight += weight;
    bucket.total_r += r as f64 * weight;
    bucket.total_g += g as f64 * weight;
    bucket.total_b += b as f64 * weight;
    bucket.count += 1;
}

fn resolve_bucket_rgb(bucket: AccentBucket) -> (u8, u8, u8) {
    if bucket.total_weight <= 0.0 {
        return (37, 184, 122);
    }
    (
        (bucket.total_r / bucket.total_weight).round().clamp(0.0, 255.0) as u8,
        (bucket.total_g / bucket.total_weight).round().clamp(0.0, 255.0) as u8,
        (bucket.total_b / bucket.total_weight).round().clamp(0.0, 255.0) as u8,
    )
}

fn normalize_theme_accent_color(rgb: (u8, u8, u8)) -> (u8, u8, u8) {
    let (h, s, l) = rgb_to_hsl_components(rgb.0, rgb.1, rgb.2);
    let normalized_h = if h.is_finite() { h } else { 148.0 / 360.0 };
    let normalized_s = s.clamp(0.42, 0.82);
    let normalized_l = l.clamp(0.38, 0.60);
    hsl_to_rgb_components(normalized_h, normalized_s, normalized_l)
}

fn rgb_to_hsl_components(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let rf = r as f64 / 255.0;
    let gf = g as f64 / 255.0;
    let bf = b as f64 / 255.0;

    let max = rf.max(gf.max(bf));
    let min = rf.min(gf.min(bf));
    let lightness = (max + min) / 2.0;
    let delta = max - min;

    if delta.abs() < f64::EPSILON {
        return (f64::NAN, 0.0, lightness);
    }

    let saturation = delta / (1.0 - (2.0 * lightness - 1.0).abs()).max(f64::EPSILON);
    let hue = if (max - rf).abs() < f64::EPSILON {
        ((gf - bf) / delta).rem_euclid(6.0)
    } else if (max - gf).abs() < f64::EPSILON {
        ((bf - rf) / delta) + 2.0
    } else {
        ((rf - gf) / delta) + 4.0
    } / 6.0;

    (hue, saturation.clamp(0.0, 1.0), lightness.clamp(0.0, 1.0))
}

fn hsl_to_rgb_components(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    if s <= f64::EPSILON {
        let value = (l * 255.0).round().clamp(0.0, 255.0) as u8;
        return (value, value, value);
    }

    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;

    let convert = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        let channel = if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        };
        (channel * 255.0).round().clamp(0.0, 255.0) as u8
    };

    (convert(h + 1.0 / 3.0), convert(h), convert(h - 1.0 / 3.0))
}

#[cfg(not(windows))]
fn get_system_wallpaper_path() -> Result<Option<String>, String> {
    Ok(None)
}

fn main() {
    tauri::Builder::default()
        .manage(LauncherRuntimeState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Callback when a second instance is launched
            // Show and focus the main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin({
            #[cfg(target_os = "macos")]
            {
                tauri_plugin_autostart::Builder::new()
                    .arg("--autostart")
                    .macos_launcher(MacosLauncher::LaunchAgent)
                    .build()
            }
            #[cfg(not(target_os = "macos"))]
            {
                tauri_plugin_autostart::Builder::new()
                    .arg("--autostart")
                    .build()
            }
        })
        .setup(|app| {
            let _ = app.path().app_data_dir();
            if let Ok(resource_jar) = app
                .path()
                .resolve("java/java-core.jar", BaseDirectory::Resource)
            {
                let _ = JAVA_CORE_RESOURCE_JAR
                    .set(strip_windows_verbatim_prefix(resource_jar.as_path()));
            }
            create_tray(&app.handle())?;
            let launched_from_autostart = is_autostart_launch();
            if let Some(window) = app.get_webview_window("main") {
                if launched_from_autostart {
                    let _ = window.hide();
                }
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if should_minimize_to_tray(&app_handle) {
                            api.prevent_close();
                            let _ = hide_main_window_internal(&app_handle);
                        } else {
                            flush_launcher_telemetry_session(&app_handle);
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ensure_jdk,
            launcher_login,
            launcher_list_available_versions,
            launcher_list_news,
            launcher_get_dashboard,
            launcher_get_home,
            launcher_get_app_update,
            launcher_list_app_update_channels,
            download_launcher_app_update,
            open_downloaded_file,
            get_minecraft_auth_config,
            start_minecraft_device_login,
            start_minecraft_browser_login,
            poll_minecraft_device_login,
            refresh_minecraft_account,
            open_external_link,
            quit_launcher_app,
            launcher_cache_telemetry_session,
            launcher_offline_telemetry_session,
            start_launcher_heartbeat,
            stop_launcher_heartbeat,
            modrinth_search_projects,
            install_modrinth_project,
            curseforge_search_projects,
            install_curseforge_project,
            list_installed_content,
            uninstall_installed_content,
            check_installed_content_updates,
            import_world_archive,
            get_launcher_package_state,
            install_launcher_version_mods,
            list_vanilla_versions,
            install_vanilla,
            build_vanilla_launch_plan,
            launch_vanilla,
            list_fabric_loaders,
            install_fabric,
            list_forge_versions,
            install_forge,
            poll_ui_logs,
            poll_game_runtime,
            is_version_installed,
            list_installed_versions,
            rename_version_profile,
            duplicate_instance_storage,
            export_instance_archive,
            import_instance_archive,
            repair_instance_runtime,
            list_instance_section_entries,
            open_instance_section,
            delete_instance_section_entry,
            toggle_mod_disabled,
            get_default_game_dir,
            get_system_wallpaper,
            extract_background_theme_accent,
            show_main_window,
            hide_main_window,
            quit_launcher_app,
            configure_tray_behavior,
            set_launch_on_startup,
            terminate_game_process
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
