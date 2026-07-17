#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launcher_api;
mod microsoft_auth;
mod minecraft_core;
mod secure_storage;

use launcher_api::{
    download_launcher_app_update, launcher_get_app_update,
    launcher_get_dashboard, launcher_get_home, launcher_list_app_update_channels,
    launcher_list_available_versions, launcher_list_news, launcher_login, normalize_api_base_url,
    open_downloaded_file, parse_api_envelope,
};
use microsoft_auth::{
    get_minecraft_auth_config, poll_minecraft_device_login, refresh_minecraft_account,
    start_minecraft_browser_login, start_minecraft_device_login,
};
use secure_storage::{secure_storage_delete, secure_storage_get, secure_storage_set};

use base64::Engine;
use minecraft_core::VanillaLaunchRequest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Cursor, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, fs};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent};
#[cfg(target_os = "macos")]
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt;
#[cfg(windows)]
use windows::core::{HSTRING, PWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{POINT, RECT, RPC_E_CHANGED_MODE};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_APARTMENTTHREADED,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::{DesktopWallpaper, IDesktopWallpaper};
use xz2::bufread::XzDecoder;
use xz2::stream::Stream;

const DEFAULT_DOWNLOAD_THREADS: i32 = 16;
const JDK_DOWNLOAD_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FPSMasterLauncher/0.1 (+https://github.com/fpsmaster)";
const MOJANG_JAVA_ALL_JSON_URL: &str =
    "https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

static INSTALL_CANCEL_STATE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

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
struct VerifyResult {
    #[serde(rename = "versionId")]
    version_id: String,
    #[serde(rename = "clientRepaired")]
    client_repaired: bool,
    #[serde(rename = "librariesRepaired")]
    libraries_repaired: i32,
    #[serde(rename = "assetsRepaired")]
    assets_repaired: i32,
    repaired: i32,
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
struct OptiFineVersionInfo {
    id: String,
    #[serde(rename = "gameVersion")]
    game_version: String,
    version: String,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "type")]
    optifine_type: String,
    patch: String,
    #[serde(rename = "isPreview")]
    is_preview: bool,
    #[serde(rename = "forgeRequirement")]
    forge_requirement: Option<String>,
    compatibility: String,
    #[serde(rename = "incompatibilityReason")]
    incompatibility_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OptiFineInstallResult {
    #[serde(rename = "versionId")]
    version_id: String,
    #[serde(rename = "optiFineVersion")]
    opti_fine_version: String,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "installedPath")]
    installed_path: String,
    skipped: bool,
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
    // Local integrity/compatibility is an axis orthogonal to "is there a newer
    // version": the package is installed and on the latest version, but the mods
    // dir contains an unsupported runtime mod (or was tampered with) and needs a
    // repair reinstall. Kept separate so the UI can say "needs repair" instead of
    // falsely nagging "update available".
    #[serde(rename = "needsRepair")]
    needs_repair: bool,
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
    #[serde(rename = "optiFineVersion")]
    opti_fine_version: Option<String>,
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
    #[serde(rename = "optiFineVersion")]
    opti_fine_version: Option<String>,
    #[serde(rename = "reinstalledFromVersionId")]
    reinstalled_from_version_id: String,
}

#[derive(Debug, Clone)]
struct InstanceProfileMetadata {
    version_id: String,
    base_version: String,
    loader: String,
    loader_version: Option<String>,
    opti_fine_version: Option<String>,
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
static PROCESS_MEMORY_SAMPLER: OnceLock<Mutex<sysinfo::System>> = OnceLock::new();
static GAME_RUNTIME_STARTS: OnceLock<Mutex<HashMap<i64, std::time::Instant>>> = OnceLock::new();
static GAME_RUNTIME_CACHE: OnceLock<Mutex<HashMap<i64, CachedGameRuntimeStats>>> = OnceLock::new();
static GAME_RUNTIME_SAMPLER_STARTED: OnceLock<()> = OnceLock::new();
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const TRAY_SHOW_ID: &str = "tray_show";
const TRAY_HIDE_ID: &str = "tray_hide";
const TRAY_QUIT_ID: &str = "tray_quit";
const GAME_RUNTIME_CACHE_TTL_MS: u128 = 3000;
const GAME_RUNTIME_SAMPLE_INTERVAL_MS: u64 = 2000;
// The monitor UI keeps at most 1000 log lines, so poll batches beyond that are wasted work.
const UI_LOG_POLL_MAX_ENTRIES: usize = 1000;
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

fn attach_main_window_handlers(window: &WebviewWindow, app: &AppHandle) {
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if should_minimize_to_tray(&app_handle) {
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.destroy();
                }
            } else {
                flush_launcher_telemetry_session(&app_handle);
            }
        }
    });
}

fn create_main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| "Main window config not found".to_string())?;
    let builder = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| format!("Failed to prepare main window builder: {e}"))?;
    let window = builder
        .build()
        .map_err(|e| format!("Failed to create main window: {e}"))?;
    attach_main_window_handlers(&window, app);
    Ok(window)
}

fn ensure_main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("main") {
        return Ok(window);
    }
    create_main_window(app)
}

fn hide_main_window_internal(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
    window
        .destroy()
        .map_err(|e| format!("Failed to destroy main window: {e}"))?;

    Ok(())
}

fn show_main_window_internal(app: &AppHandle) -> Result<(), String> {
    let window = ensure_main_window(app)?;
    let _ = window.reload();

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
}

impl Default for LauncherRuntimeState {
    fn default() -> Self {
        Self {
            minimize_to_tray: AtomicBool::new(true),
            telemetry_session: Mutex::new(None),
            heartbeat_running: AtomicBool::new(false),
            heartbeat_stop: Arc::new(AtomicBool::new(false)),
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

// Async so it runs on the async runtime instead of the main thread: polls arrive
// every second while the game is running, and cloning + serializing a log batch on
// the main thread stalls window event handling (visible jank under game load).
#[tauri::command]
async fn poll_ui_logs(after_seq: Option<u64>) -> UiLogPollResult {
    if let Ok(store) = ui_log_store().lock() {
        // The UI keeps at most 1000 lines, so returning more per poll is pure
        // serialization waste; on a burst (or first poll over the full backlog)
        // an uncapped batch can be thousands of entries. nextSeq still advances
        // past the skipped entries — older lines are dropped, never re-sent.
        let matches = |entry: &&UiLogEntry| after_seq.map_or(true, |after| entry.seq > after);
        let matched = store.entries.iter().filter(matches).count();
        let entries = store
            .entries
            .iter()
            .filter(matches)
            .skip(matched.saturating_sub(UI_LOG_POLL_MAX_ENTRIES))
            .cloned()
            .collect();
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

// Async for the same reason as poll_ui_logs: keep the periodic poll off the main thread.
#[tauri::command]
async fn poll_game_runtime(pid: i64) -> Result<GameRuntimeStats, String> {
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
fn destroy_current_window(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let label = window.label().to_string();
    if label == "main" {
        return Err("Refusing to destroy main window through monitor close command".to_string());
    }
    if let Some(webview_window) = app.get_webview_window(&label) {
        return webview_window
            .destroy()
            .map_err(|e| format!("Failed to destroy current window: {e}"));
    }
    window
        .close()
        .map_err(|e| format!("Failed to close current window: {e}"))
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
                if app.get_webview_window("main").is_some() {
                    let _ = hide_main_window_internal(app);
                } else {
                    let _ = show_main_window_internal(app);
                }
            }
        })
        .build(app)
        .map_err(|e| format!("Failed to build tray icon: {e}"))?;
    Ok(())
}

// spawn_blocking: this sleeps and spawns kill/taskkill subprocesses — on the main
// thread that froze the whole window for ~0.5s when stopping the game.
#[tauri::command]
async fn terminate_game_process(pid: i64, force: Option<bool>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || terminate_game_process_blocking(pid, force))
        .await
        .map_err(|e| format!("Failed to join terminate task: {e}"))
        .and_then(std::convert::identity)
        .inspect_err(|e| log_command_error("terminate_game_process", e))
}

fn terminate_game_process_blocking(pid: i64, force: Option<bool>) -> Result<bool, String> {
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
fn get_version_profile_base_version(
    game_dir: String,
    version_id: String,
) -> Result<Option<String>, String> {
    let version = version_id.trim();
    if version.is_empty() {
        return Ok(None);
    }
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let profile_json = game_dir_path
        .join("versions")
        .join(version)
        .join(format!("{version}.json"));
    if !profile_json.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&profile_json).map_err(|e| {
        format!(
            "Failed to read version profile {}: {e}",
            profile_json.display()
        )
    })?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "Failed to parse version profile {}: {e}",
            profile_json.display()
        )
    })?;
    Ok(parsed
        .get("inheritsFrom")
        .or_else(|| parsed.get("id"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string))
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
        if is_launcher_preset_version_id(to_id) && from_dir.exists() {
            copy_directory_contents(&from_dir, &to_dir)?;
            retarget_version_runtime(&to_dir, from_id, to_id)?;
            let _ = fs::remove_dir_all(&from_dir);
            return Ok(to_id.to_string());
        }
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
    matches!(
        version_id,
        "FPSMaster-Edge" | "FPSMaster-Nova" | "FPSMaster-Extreme"
    )
}

/// FPSMaster-Extreme is a native Rust client (`fpsmaster_app`), not a Java
/// Minecraft instance. It is installed and launched through the native-app path
/// (`install_native_app` / `launch_native_app`), bypassing the vanilla/loader
/// download and `build_vanilla_launch_plan` Java launch. Other presets return
/// false and keep flowing through the standard Minecraft pipeline.
fn is_native_app_version_id(version_id: &str) -> bool {
    matches!(version_id, "FPSMaster-Extreme")
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
        opti_fine_version: metadata.opti_fine_version,
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

    let vanilla = minecraft_core::install_vanilla(
        Some(&window),
        &game_dir_path,
        &normalized_base_version,
        None,
        normalize_download_threads(Some(DEFAULT_DOWNLOAD_THREADS)),
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
            Some(DEFAULT_DOWNLOAD_THREADS),
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
            game_dir_path.to_string_lossy().to_string(),
            normalized_base_version.clone(),
            Some(DEFAULT_DOWNLOAD_THREADS),
        )?;
        let forge = install_forge_blocking_core(
            Some(&window),
            &game_dir_path,
            &selected_loader_version,
            &jdk.java_path,
            None,
            Some(DEFAULT_DOWNLOAD_THREADS),
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
        opti_fine_version: None,
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
    .map_err(|e| format!("Failed to join instance import task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("import_instance_archive", e))
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
    .map_err(|e| format!("Failed to join instance repair task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("repair_instance_runtime", e))
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
        if target_json.exists() {
            fs::remove_file(&target_json).map_err(|e| {
                format!(
                    "Failed to replace version json {}: {e}",
                    target_json.display()
                )
            })?;
        }
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
    download_threads: Option<i32>,
) -> Result<JdkEnsureResult, String> {
    let window_clone = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_jdk_blocking(window_clone, game_dir, version_id, download_threads)
    })
    .await
    .map_err(|e| format!("Failed to join ensure_jdk task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("ensure_jdk", e))
}

fn ensure_jdk_blocking(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    download_threads: Option<i32>,
) -> Result<JdkEnsureResult, String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let requirement =
        minecraft_core::resolve_java_runtime_requirement(Some(&game_dir_path), &version_id, None)?;

    let major = requirement.major_version.max(8);
    // On Apple Silicon, a profile whose native libs (LWJGL) ship no arm64 build must run
    // under an x64 (Rosetta) JVM — a native arm64 JVM can't load x64 .dylibs.
    let needs_x64 = minecraft_core::macos_requires_x64_runtime(&game_dir_path, &version_id);
    let runtime_root = managed_jdk_runtime_root(&game_dir_path, major, needs_x64);
    let java_path = ensure_managed_jdk_runtime(
        Some(&window),
        &runtime_root,
        major,
        download_threads,
        needs_x64,
    )?;

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
fn open_external_link(url: String) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url.trim()).map_err(|e| format!("Invalid external URL: {e}"))?;
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
        let interval = Duration::from_secs(90); // Base interval: 90 seconds
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
    .map_err(|e| format!("Failed to join Modrinth search task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("modrinth_search_projects", e))
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
    .map_err(|e| format!("Failed to join Modrinth install task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("install_modrinth_project", e))
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
    .map_err(|e| format!("Failed to join CurseForge search task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("curseforge_search_projects", e))
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
    .map_err(|e| format!("Failed to join CurseForge install task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("install_curseforge_project", e))
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
    .map_err(|e| format!("Failed to join installed content task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("list_installed_content", e))
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
    .map_err(|e| format!("Failed to join uninstall content task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("uninstall_installed_content", e))
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
    .map_err(|e| format!("Failed to join content updates task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("check_installed_content_updates", e))
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
    .map_err(|e| format!("Failed to join world import task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("import_world_archive", e))
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
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    download_url: String,
    version_tag: Option<String>,
    checksum: Option<String>,
    manifest_url: Option<String>,
    clean_existing: Option<bool>,
    ipc_session: Option<String>,
) -> Result<LauncherModsInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_launcher_version_mods_blocking(
            Some(&window),
            ipc_session.as_deref(),
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
    .map_err(|e| format!("Failed to join launcher mods install task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("install_launcher_version_mods", e))
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
    .map_err(|e| format!("Failed to join launcher package state task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("get_launcher_package_state", e))
}

// Derive a human-readable file name for a single-file mod package, e.g.
// "FPSMaster-Nova-nightly-46.jar", instead of the opaque upload hash that the
// download URL ends with (".../1783864173-0e0f....jar"). The extension is taken
// from the URL when it looks like a real archive extension so that non-jar
// packages (e.g. .zip) still route through the archive-extraction path.
fn launcher_mod_package_file_name(download_url: &str, version_id: &str, version_tag: &str) -> String {
    let ext = reqwest::Url::parse(download_url)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|segments| segments.last().map(str::to_string))
        })
        .and_then(|last| {
            last.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase())
        })
        .filter(|ext| {
            !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|ch| ch.is_ascii_alphanumeric())
        })
        .unwrap_or_else(|| "jar".to_string());
    let base_source = format!("{}-{}", version_id.trim(), version_tag.trim());
    let base = sanitize_file_name(&base_source);
    let base = base.trim().trim_end_matches('.').trim();
    let base = if base.is_empty() { "fpsmaster-mod" } else { base };
    format!("{base}.{ext}")
}

fn install_launcher_version_mods_blocking(
    window: Option<&tauri::Window>,
    ipc_session: Option<&str>,
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
    let clean_existing = clean_existing.unwrap_or(false);

    let marker_path = mods_dir.join(".fpsmaster-launcher-mods.json");
    let previous_marker = read_mods_marker(&marker_path)?;
    let package_up_to_date = match previous_marker.as_ref() {
        Some(marker) => {
            is_mods_marker_up_to_date(
                &marker_path,
                &normalized_tag,
                checksum.as_deref(),
                normalized_manifest_url.as_deref(),
                Some(normalized_url.as_str()),
            )? && validate_installed_launcher_package(&mods_dir, &marker_path, Some(marker))?
                && !launcher_package_has_unsupported_runtime_mods(&mods_dir, marker)?
                && !mods_dir_has_unsupported_runtime_mods(&mods_dir)?
                && (!clean_existing
                    || !mods_dir_has_unmanaged_files(&mods_dir, &marker_path, marker)?)
        }
        None => false,
    };
    if package_up_to_date {
        return Ok(LauncherModsInstallResult {
            target_dir: mods_dir.to_string_lossy().to_string(),
            installed_files: 0,
            skipped: true,
            version_tag: normalized_tag,
            manifest_url: normalized_manifest_url,
        });
    }

    let installed_files = if let Some(manifest_source) = normalized_manifest_url.as_deref() {
        install_launcher_manifest_package(
            window,
            ipc_session,
            manifest_source,
            &normalized_tag,
            &mods_dir,
            previous_marker.as_ref(),
            clean_existing,
        )?
    } else {
        let download_file_name =
            launcher_mod_package_file_name(&normalized_url, &version_id, &normalized_tag);
        let temp_download_path = env::temp_dir().join(format!(
            "fpsmaster-launcher-mods-{}-{}-{}",
            std::process::id(),
            now_epoch_millis(),
            download_file_name
        ));
        emit_launch_prepare_ipc(
            ipc_session,
            "progress",
            "mods",
            "download",
            Some(0),
            Some(100),
            &format!("Downloading package {download_file_name}"),
            None,
        );
        emit_launch_prepare_item(
            ipc_session,
            "item-start",
            "mods",
            &normalized_url,
            &download_file_name,
            "package",
            Some(0),
            None,
            None,
            "Downloading",
        );
        // The package is a single file, so unlike the manifest path there is no
        // per-file counter to move the bar. Stream byte-level progress instead so the
        // prepare dialog's task bar and the file row advance while it downloads.
        let progress_session = ipc_session.map(str::to_string);
        let progress_item_id = normalized_url.clone();
        let progress_item_name = download_file_name.clone();
        let progress_callback: DownloadProgressCallback =
            Arc::new(move |downloaded: u64, total: Option<u64>| {
                emit_launch_prepare_item(
                    progress_session.as_deref(),
                    "item-progress",
                    "mods",
                    &progress_item_id,
                    &progress_item_name,
                    "package",
                    Some(downloaded as i64),
                    total.map(|value| value as i64),
                    None,
                    "Downloading",
                );
                if let Some(total) = total.filter(|value| *value > 0) {
                    let percent = (downloaded.saturating_mul(100) / total).min(100) as i32;
                    emit_launch_prepare_ipc(
                        progress_session.as_deref(),
                        "progress",
                        "mods",
                        "download",
                        Some(percent),
                        Some(100),
                        &format!("Downloading {progress_item_name} ({percent}%)"),
                        None,
                    );
                }
            });
        let download_result = download_file_blocking(
            None,
            "launcher-mods",
            &normalized_url,
            &temp_download_path,
            normalize_download_threads(Some(DEFAULT_DOWNLOAD_THREADS)),
            Some(progress_callback),
        );
        emit_launch_prepare_item(
            ipc_session,
            "item-complete",
            "mods",
            &normalized_url,
            &download_file_name,
            "package",
            None,
            None,
            Some(false),
            "Downloaded",
        );
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
            clean_existing,
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
    let package_is_supported = match marker.as_ref() {
        Some(installed_marker) if installed => {
            !launcher_package_has_unsupported_runtime_mods(&mods_dir, installed_marker)?
                && !mods_dir_has_unsupported_runtime_mods(&mods_dir)?
        }
        Some(_) => false,
        None => false,
    };
    // "Up to date" is purely about content identity: same version, and — when both
    // sides carry a content hash — the same bytes. The download/manifest URL is a
    // transport detail (http vs https, CDN swap, domain migration) that does NOT
    // change what's installed, so it is deliberately excluded here. Local
    // integrity/support is reported separately via `needs_repair`.
    //
    // `expected_manifest_url` / `expected_download_url` are still accepted for API
    // compatibility but no longer participate in the freshness decision.
    let _ = (&expected_manifest_url, &expected_download_url);
    let up_to_date = match (marker.as_ref(), expected_version_tag.as_ref()) {
        (Some(installed_marker), Some(expected_tag)) => {
            let version_matches = installed_marker.version_tag.trim() == expected_tag.trim();
            // Only let the checksum veto a match when BOTH sides actually have one
            // and they differ. A missing checksum on either side (older markers, or
            // catalog entries without one) falls back to the version-tag check
            // rather than forcing a spurious "update available".
            let checksum_matches = match (
                installed_marker.checksum.as_deref(),
                expected_checksum.as_deref(),
            ) {
                (Some(installed_checksum), Some(expected_checksum_value)) => {
                    installed_checksum.trim() == expected_checksum_value.trim()
                }
                _ => true,
            };
            version_matches && checksum_matches
        }
        // No expected version to compare against: treat the install as current.
        (Some(_), None) => true,
        _ => false,
    };
    Ok(LauncherPackageState {
        installed,
        up_to_date: installed && up_to_date,
        needs_repair: installed && !package_is_supported,
        version_tag,
        checksum,
        manifest_url,
    })
}

fn install_launcher_manifest_package(
    window: Option<&tauri::Window>,
    ipc_session: Option<&str>,
    manifest_url: &str,
    expected_version_tag: &str,
    mods_dir: &Path,
    previous_marker: Option<&LauncherModsInstallMarker>,
    clean_existing: bool,
) -> Result<Vec<LauncherInstalledFileRecord>, String> {
    let _ = window;
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
    let install_result =
        install_manifest_files_into_stage(ipc_session, manifest_url, &manifest, &stage_dir);
    if let Err(err) = install_result {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(err);
    }
    let mut installed_files = install_result?;
    sanitize_launcher_mod_package(&stage_dir, &mut installed_files)?;

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

    let mut installed_files = extract_launcher_mod_archive(archive_path, stage_dir)?;
    sanitize_launcher_mod_package(stage_dir, &mut installed_files)?;
    Ok(installed_files)
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
    ipc_session: Option<&str>,
    manifest_url: &str,
    manifest: &LauncherPackageManifest,
    stage_dir: &Path,
) -> Result<Vec<LauncherInstalledFileRecord>, String> {
    let client = build_blocking_http_client()?;
    let base_url = resolve_manifest_base_url(manifest_url, manifest.base_url.as_deref())?;
    let mut installed_files = Vec::new();
    let total = manifest.files.len() as i32;
    emit_launch_prepare_ipc(
        ipc_session,
        "progress",
        "mods",
        "download",
        Some(0),
        Some(total),
        "Syncing mods",
        None,
    );

    for (index, entry) in manifest.files.iter().enumerate() {
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

        let file_name = relative_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| relative_path.to_string_lossy().to_string());
        emit_launch_prepare_item(
            ipc_session,
            "item-start",
            "mods",
            &entry.path,
            &file_name,
            "mod",
            entry.size.map(|_| 0),
            entry.size.map(|size| size as i64),
            None,
            "Downloading",
        );

        download_file_quiet_blocking(&client, &resolved_url, &target_path).map_err(|err| {
            emit_launch_prepare_item(
                ipc_session,
                "item-error",
                "mods",
                &entry.path,
                &file_name,
                "mod",
                None,
                None,
                None,
                "Failed",
            );
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

        emit_launch_prepare_item(
            ipc_session,
            "item-complete",
            "mods",
            &entry.path,
            &file_name,
            "mod",
            entry.size.map(|size| size as i64),
            entry.size.map(|size| size as i64),
            Some(false),
            "Downloaded",
        );
        emit_launch_prepare_ipc(
            ipc_session,
            "progress",
            "mods",
            "download",
            Some(index as i32 + 1),
            Some(total),
            &format!("Synced {} ({}/{})", file_name, index + 1, total),
            None,
        );
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

pub(crate) const LAUNCHER_HTTP_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FPSMasterLauncher (+https://github.com/fpsmasterteam)";

pub(crate) fn build_blocking_http_client() -> Result<reqwest::blocking::Client, String> {
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

pub(crate) fn sanitize_file_name(raw: &str) -> String {
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
    let opti_fine_version = None;

    Ok(InstanceProfileMetadata {
        version_id,
        base_version,
        loader,
        loader_version,
        opti_fine_version,
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

pub(crate) fn download_file_quiet_blocking(
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

pub(crate) fn verify_file_sha256(path: &Path, expected_checksum: &str) -> Result<(), String> {
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

fn install_cancel_state() -> &'static Mutex<HashSet<String>> {
    INSTALL_CANCEL_STATE.get_or_init(|| Mutex::new(HashSet::new()))
}

fn request_install_cancel(session_id: &str) -> Result<(), String> {
    let normalized = session_id.trim();
    if normalized.is_empty() {
        return Err("Install session cannot be empty".to_string());
    }
    let mut state = install_cancel_state()
        .lock()
        .map_err(|_| "Install cancel state lock poisoned".to_string())?;
    state.insert(normalized.to_string());
    Ok(())
}

fn clear_install_cancel(session_id: Option<&str>) {
    let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    if let Ok(mut state) = install_cancel_state().lock() {
        state.remove(session_id);
    }
}

pub(crate) fn is_install_cancelled(session_id: Option<&str>) -> bool {
    let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    install_cancel_state()
        .lock()
        .map(|state| state.contains(session_id))
        .unwrap_or(false)
}

#[tauri::command]
async fn cancel_install(session_id: String) -> Result<(), String> {
    request_install_cancel(&session_id)
}

#[tauri::command]
async fn list_vanilla_versions(
    window: tauri::Window,
    download_source: Option<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        minecraft_core::list_vanilla_versions(Some(&window), download_source.as_deref())
    })
    .await
    .map_err(|e| format!("Failed to join vanilla version listing task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("list_vanilla_versions", e))
}

#[tauri::command]
async fn install_vanilla(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    download_source: Option<String>,
    download_threads: Option<i32>,
    ipc_session: Option<String>,
) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = ipc_session.clone();
        let game_dir_path = resolve_game_dir_path(&game_dir)?;
        let normalized_download_threads = normalize_download_threads(download_threads);
        let result = minecraft_core::install_vanilla(
            Some(&window),
            &game_dir_path,
            &version_id,
            download_source.as_deref(),
            normalized_download_threads,
            ipc_session.as_deref(),
        );
        clear_install_cancel(session.as_deref());
        result
    })
    .await
    .map_err(|e| format!("Failed to join vanilla install task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("install_vanilla", e))
}

#[tauri::command]
async fn verify_installed_files(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    download_source: Option<String>,
    download_threads: Option<i32>,
    ipc_session: Option<String>,
) -> Result<VerifyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = ipc_session.clone();
        let game_dir_path = resolve_game_dir_path(&game_dir)?;
        let normalized_download_threads = normalize_download_threads(download_threads);
        let result = minecraft_core::verify_installed_files(
            Some(&window),
            &game_dir_path,
            &version_id,
            download_source.as_deref(),
            normalized_download_threads,
            ipc_session.as_deref(),
        );
        clear_install_cancel(session.as_deref());
        result
    })
    .await
    .map_err(|e| format!("Failed to join verify task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("verify_installed_files", e))
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
    tauri::async_runtime::spawn_blocking(move || {
        let game_dir_path = resolve_game_dir_path(&game_dir)?;
        let java_executable = java_path
            .map(|value| PathBuf::from(value.trim()))
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| {
                game_dir_path
                    .join("runtime")
                    .join("bin")
                    .join(if cfg!(windows) { "java.exe" } else { "java" })
            });
        let request = VanillaLaunchRequest {
            game_dir: game_dir_path,
            version_id,
            player_name,
            uuid,
            access_token,
            java_path: java_executable,
            max_memory_mb,
            server_address: None,
            fpsmaster_token: None,
        };
        minecraft_core::build_vanilla_launch_plan(
            Some(&window),
            &request,
            download_source.as_deref(),
        )
        .map(|value| value.plan)
    })
    .await
    .map_err(|e| format!("Failed to join launch plan task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("build_vanilla_launch_plan", e))
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
    fpsmaster_token: Option<String>,
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
            fpsmaster_token,
        )
    })
    .await
    .map_err(|e| format!("Failed to join launch task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("launch_vanilla", e))
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
    fpsmaster_token: Option<String>,
) -> Result<LaunchExecutionResult, String> {
    if let Some(pid) = detect_active_game_pid() {
        return Err(format!(
            "Another game process is already running (pid={pid}). Stop it before launching a new instance."
        ));
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let resolved_plan = minecraft_core::build_vanilla_launch_plan(
        Some(&window),
        &VanillaLaunchRequest {
            game_dir: game_dir_path.clone(),
            version_id: version_id.clone(),
            player_name: player_name.clone(),
            uuid: uuid.clone(),
            access_token: access_token.clone(),
            java_path: java_path.as_deref().map(PathBuf::from).unwrap_or_else(|| {
                game_dir_path
                    .join("runtime")
                    .join("bin")
                    .join(if cfg!(windows) { "java.exe" } else { "java" })
            }),
            max_memory_mb,
            server_address: server_address.clone(),
            fpsmaster_token: fpsmaster_token.clone(),
        },
        download_source.as_deref(),
    )?;
    let plan = resolved_plan.plan;
    let natives_dir = resolved_plan.natives_dir;

    let mut normalized_command = normalize_game_command_tokens(plan.command.clone());
    if normalized_command.is_empty() {
        cleanup_launch_natives_dir(&natives_dir);
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
    let mut child = match spawn_game_process(Some(&window), &runtime_dir, &executable, &args) {
        Ok(child) => child,
        Err(error) => {
            cleanup_launch_natives_dir(&natives_dir);
            return Err(error);
        }
    };
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

    let stdout_handle = pump_game_stream(stdout, "stdout");
    let stderr_handle = pump_game_stream(stderr, "stderr");
    if should_wait {
        let status = child
            .wait()
            .map_err(|e| format!("Failed waiting game process: {e}"))?;
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();
        let exit_code = status.code().unwrap_or(-1);
        cleanup_launch_natives_dir(&natives_dir);
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

    let wait_natives_dir = natives_dir.clone();
    let wait_window = window.clone();
    thread::spawn(move || {
        let exit_code = child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(-1);
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();
        cleanup_launch_natives_dir(&wait_natives_dir);
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

// ---------------------------------------------------------------------------
// Native-app distributables (FPSMaster-Extreme)
//
// Extreme ships as a native `fpsmaster_app` binary, not a Java Minecraft
// instance, so it bypasses the vanilla/loader install and `launch_vanilla`
// Java pipeline. It is downloaded as a tarball, verified, extracted into
// `{gameDir}/apps/<versionId>/`, and launched directly with that dir as the
// working directory (the client resolves mods/resourcepacks/local_assets/config
// relative to CWD). Contract: FPSMaster-Extreme/docs/LAUNCHER_INTEGRATION.md.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct NativeAppInstallMarker {
    #[serde(rename = "versionTag")]
    version_tag: String,
    #[serde(default)]
    checksum: Option<String>,
    #[serde(rename = "downloadUrl", default)]
    download_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct NativeAppInstallResult {
    #[serde(rename = "installDir")]
    install_dir: String,
    #[serde(rename = "versionTag")]
    version_tag: String,
    skipped: bool,
}

fn native_app_binary_name() -> &'static str {
    if cfg!(windows) {
        "fpsmaster_app.exe"
    } else {
        "fpsmaster_app"
    }
}

fn native_app_install_dir(game_dir_path: &Path, version_id: &str) -> PathBuf {
    game_dir_path.join("apps").join(version_id)
}

fn native_app_marker_path(install_dir: &Path) -> PathBuf {
    install_dir.join(".fpsmaster-launcher-app.json")
}

/// Best-effort: drop the macOS quarantine attribute from a freshly extracted
/// tree so a signed+notarized binary launches without a Gatekeeper prompt.
/// A no-op (and ignored failure) on non-macOS.
fn clear_quarantine(_path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(_path)
            .status();
    }
}

#[tauri::command]
async fn install_native_app(
    game_dir: String,
    version_id: String,
    download_url: String,
    version_tag: Option<String>,
    checksum: Option<String>,
) -> Result<NativeAppInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_native_app_blocking(game_dir, version_id, download_url, version_tag, checksum)
    })
    .await
    .map_err(|e| format!("Failed to join native app install task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("install_native_app", e))
}

fn install_native_app_blocking(
    game_dir: String,
    version_id: String,
    download_url: String,
    version_tag: Option<String>,
    checksum: Option<String>,
) -> Result<NativeAppInstallResult, String> {
    if !is_native_app_version_id(&version_id) {
        return Err(format!("{version_id} is not a native-app distributable"));
    }
    let normalized_url = download_url.trim().to_string();
    if normalized_url.is_empty() {
        return Err("downloadUrl is empty".to_string());
    }
    let normalized_tag = version_tag
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| normalized_url.clone());
    let normalized_checksum = checksum
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let install_dir = native_app_install_dir(&game_dir_path, &version_id);
    let marker_path = native_app_marker_path(&install_dir);
    let binary_path = install_dir.join(native_app_binary_name());

    // Up to date? Same tag + checksum and the binary is present → skip.
    if binary_path.exists() {
        if let Ok(bytes) = fs::read(&marker_path) {
            if let Ok(marker) = serde_json::from_slice::<NativeAppInstallMarker>(&bytes) {
                if marker.version_tag == normalized_tag && marker.checksum == normalized_checksum {
                    return Ok(NativeAppInstallResult {
                        install_dir: install_dir.to_string_lossy().to_string(),
                        version_tag: normalized_tag,
                        skipped: true,
                    });
                }
            }
        }
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent(JDK_DOWNLOAD_USER_AGENT)
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let tmp_dir = game_dir_path.join("apps").join(".downloads");
    fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create download dir {}: {e}", tmp_dir.display()))?;
    let archive_path = tmp_dir.join(format!("{version_id}-{normalized_tag}.tar.gz"));

    download_file_quiet_blocking(&client, &normalized_url, &archive_path)?;
    if let Some(expected) = normalized_checksum.as_deref() {
        verify_file_sha256(&archive_path, expected).map_err(|err| {
            let _ = fs::remove_file(&archive_path);
            format!("Checksum mismatch for {version_id}: {err}")
        })?;
    }

    // Replace the install dir atomically-ish: extract into a fresh temp, then swap.
    if install_dir.exists() {
        fs::remove_dir_all(&install_dir)
            .map_err(|e| format!("Failed to clear {}: {e}", install_dir.display()))?;
    }
    fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create {}: {e}", install_dir.display()))?;
    extract_tar_gz_into(&archive_path, &install_dir)?;
    let _ = fs::remove_file(&archive_path);

    if !binary_path.exists() {
        return Err(format!(
            "Extracted package is missing {} at {}",
            native_app_binary_name(),
            binary_path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&binary_path) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o755);
            let _ = fs::set_permissions(&binary_path, perms);
        }
    }
    clear_quarantine(&install_dir);

    let marker = NativeAppInstallMarker {
        version_tag: normalized_tag.clone(),
        checksum: normalized_checksum,
        download_url: Some(normalized_url),
    };
    let marker_bytes =
        serde_json::to_vec_pretty(&marker).map_err(|e| format!("Failed to encode marker: {e}"))?;
    fs::write(&marker_path, marker_bytes)
        .map_err(|e| format!("Failed to write marker {}: {e}", marker_path.display()))?;

    Ok(NativeAppInstallResult {
        install_dir: install_dir.to_string_lossy().to_string(),
        version_tag: normalized_tag,
        skipped: false,
    })
}

/// Extract the vanilla 1.8.9 `assets/` tree out of the Minecraft client jar the
/// launcher already downloaded, into `{installDir}/local_assets/minecraft-1.8.9/`,
/// and return the `assets/minecraft` path to feed the client's `--assets`. Runs
/// once; subsequent calls short-circuit if the tree is already present. This is
/// how Extreme gets textures/sounds legally without bundling Mojang assets — see
/// LAUNCHER_INTEGRATION.md §5.
#[tauri::command]
async fn prepare_extreme_assets(game_dir: String, version_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_extreme_assets_blocking(game_dir, version_id)
    })
    .await
    .map_err(|e| format!("Failed to join asset-prep task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("prepare_extreme_assets", e))
}

fn prepare_extreme_assets_blocking(game_dir: String, version_id: String) -> Result<String, String> {
    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let install_dir = native_app_install_dir(&game_dir_path, &version_id);
    let assets_root = install_dir.join("local_assets").join("minecraft-1.8.9");
    let assets_minecraft = assets_root.join("assets").join("minecraft");
    if assets_minecraft.is_dir() {
        return Ok(assets_minecraft.to_string_lossy().to_string());
    }

    // The launcher installs vanilla clients under versions/<id>/<id>.jar.
    let jar_path = game_dir_path
        .join("versions")
        .join("1.8.9")
        .join("1.8.9.jar");
    if !jar_path.exists() {
        return Err(format!(
            "1.8.9 client jar not found at {} — install the vanilla 1.8.9 client first",
            jar_path.display()
        ));
    }

    let file = fs::File::open(&jar_path)
        .map_err(|e| format!("Failed opening client jar {}: {e}", jar_path.display()))?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file))
        .map_err(|e| format!("Invalid client jar: {e}"))?;
    let mut extracted = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("Failed reading jar entry: {e}"))?;
        let name = entry.name().to_string();
        // Only the resource tree; skip .class files and META-INF.
        if !name.starts_with("assets/") || name.ends_with('/') {
            continue;
        }
        let out_path = assets_root.join(&name);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        let mut out = fs::File::create(&out_path)
            .map_err(|e| format!("Failed to write {}: {e}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("Failed extracting {name}: {e}"))?;
        extracted += 1;
    }
    if extracted == 0 || !assets_minecraft.is_dir() {
        return Err("Client jar contained no assets/minecraft resources".to_string());
    }
    Ok(assets_minecraft.to_string_lossy().to_string())
}

#[tauri::command]
async fn launch_native_app(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    player_name: Option<String>,
    assets_path: Option<String>,
    server_address: Option<String>,
    wait_for_exit: Option<bool>,
) -> Result<LaunchExecutionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        launch_native_app_blocking(
            window,
            game_dir,
            version_id,
            player_name,
            assets_path,
            server_address,
            wait_for_exit,
        )
    })
    .await
    .map_err(|e| format!("Failed to join native launch task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("launch_native_app", e))
}

fn launch_native_app_blocking(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    player_name: Option<String>,
    assets_path: Option<String>,
    server_address: Option<String>,
    wait_for_exit: Option<bool>,
) -> Result<LaunchExecutionResult, String> {
    if !is_native_app_version_id(&version_id) {
        return Err(format!("{version_id} is not a native-app distributable"));
    }
    if let Some(pid) = detect_active_game_pid() {
        return Err(format!(
            "Another game process is already running (pid={pid}). Stop it before launching a new instance."
        ));
    }

    let game_dir_path = resolve_game_dir_path(&game_dir)?;
    let install_dir = native_app_install_dir(&game_dir_path, &version_id);
    let binary_path = install_dir.join(native_app_binary_name());
    if !binary_path.exists() {
        return Err(format!(
            "{version_id} is not installed (missing {})",
            binary_path.display()
        ));
    }

    // Build the CLI per the launch contract (LAUNCHER_INTEGRATION.md §6). The
    // working directory is the install dir (set by spawn_game_process), which the
    // client needs to resolve mods/resourcepacks/local_assets/config.
    let mut args: Vec<String> = Vec::new();
    if let Some(assets) = assets_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        args.push("--assets".to_string());
        args.push(assets);
    }
    if let Some(server) = server_address
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        args.push("--connect".to_string());
        args.push(server);
    }
    if let Some(name) = player_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        args.push("--username".to_string());
        args.push(name);
    }

    let executable = binary_path.to_string_lossy().to_string();
    emit_log(
        Some(&window),
        "info",
        &format!(
            "launch native app: {}",
            format_quoted_command(&executable, &args)
        ),
    );

    let mut child = spawn_game_process(Some(&window), &install_dir, &executable, &args)?;
    let pid = i64::from(child.id());
    if let Ok(mut store) = game_runtime_starts().lock() {
        store.insert(pid, std::time::Instant::now());
    }
    ensure_game_runtime_sampler();
    push_ui_log("game", "stdout", &format!("[process] started pid={pid}"));

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture game stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture game stderr".to_string())?;
    let stdout_handle = pump_game_stream(stdout, "stdout");
    let stderr_handle = pump_game_stream(stderr, "stderr");

    let should_wait = wait_for_exit.unwrap_or(false);
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
            main_class: "native".to_string(),
            shell: "direct".to_string(),
            command: std::iter::once(executable).chain(args).collect(),
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
        wait_for_exit: false,
        exit_code: None,
        main_class: "native".to_string(),
        shell: "direct".to_string(),
        command: std::iter::once(executable).chain(args).collect(),
    })
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

fn cleanup_launch_natives_dir(natives_dir: &Path) {
    if let Err(error) = fs::remove_dir_all(natives_dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            push_ui_log(
                "core",
                "warn",
                &format!(
                    "Failed cleaning natives directory {}: {}",
                    natives_dir.display(),
                    error
                ),
            );
        }
    }
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

pub(crate) fn open_file_with_system(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // `cmd /C start` re-parses its own command line, so a path containing cmd
        // metacharacters (`&`, `^`, spaces, …) must be wrapped in quotes or cmd
        // mis-splits it (e.g. `C:\a&b` runs `b` as a second command). `start` also
        // treats the first quoted token as the window title, hence the empty `""`.
        // `raw_arg` bypasses Rust's own arg quoting — which leaves a metachar-only,
        // space-free path unquoted — and lets us wrap the path ourselves. A Windows
        // path cannot contain a literal `"`, so the wrapping is unambiguous.
        let mut command = Command::new("cmd");
        command.raw_arg(format!("/C start \"\" \"{}\"", path.display()));
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

/// Map the raw OS error behind a failed `Command::spawn` to a human-readable
/// (Chinese) explanation of the most common causes. Returns `None` when the code
/// is not one we have specific guidance for. Codes are OS-specific, so this is
/// gated per platform: e.g. 193 (`ERROR_BAD_EXE_FORMAT`) only exists on Windows,
/// while `ENOEXEC`(8)/`ENOENT`(2)/`EACCES`(13) are the unix equivalents.
fn spawn_failure_hint(err: &std::io::Error) -> Option<&'static str> {
    let code = err.raw_os_error()?;
    #[cfg(windows)]
    let hint = match code {
        193 => Some(
            "该文件不是有效的 Win32 程序:通常是二进制架构不符(例如把 arm64/其它平台的构建装到了 x64 机器上)、\
下载被截断或文件损坏。请删除对应的运行时/安装目录后重新下载;若设置了自定义 Java 路径,请改回内置运行时。",
        ),
        2 => Some("系统找不到指定文件:安装可能不完整,或可执行文件已被移动/删除。"),
        5 => Some("拒绝访问:可能被杀毒软件/SmartScreen 隔离或锁定,或当前账户权限不足。"),
        _ => None,
    };
    #[cfg(not(windows))]
    let hint = match code {
        8 => Some("Exec format error:二进制的架构或格式与当前系统不符,或文件已损坏。"),
        2 => Some("No such file or directory:安装不完整,或可执行文件路径已失效。"),
        13 => Some("Permission denied:该文件缺少可执行(x)权限。"),
        _ => None,
    };
    hint
}

/// Build a full diagnostic for a failed process spawn: the raw error, whether the
/// target exists (and its size — a 0/partial byte count usually means a truncated
/// download), the working directory state, and the launcher's own OS/arch so an
/// architecture mismatch is obvious in the log. This is what turns an opaque
/// "os error 193" into something actionable.
fn describe_spawn_failure(
    executable: &str,
    args: &[String],
    game_dir: &Path,
    err: &std::io::Error,
) -> String {
    use std::fmt::Write as _;
    let mut detail = format!("启动进程失败: {err}");
    match fs::metadata(Path::new(executable)) {
        Ok(meta) => {
            let kind = if meta.is_dir() { "目录" } else { "文件" };
            let _ = write!(
                detail,
                "\n  目标程序: {executable}  (存在, {kind}, {} 字节)",
                meta.len()
            );
        }
        Err(meta_err) => {
            let _ = write!(detail, "\n  目标程序: {executable}  (无法访问: {meta_err})");
        }
    }
    let dir_state = if game_dir.is_dir() {
        "存在"
    } else {
        "缺失"
    };
    let _ = write!(
        detail,
        "\n  工作目录: {}  ({dir_state})",
        game_dir.display()
    );
    let _ = write!(detail, "\n  参数个数: {}", args.len());
    let _ = write!(
        detail,
        "\n  启动器架构: {}-{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    if let Some(hint) = spawn_failure_hint(err) {
        let _ = write!(detail, "\n  可能原因: {hint}");
    }
    detail
}

fn spawn_game_process(
    window: Option<&tauri::Window>,
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

    command.spawn().map_err(|e| {
        // Echo the full diagnostic to the log so the failure leaves a complete
        // trail in the monitor, then return it so the dialog is actionable too.
        let diagnostic = describe_spawn_failure(executable, args, game_dir, &e);
        emit_log(window, "error", &diagnostic);
        diagnostic
    })
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

// In-process memory query via sysinfo. The previous implementation spawned
// `ps`/`tasklist` on every sample (every 2s while a game runs) — subprocess
// creation is expensive, especially on Windows, and adds contention exactly
// when the game is loading the machine. Returns Ok(None) when the process is
// gone, which is also how callers detect "not running".
fn query_process_memory_kb(pid: i64) -> Result<Option<u64>, String> {
    let pid_u32 = match u32::try_from(pid) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let sys_pid = sysinfo::Pid::from_u32(pid_u32);
    let mut system = process_memory_sampler()
        .lock()
        .map_err(|e| format!("Process sampler lock poisoned: {e}"))?;
    let refreshed = system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[sys_pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing().with_memory(),
    );
    if refreshed == 0 {
        return Ok(None);
    }
    // memory() is in bytes.
    Ok(system
        .process(sys_pid)
        .map(|process| process.memory() / 1024))
}

fn process_memory_sampler() -> &'static Mutex<sysinfo::System> {
    PROCESS_MEMORY_SAMPLER.get_or_init(|| Mutex::new(sysinfo::System::new()))
}

fn managed_jdk_runtime_root(game_dir: &Path, major: i32, x64: bool) -> PathBuf {
    // x64 (Rosetta/emulated) runtimes live in a separate dir so a version that needs
    // x64 natives (e.g. MC 1.18) never reuses a native-arch runtime of the same major
    // installed for a newer version (e.g. MC 1.19) — and vice versa.
    let name = if x64 {
        format!("jdk-{major}-x64")
    } else {
        format!("jdk-{major}")
    };
    game_dir.join("runtime").join(name)
}

// Whether the emulated-x64 runtime for this Java major should come from Azul Zulu
// instead of Mojang. Only the macOS Java 8 case (jre-legacy = 8u74) is known-broken:
// LWJGL 2 versions (MC <= 1.12) go through AWT, whose ancient build crashes on
// macOS >= 14.4. LWJGL 3 majors (16/17) don't use AWT for the window, so Mojang's
// builds stay in use there.
fn prefers_zulu_over_mojang_x64(major: i32, force_x64: bool) -> bool {
    cfg!(target_os = "macos") && force_x64 && major == 8
}

// Mojang's macOS runtimes extract as <root>/jre.bundle/Contents/Home/bin/java; Zulu
// archives never contain a `jre.bundle` component. Used to spot pre-Zulu installs.
fn is_mojang_bundle_layout(java_path: &Path) -> bool {
    java_path
        .components()
        .any(|component| component.as_os_str() == "jre.bundle")
}

fn ensure_managed_jdk_runtime(
    window: Option<&tauri::Window>,
    runtime_root: &Path,
    major: i32,
    download_threads: Option<i32>,
    force_x64: bool,
) -> Result<PathBuf, String> {
    fs::create_dir_all(runtime_root).map_err(|e| {
        format!(
            "Failed creating runtime dir {}: {e}",
            runtime_root.display()
        )
    })?;

    if let Some(java_path) = locate_java_binary(runtime_root) {
        if prefers_zulu_over_mojang_x64(major, force_x64) && is_mojang_bundle_layout(&java_path) {
            // A Mojang jre-legacy install from before the Zulu switch — it crashes on
            // modern macOS (see below), so wipe it and reinstall instead of reusing it.
            emit_log(
                window,
                "warn",
                "Replacing Mojang jre-legacy x64 runtime: its AWT crashes on macOS 14.4+",
            );
            fs::remove_dir_all(runtime_root).map_err(|e| {
                format!(
                    "Failed removing outdated runtime {}: {e}",
                    runtime_root.display()
                )
            })?;
            fs::create_dir_all(runtime_root).map_err(|e| {
                format!(
                    "Failed creating runtime dir {}: {e}",
                    runtime_root.display()
                )
            })?;
        } else {
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
    }

    let normalized_download_threads = normalize_download_threads(download_threads);
    let component = mojang_java_component_for_major(major);
    let platform_keys = mojang_java_platform_keys();
    let native_key = platform_keys.first().copied();
    let x64_key = platform_keys.last().copied();
    emit_log(
        window,
        "info",
        &format!(
            "Resolving Mojang runtime component={component} major={major} force_x64={force_x64}"
        ),
    );

    if force_x64 {
        // The game ships only x64 native libs (old LWJGL); the JVM must be x64 too, so
        // it runs under Rosetta 2 / Windows-on-ARM emulation. A native-arch JVM here
        // would fail to load the natives (UnsatisfiedLinkError).
        let key =
            x64_key.ok_or_else(|| format!("No x64 Mojang runtime platform for major={major}"))?;
        // Mojang's only x64 Java 8 for macOS is jre-legacy (8u74, from 2016). AWT in
        // builds that old crashes on macOS >= 14.4 the moment LWJGL 2 creates the game
        // window: an AppKit CADisplayLink change makes the flush observer throw, and
        // +[NSApplication _crashOnException:] takes the process down with SIGILL
        // (fixed upstream in 8u412). Install a current Zulu x64 JRE instead and keep
        // the Mojang runtime only as a fallback when Azul is unreachable.
        let mut installed = false;
        if prefers_zulu_over_mojang_x64(major, force_x64) {
            match install_zulu_jre_archive(
                window,
                runtime_root,
                major,
                normalized_download_threads,
                "x64",
            ) {
                Ok(()) => installed = true,
                Err(zulu_err) => emit_log(
                    window,
                    "warn",
                    &format!(
                        "Zulu x64 JRE unavailable ({zulu_err}); falling back to Mojang x64 runtime"
                    ),
                ),
            }
        }
        if !installed
            && !install_mojang_java_runtime(
                window,
                runtime_root,
                component,
                major,
                normalized_download_threads,
                &[key],
            )?
        {
            return Err(format!("No x64 Mojang runtime available for {component}"));
        }
    } else {
        // 1) Mojang's runtime for the native CPU arch (no emulation).
        let native = native_key
            .ok_or_else(|| format!("Unsupported platform for Mojang runtime, major={major}"))?;
        let installed = install_mojang_java_runtime(
            window,
            runtime_root,
            component,
            major,
            normalized_download_threads,
            &[native],
        )?;
        if !installed {
            // 2) Mojang has no native build (e.g. macOS arm64 + Java 8/16). Try a native
            //    third-party JRE before considering emulation.
            emit_log(
                window,
                "info",
                &format!("No native Mojang runtime for {component}; fetching native JRE for major={major}"),
            );
            match install_native_jre_archive(
                window,
                runtime_root,
                major,
                normalized_download_threads,
            ) {
                Ok(()) => {}
                Err(native_err) => {
                    // 3) Last resort: Mojang's x64 build via emulation.
                    emit_log(
                        window,
                        "warn",
                        &format!("Native JRE unavailable ({native_err}); falling back to emulated x64 runtime"),
                    );
                    let key = x64_key
                        .ok_or_else(|| format!("No Java runtime available for major={major}"))?;
                    if !install_mojang_java_runtime(
                        window,
                        runtime_root,
                        component,
                        major,
                        normalized_download_threads,
                        &[key],
                    )? {
                        return Err(format!("No Java runtime available for major={major}"));
                    }
                }
            }
        }
    }

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
                    // The UI reads game output by polling `poll_ui_logs`, so we only
                    // need to record it in the store. Emitting a Tauri event per line
                    // (nothing listens) flooded the process with serialization/IPC for
                    // every Minecraft log line — a major CPU sink during gameplay.
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
    tauri::async_runtime::spawn_blocking(move || {
        list_fabric_loaders_blocking_core(
            Some(&window),
            game_version.trim(),
            download_source.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Failed to join fabric loader listing task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("list_fabric_loaders", e))
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
    minecraft_core::list_fabric_loader_versions(window, normalized_game_version, download_source)
}

#[tauri::command]
async fn install_fabric(
    window: tauri::Window,
    game_dir: String,
    game_version: String,
    loader_version: String,
    download_source: Option<String>,
    download_threads: Option<i32>,
    ipc_session: Option<String>,
) -> Result<FabricInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = ipc_session.clone();
        let normalized_download_threads = normalize_download_threads(download_threads);
        let game_dir_path = resolve_game_dir_path(&game_dir)?;
        let result = minecraft_core::install_fabric(
            Some(&window),
            &game_dir_path,
            &game_version,
            &loader_version,
            download_source.as_deref(),
            normalized_download_threads,
            ipc_session.as_deref(),
        );
        clear_install_cancel(session.as_deref());
        result
    })
    .await
    .map_err(|e| format!("Failed to join fabric install task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("install_fabric", e))
}

fn install_fabric_blocking_core(
    window: Option<&tauri::Window>,
    game_dir: &Path,
    game_version: &str,
    loader_version: &str,
    download_source: Option<&str>,
    download_threads: Option<i32>,
) -> Result<FabricInstallResult, String> {
    let normalized_game_version = game_version.trim();
    if normalized_game_version.is_empty() {
        return Err("Game version cannot be empty".to_string());
    }
    let normalized_loader_version = loader_version.trim();
    if normalized_loader_version.is_empty() {
        return Err("Loader version cannot be empty".to_string());
    }
    let normalized_download_threads = normalize_download_threads(download_threads);
    minecraft_core::install_fabric(
        window,
        game_dir,
        normalized_game_version,
        normalized_loader_version,
        download_source,
        normalized_download_threads,
        None,
    )
}

#[tauri::command]
async fn list_forge_versions(
    window: tauri::Window,
    game_version: String,
    download_source: Option<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_forge_versions_blocking_core(
            Some(&window),
            game_version.trim(),
            download_source.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Failed to join forge version listing task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("list_forge_versions", e))
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
    minecraft_core::list_forge_versions(window, normalized_game_version, download_source)
}

#[tauri::command]
async fn list_optifine_versions(
    window: tauri::Window,
    game_version: String,
    loader: String,
    loader_version: Option<String>,
    download_source: Option<String>,
) -> Result<Vec<OptiFineVersionInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let normalized_game_version = game_version.trim().to_string();
        if normalized_game_version.is_empty() {
            return Err("Game version cannot be empty".to_string());
        }
        let normalized_loader = normalize_loader_kind(&loader)?;
        minecraft_core::list_optifine_versions(
            Some(&window),
            &normalized_game_version,
            &normalized_loader,
            loader_version.as_deref(),
            download_source.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Failed to join OptiFine version listing task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("list_optifine_versions", e))
}

#[tauri::command]
async fn install_optifine(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
    game_version: String,
    loader: String,
    loader_version: Option<String>,
    optifine_version: String,
    download_source: Option<String>,
    ipc_session: Option<String>,
) -> Result<OptiFineInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = ipc_session.clone();
        let game_dir_path = resolve_game_dir_path(&game_dir)?;
        let normalized_loader = normalize_loader_kind(&loader)?;
        let result = minecraft_core::install_optifine(
            Some(&window),
            &game_dir_path,
            version_id.trim(),
            game_version.trim(),
            &normalized_loader,
            loader_version.as_deref(),
            optifine_version.trim(),
            download_source.as_deref(),
            ipc_session.as_deref(),
        );
        clear_install_cancel(session.as_deref());
        result
    })
    .await
    .map_err(|e| format!("Failed to join OptiFine install task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("install_optifine", e))
}

#[tauri::command]
async fn install_forge(
    window: tauri::Window,
    game_dir: String,
    forge_version: String,
    java_path: Option<String>,
    download_source: Option<String>,
    download_threads: Option<i32>,
    ipc_session: Option<String>,
) -> Result<ForgeInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = ipc_session.clone();
        let game_dir_path = resolve_game_dir_path(&game_dir)?;
        let normalized_download_threads = normalize_download_threads(download_threads);
        let java_exe = match java_path
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            Some(value) => value,
            None => ensure_managed_jdk_runtime(
                Some(&window),
                &managed_jdk_runtime_root(&game_dir_path, 17, false),
                17,
                Some(normalized_download_threads as i32),
                false,
            )?
            .to_string_lossy()
            .to_string(),
        };
        let result = minecraft_core::install_forge(
            Some(&window),
            &game_dir_path,
            &forge_version,
            Path::new(&java_exe),
            download_source.as_deref(),
            normalized_download_threads,
            ipc_session.as_deref(),
        );
        clear_install_cancel(session.as_deref());
        result
    })
    .await
    .map_err(|e| format!("Failed to join forge install task: {e}"))
    .and_then(std::convert::identity)
    .inspect_err(|e| log_command_error("install_forge", e))
}

fn install_forge_blocking_core(
    window: Option<&tauri::Window>,
    game_dir: &Path,
    forge_version: &str,
    java_path: &str,
    download_source: Option<&str>,
    download_threads: Option<i32>,
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
    let normalized_download_threads = normalize_download_threads(download_threads);
    minecraft_core::install_forge(
        window,
        game_dir,
        normalized_forge_version,
        Path::new(normalized_java),
        download_source,
        normalized_download_threads,
        None,
    )
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

/// Echo a command's failure into the monitor log before it is handed back to the
/// frontend. Without this the terse error only appears in the failure dialog and
/// never in the log the user can inspect/copy. Used from each command's tail via
/// `.inspect_err(|e| log_command_error("launch_vanilla", e))`.
fn log_command_error(command: &str, err: &str) {
    emit_log(None, "error", &format!("命令 {command} 执行失败: {err}"));
}

pub(crate) fn emit_launch_prepare_ipc(
    session: Option<&str>,
    event: &str,
    phase: &str,
    stage: &str,
    current: Option<i32>,
    total: Option<i32>,
    message: &str,
    error: Option<&str>,
) {
    let Some(session) = session.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    let mut payload = serde_json::Map::new();
    payload.insert(
        "channel".to_string(),
        serde_json::Value::String("launch-prepare".to_string()),
    );
    payload.insert(
        "session".to_string(),
        serde_json::Value::String(session.trim().to_string()),
    );
    payload.insert(
        "event".to_string(),
        serde_json::Value::String(event.to_string()),
    );
    payload.insert(
        "phase".to_string(),
        serde_json::Value::String(phase.to_string()),
    );
    payload.insert(
        "stage".to_string(),
        serde_json::Value::String(stage.to_string()),
    );
    if let Some(current) = current {
        payload.insert(
            "current".to_string(),
            serde_json::Value::Number(current.into()),
        );
    }
    if let Some(total) = total {
        payload.insert("total".to_string(), serde_json::Value::Number(total.into()));
    }
    if !message.trim().is_empty() {
        payload.insert(
            "message".to_string(),
            serde_json::Value::String(message.to_string()),
        );
    }
    if let Some(error) = error.filter(|value| !value.trim().is_empty()) {
        payload.insert(
            "error".to_string(),
            serde_json::Value::String(error.to_string()),
        );
    }
    let line = format!(
        "[ipc]{}",
        serde_json::to_string(&serde_json::Value::Object(payload))
            .unwrap_or_else(|_| "{}".to_string())
    );
    push_ui_log("core", "stderr", &line);
}

/// Emits a per-item launch-prepare event (a single downloaded file) so the prepare
/// dialog can show it as a file row under the given phase, like the install phases do.
#[allow(clippy::too_many_arguments)]
fn emit_launch_prepare_item(
    session: Option<&str>,
    event: &str,
    phase: &str,
    item_id: &str,
    item_name: &str,
    item_kind: &str,
    current_bytes: Option<i64>,
    total_bytes: Option<i64>,
    cached: Option<bool>,
    message: &str,
) {
    let Some(session) = session.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    let mut payload = serde_json::Map::new();
    payload.insert("channel".to_string(), "launch-prepare".into());
    payload.insert("session".to_string(), session.trim().into());
    payload.insert("event".to_string(), event.into());
    payload.insert("phase".to_string(), phase.into());
    payload.insert("stage".to_string(), "download".into());
    payload.insert("itemId".to_string(), item_id.into());
    payload.insert("itemName".to_string(), item_name.into());
    payload.insert("itemKind".to_string(), item_kind.into());
    if let Some(current_bytes) = current_bytes {
        payload.insert("itemCurrentBytes".to_string(), current_bytes.into());
    }
    if let Some(total_bytes) = total_bytes {
        payload.insert("itemTotalBytes".to_string(), total_bytes.into());
    }
    if let Some(cached) = cached {
        payload.insert("itemCached".to_string(), cached.into());
    }
    if !message.trim().is_empty() {
        payload.insert("message".to_string(), message.into());
    }
    let line = format!(
        "[ipc]{}",
        serde_json::to_string(&serde_json::Value::Object(payload))
            .unwrap_or_else(|_| "{}".to_string())
    );
    push_ui_log("core", "stderr", &line);
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

fn normalize_download_threads(download_threads: Option<i32>) -> usize {
    download_threads
        .unwrap_or(DEFAULT_DOWNLOAD_THREADS)
        .clamp(1, 32) as usize
}

fn mojang_java_component_for_major(major: i32) -> &'static str {
    match major {
        25.. => "java-runtime-epsilon",
        21..=24 => "java-runtime-delta",
        // gamma and beta are both Java 17, but gamma is the current component and ships
        // a native arm64 build while beta does not — prefer gamma to stay off Rosetta.
        17..=20 => "java-runtime-gamma",
        16 => "java-runtime-alpha",
        _ => "jre-legacy",
    }
}

/// Mojang java-runtime platform keys to try, in priority order. On ARM platforms the
/// older runtimes (jre-legacy / java-runtime-alpha, used by MC ≤ 1.16) ship no native
/// arm64 build, so we fall back to the x64 build — it runs under Rosetta 2 (macOS) or
/// Windows-on-ARM emulation. Newer runtimes resolve to the native arm64 build first.
fn mojang_java_platform_keys() -> Vec<&'static str> {
    if cfg!(windows) {
        match env::consts::ARCH {
            "x86" | "i686" => vec!["windows-x86"],
            "x86_64" => vec!["windows-x64"],
            "aarch64" => vec!["windows-arm64", "windows-x64"],
            _ => Vec::new(),
        }
    } else if cfg!(target_os = "linux") {
        match env::consts::ARCH {
            "x86" | "i686" => vec!["linux-i386"],
            "x86_64" => vec!["linux"],
            _ => Vec::new(),
        }
    } else if cfg!(target_os = "macos") {
        match env::consts::ARCH {
            "x86_64" => vec!["mac-os"],
            "aarch64" => vec!["mac-os-arm64", "mac-os"],
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    }
}

/// Installs a Mojang java-runtime `component`, trying each platform key in order and
/// using the first that ships a build. Returns `Ok(false)` when none of the given
/// platforms have the component (so the caller can decide on a fallback), `Ok(true)`
/// when a runtime was installed.
fn install_mojang_java_runtime(
    window: Option<&tauri::Window>,
    runtime_root: &Path,
    component: &str,
    major: i32,
    download_threads: usize,
    platform_keys: &[&str],
) -> Result<bool, String> {
    if platform_keys.is_empty() {
        return Err(format!(
            "Unsupported platform for Mojang runtime, major={major}"
        ));
    }
    let all_downloads: MojangJavaAllDownloads =
        fetch_json(window, "Mojang Java all.json", MOJANG_JAVA_ALL_JSON_URL)?;
    // Pick the first platform that actually ships a build for this component.
    let selected = platform_keys.iter().find_map(|platform| {
        let candidates = all_downloads.get(*platform)?.get(component)?;
        if candidates.is_empty() {
            return None;
        }
        let candidate = candidates
            .iter()
            .find(|item| parse_java_major_version(&item.version.name) >= major)
            .or_else(|| candidates.first())?;
        Some((*platform, candidate))
    });
    let (platform, candidate) = match selected {
        Some(found) => found,
        None => return Ok(false),
    };

    emit_log(
        window,
        "info",
        &format!(
            "Installing Mojang runtime component={component} version={} platform={platform}",
            candidate.version.name
        ),
    );

    let manifest: MojangJavaManifest =
        fetch_json(window, "Mojang Java manifest", &candidate.manifest.url)?;
    download_mojang_runtime_files(window, runtime_root, &manifest, download_threads)?;
    Ok(true)
}

/// A native third-party JRE (Azul Zulu) used when Mojang ships no native build for this
/// CPU — e.g. Apple Silicon needs Java 8/16, which Mojang only provides as x64. Running
/// a native arm64 build keeps the game off Rosetta 2.
#[derive(Debug, Deserialize)]
struct AzulPackage {
    name: String,
    download_url: String,
    sha256_hash: String,
}

fn azul_os() -> Option<&'static str> {
    if cfg!(windows) {
        Some("windows")
    } else if cfg!(target_os = "linux") {
        Some("linux")
    } else if cfg!(target_os = "macos") {
        Some("macos")
    } else {
        None
    }
}

fn azul_arch() -> Option<&'static str> {
    match env::consts::ARCH {
        "aarch64" => Some("aarch64"),
        "x86_64" => Some("x64"),
        "x86" | "i686" => Some("x86"),
        _ => None,
    }
}

/// Downloads and extracts a native Zulu JRE for the given Java major into `runtime_root`.
fn install_native_jre_archive(
    window: Option<&tauri::Window>,
    runtime_root: &Path,
    major: i32,
    download_threads: usize,
) -> Result<(), String> {
    let arch = azul_arch().ok_or_else(|| "Unsupported CPU arch for native JRE".to_string())?;
    install_zulu_jre_archive(window, runtime_root, major, download_threads, arch)
}

/// Downloads and extracts a Zulu JRE for an explicit CPU arch into `runtime_root`.
/// Used both for the native-arch path and for the emulated-x64 path on macOS, where a
/// current Zulu build replaces Mojang's unusably old jre-legacy.
fn install_zulu_jre_archive(
    window: Option<&tauri::Window>,
    runtime_root: &Path,
    major: i32,
    download_threads: usize,
    arch: &str,
) -> Result<(), String> {
    let os = azul_os().ok_or_else(|| "Unsupported OS for native JRE".to_string())?;
    let archive_type = if cfg!(windows) { "zip" } else { "tar.gz" };
    let api_url = format!(
        "https://api.azul.com/metadata/v1/zulu/packages/?java_version={major}&os={os}&arch={arch}\
&archive_type={archive_type}&java_package_type=jre&javafx_bundled=false&latest=true\
&release_status=ga&page_size=1&include_fields=sha256_hash,download_url"
    );
    let packages: Vec<AzulPackage> = fetch_json(window, "Azul Zulu metadata", &api_url)?;
    let package = packages
        .into_iter()
        .next()
        .ok_or_else(|| format!("No native Zulu JRE available for Java {major} on {os}/{arch}"))?;

    emit_log(
        window,
        "info",
        &format!("Downloading JDK {} ({os}/{arch})", package.name),
    );
    let archive_path = runtime_root.join(format!(".zulu-download.{archive_type}"));
    download_file_blocking(
        window,
        "native-jre",
        &package.download_url,
        &archive_path,
        download_threads,
        None,
    )?;
    verify_file_sha256(&archive_path, &package.sha256_hash)
        .map_err(|e| format!("Native JRE checksum failed: {e}"))?;

    emit_log(window, "info", "Extracting JDK archive");
    let extract_result = if archive_type == "zip" {
        extract_zip_into(&archive_path, runtime_root)
    } else {
        extract_tar_gz_into(&archive_path, runtime_root)
    };
    let _ = fs::remove_file(&archive_path);
    extract_result?;
    Ok(())
}

fn extract_tar_gz_into(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|e| format!("Failed opening archive {}: {e}", archive_path.display()))?;
    let decoder = flate2::read::GzDecoder::new(BufReader::new(file));
    let mut archive = tar::Archive::new(decoder);
    archive.set_preserve_permissions(true);
    archive.set_overwrite(true);
    archive
        .unpack(dest)
        .map_err(|e| format!("Failed extracting JRE archive: {e}"))?;
    Ok(())
}

fn extract_zip_into(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|e| format!("Failed opening archive {}: {e}", archive_path.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Invalid JRE archive: {e}"))?;
    archive
        .extract(dest)
        .map_err(|e| format!("Failed extracting JRE archive: {e}"))?;
    Ok(())
}

fn fetch_json<T: for<'de> Deserialize<'de>>(
    window: Option<&tauri::Window>,
    label: &str,
    url: &str,
) -> Result<T, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(JDK_DOWNLOAD_USER_AGENT)
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    emit_log(window, "info", &format!("Fetching {label}: {url}"));
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("Failed requesting {label}: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Failed requesting {label}: HTTP {status}"));
    }
    response
        .json::<T>()
        .map_err(|e| format!("Failed parsing {label}: {e}"))
}

fn parse_java_major_version(version: &str) -> i32 {
    let first = version.split('.').next().unwrap_or("");
    first.parse::<i32>().unwrap_or(0)
}

fn download_mojang_runtime_files(
    window: Option<&tauri::Window>,
    runtime_root: &Path,
    manifest: &MojangJavaManifest,
    download_threads: usize,
) -> Result<(), String> {
    fs::create_dir_all(runtime_root).map_err(|e| e.to_string())?;
    let entries: Vec<(String, MojangJavaRemoteEntry)> = manifest
        .files
        .iter()
        .map(|(path, entry)| (path.clone(), clone_mojang_entry(entry)))
        .collect();

    let total = entries.len().max(1);
    let completed = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let downloaded = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let jobs = Arc::new(Mutex::new(VecDeque::from(entries)));
    let error = Arc::new(Mutex::new(None::<String>));

    let worker_count = download_threads.max(1).min(total);
    let mut workers = Vec::with_capacity(worker_count);

    for _ in 0..worker_count {
        let jobs = Arc::clone(&jobs);
        let error = Arc::clone(&error);
        let completed = Arc::clone(&completed);
        let downloaded = Arc::clone(&downloaded);
        let runtime_root = runtime_root.to_path_buf();
        let window = window.cloned();
        workers.push(thread::spawn(move || loop {
            let next = {
                let mut guard = jobs.lock().unwrap();
                guard.pop_front()
            };
            let Some((relative_path, entry)) = next else {
                return;
            };

            if error.lock().unwrap().is_some() {
                return;
            }

            let result = process_mojang_runtime_entry(
                window.as_ref(),
                &runtime_root,
                &relative_path,
                &entry,
                download_threads,
            );

            match result {
                Ok(fetched) => {
                    let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                    if fetched {
                        downloaded.fetch_add(1, Ordering::Relaxed);
                    }
                    if done % 10 == 0 || done as usize == total {
                        emit_log(
                            window.as_ref(),
                            "info",
                            &format!(
                                "Mojang runtime progress: {done}/{total} downloaded={} cached={}",
                                downloaded.load(Ordering::Relaxed),
                                done.saturating_sub(downloaded.load(Ordering::Relaxed))
                            ),
                        );
                    }
                }
                Err(err) => {
                    *error.lock().unwrap() = Some(format!(
                        "Failed processing Mojang runtime entry {relative_path}: {err}"
                    ));
                    return;
                }
            }
        }));
    }

    for worker in workers {
        if worker.join().is_err() {
            return Err("Mojang runtime worker panicked".to_string());
        }
    }

    if let Some(err) = error.lock().unwrap().clone() {
        return Err(err);
    }
    Ok(())
}

fn clone_mojang_entry(entry: &MojangJavaRemoteEntry) -> MojangJavaRemoteEntry {
    MojangJavaRemoteEntry {
        entry_type: entry.entry_type.clone(),
        executable: entry.executable,
        downloads: entry.downloads.clone(),
        target: entry.target.clone(),
    }
}

fn process_mojang_runtime_entry(
    window: Option<&tauri::Window>,
    runtime_root: &Path,
    relative_path: &str,
    entry: &MojangJavaRemoteEntry,
    download_threads: usize,
) -> Result<bool, String> {
    // Manifest paths are always forward-slash separated. Join component-by-component so
    // the OS separator is used on every platform — `replace('/', "\\")` would create a
    // single file literally named "a\b\c" on macOS/Linux (where '\' isn't a separator).
    let target = relative_path
        .replace('\\', "/")
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".." && *component != ".")
        .fold(runtime_root.to_path_buf(), |acc, component| {
            acc.join(component)
        });
    match entry.entry_type.as_str() {
        "directory" => {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            Ok(false)
        }
        "link" => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&target, entry.target.as_bytes()).map_err(|e| e.to_string())?;
            Ok(true)
        }
        "file" => download_mojang_runtime_file(window, &target, entry, download_threads),
        other => Err(format!("Unsupported Mojang runtime entry type: {other}")),
    }
}

fn download_mojang_runtime_file(
    window: Option<&tauri::Window>,
    target: &Path,
    entry: &MojangJavaRemoteEntry,
    download_threads: usize,
) -> Result<bool, String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if let Some(raw) = entry.downloads.get("raw") {
        if target.is_file() {
            let size_ok = fs::metadata(target)
                .map(|meta| meta.len() == raw.size)
                .unwrap_or(false);
            let sha1_ok = compute_sha1_hex(target)
                .map(|sha1| sha1.eq_ignore_ascii_case(&raw.sha1))
                .unwrap_or(false);
            if size_ok && sha1_ok {
                return Ok(false);
            }
        }
    }

    if let Some(lzma) = entry.downloads.get("lzma") {
        let temp_lzma = target.with_extension("lzma.download");
        download_file_with_sha1(
            window,
            "mojang-runtime-lzma",
            &lzma.url,
            &temp_lzma,
            &lzma.sha1,
            download_threads,
        )?;
        let temp_output = target.with_extension("tmp");
        let input = fs::File::open(&temp_lzma).map_err(|e| e.to_string())?;
        let stream = Stream::new_auto_decoder(u64::MAX, 0).map_err(|e| e.to_string())?;
        let mut decoder = XzDecoder::new_stream(BufReader::new(input), stream);
        let mut output = fs::File::create(&temp_output).map_err(|e| e.to_string())?;
        if let Err(error) = std::io::copy(&mut decoder, &mut output) {
            let _ = fs::remove_file(&temp_output);
            return Err(error.to_string());
        }
        if let Err(error) = output.flush() {
            let _ = fs::remove_file(&temp_output);
            return Err(error.to_string());
        }
        drop(output);
        if let Some(raw) = entry.downloads.get("raw") {
            let sha1 = match compute_sha1_hex(&temp_output) {
                Ok(sha1) => sha1,
                Err(error) => {
                    let _ = fs::remove_file(&temp_output);
                    return Err(error);
                }
            };
            if !sha1.eq_ignore_ascii_case(&raw.sha1) {
                let _ = fs::remove_file(&temp_output);
                return Err(format!(
                    "SHA1 mismatch after decompressing Mojang runtime {}: expected={} actual={sha1}",
                    target.display(),
                    raw.sha1
                ));
            }
        }
        fs::rename(&temp_output, target).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&temp_lzma);
    } else if let Some(raw) = entry.downloads.get("raw") {
        download_file_with_sha1(
            window,
            "mojang-runtime-raw",
            &raw.url,
            target,
            &raw.sha1,
            download_threads,
        )?;
    } else {
        return Err("No downloadable source found".to_string());
    }

    if entry.executable {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(target)
                .map_err(|e| e.to_string())?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(target, perms).map_err(|e| e.to_string())?;
        }
    }
    Ok(true)
}

fn download_file_with_sha1(
    window: Option<&tauri::Window>,
    source_name: &str,
    url: &str,
    target: &Path,
    expected_sha1: &str,
    download_threads: usize,
) -> Result<(), String> {
    download_file_blocking(window, source_name, url, target, download_threads, None)?;
    let sha1 = compute_sha1_hex(target)?;
    if !sha1.eq_ignore_ascii_case(expected_sha1) {
        return Err(format!(
            "SHA1 mismatch for {url}: expected={expected_sha1} actual={sha1}"
        ));
    }
    emit_log(
        window,
        "info",
        &format!("Downloaded {source_name}: {}", target.display()),
    );
    Ok(())
}

fn compute_sha1_hex(path: &Path) -> Result<String, String> {
    use sha1::{Digest as Sha1Digest, Sha1};
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha1::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, Deserialize)]
struct MojangJavaVersionName {
    name: String,
}

#[derive(Debug, Deserialize)]
struct MojangJavaManifestRef {
    url: String,
}

#[derive(Debug, Deserialize)]
struct MojangJavaComponentDownload {
    manifest: MojangJavaManifestRef,
    version: MojangJavaVersionName,
}

type MojangJavaAllDownloads = HashMap<String, HashMap<String, Vec<MojangJavaComponentDownload>>>;

#[derive(Debug, Deserialize)]
struct MojangJavaManifest {
    #[serde(default)]
    files: HashMap<String, MojangJavaRemoteEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct MojangJavaDownloadInfo {
    url: String,
    sha1: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct MojangJavaRemoteEntry {
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(default)]
    executable: bool,
    #[serde(default)]
    downloads: HashMap<String, MojangJavaDownloadInfo>,
    #[serde(default)]
    target: String,
}

/// Reports raw byte progress during a download: `(downloaded_bytes, total_bytes)`.
/// Owned (`Arc`) so it can be cloned into the parallel-download worker threads,
/// which require `'static + Send + Sync` closures.
type DownloadProgressCallback = Arc<dyn Fn(u64, Option<u64>) + Send + Sync>;

fn download_file_blocking(
    window: Option<&tauri::Window>,
    source_name: &str,
    url: &str,
    target: &Path,
    download_threads: usize,
    progress: Option<DownloadProgressCallback>,
) -> Result<(), String> {
    const MIN_PARALLEL_SIZE: u64 = 8 * 1024 * 1024;
    const MIN_PART_SIZE: u64 = 4 * 1024 * 1024;

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

    if download_threads > 1 {
        if let Ok(Some(total_size)) = probe_parallel_download_support(&client, url) {
            if total_size >= MIN_PARALLEL_SIZE {
                let max_parts = ((total_size + MIN_PART_SIZE - 1) / MIN_PART_SIZE) as usize;
                let part_count = download_threads.min(max_parts.max(1));
                if part_count > 1 {
                    emit_log(
                        window,
                        "info",
                        &format!(
                            "JDK download ({source_name}) using {part_count} parallel threads, size={total_size} bytes"
                        ),
                    );
                    return download_file_blocking_parallel(
                        window,
                        &client,
                        source_name,
                        url,
                        target,
                        total_size,
                        part_count,
                        progress,
                    );
                }
            }
        }
    }

    download_file_blocking_single(window, &client, source_name, url, target, progress)
}

fn probe_parallel_download_support(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Result<Option<u64>, String> {
    let response = client
        .head(url)
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let supports_range = response
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().contains("bytes"))
        .unwrap_or(false);
    if !supports_range {
        return Ok(None);
    }
    Ok(response.content_length())
}

fn download_file_blocking_single(
    window: Option<&tauri::Window>,
    client: &reqwest::blocking::Client,
    source_name: &str,
    url: &str,
    target: &Path,
    progress: Option<DownloadProgressCallback>,
) -> Result<(), String> {
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
                        if let Some(callback) = progress.as_ref() {
                            callback(downloaded, Some(total_size));
                        }
                    }
                }
            } else if downloaded % (1024 * 1024) < 64 * 1024 {
                emit_log(
                    window,
                    "info",
                    &format!("JDK download progress: {downloaded} bytes"),
                );
                if let Some(callback) = progress.as_ref() {
                    callback(downloaded, None);
                }
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

fn download_file_blocking_parallel(
    window: Option<&tauri::Window>,
    client: &reqwest::blocking::Client,
    source_name: &str,
    url: &str,
    target: &Path,
    total_size: u64,
    part_count: usize,
    progress_cb: Option<DownloadProgressCallback>,
) -> Result<(), String> {
    let tmp = target.with_extension("download");
    let chunk_size = total_size.div_ceil(part_count as u64);
    let progress = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let last_percent = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut handles = Vec::with_capacity(part_count);
    let mut part_paths = Vec::with_capacity(part_count);

    for part_index in 0..part_count {
        let start = chunk_size * part_index as u64;
        if start >= total_size {
            break;
        }
        let end = (start + chunk_size).min(total_size) - 1;
        let client = client.clone();
        let part_path = target.with_extension(format!("download.part{part_index}"));
        let part_path_for_thread = part_path.clone();
        let url = url.to_string();
        let source_name = source_name.to_string();
        let progress = Arc::clone(&progress);
        let last_percent = Arc::clone(&last_percent);
        let progress_callback = progress_cb.clone();
        let window = window.cloned();
        part_paths.push(part_path.clone());
        handles.push(thread::spawn(move || -> Result<(), String> {
            let mut response = client
                .get(&url)
                .header(reqwest::header::ACCEPT, "*/*")
                .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
                .send()
                .map_err(|e| format!("part {part_index} request failed: {e}"))?;
            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err(format!(
                    "part {part_index} expected HTTP 206 but got {}",
                    response.status()
                ));
            }
            let mut file = fs::File::create(&part_path_for_thread).map_err(|e| e.to_string())?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = response.read(&mut buffer).map_err(|e| {
                    format!("part {part_index} read failed for {source_name}: {e}")
                })?;
                if read == 0 {
                    file.flush().map_err(|e| e.to_string())?;
                    return Ok(());
                }
                file.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
                let downloaded =
                    progress.fetch_add(read as u64, Ordering::Relaxed) + read as u64;
                let percent = downloaded.saturating_mul(100) / total_size;
                let previous = last_percent.load(Ordering::Relaxed);
                if percent >= previous + 2 || percent == 100 {
                    if last_percent
                        .compare_exchange(
                            previous,
                            percent,
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                        )
                        .is_ok()
                    {
                        emit_log(
                            window.as_ref(),
                            "info",
                            &format!(
                                "JDK download progress: {percent}% ({downloaded}/{total_size} bytes)"
                            ),
                        );
                        if let Some(callback) = progress_callback.as_ref() {
                            callback(downloaded, Some(total_size));
                        }
                    }
                }
            }
        }));
    }

    for handle in handles {
        match handle.join() {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                cleanup_download_parts(&part_paths, &tmp);
                return Err(err);
            }
            Err(_) => {
                cleanup_download_parts(&part_paths, &tmp);
                return Err("JDK parallel download worker panicked".to_string());
            }
        }
    }

    let mut output = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    for part_path in &part_paths {
        let mut input = fs::File::open(part_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
    }
    output.flush().map_err(|e| e.to_string())?;
    fs::rename(&tmp, target).map_err(|e| e.to_string())?;
    cleanup_download_parts(&part_paths, Path::new(""));
    emit_log(window, "info", "JDK download progress: 100%");
    Ok(())
}

fn cleanup_download_parts(part_paths: &[PathBuf], tmp: &Path) {
    for path in part_paths {
        let _ = fs::remove_file(path);
    }
    if !tmp.as_os_str().is_empty() {
        let _ = fs::remove_file(tmp);
    }
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

fn is_jar_file_name(file_name: &str) -> bool {
    Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("jar"))
        .unwrap_or(false)
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
    // Only veto on a checksum mismatch when both sides have one (see the matching
    // rationale in get_launcher_package_state_blocking).
    if let (Some(installed_checksum), Some(expected_checksum_value)) =
        (marker.checksum.as_deref(), expected_checksum)
    {
        if installed_checksum.trim() != expected_checksum_value.trim() {
            return Ok(false);
        }
    }
    // Download/manifest URLs are transport details, not content identity, so an
    // http→https or CDN change alone must not force a re-download. Params retained
    // for signature compatibility with callers.
    let _ = (expected_manifest_url, expected_download_url);
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

fn mods_dir_has_unmanaged_files(
    mods_dir: &Path,
    marker_path: &Path,
    marker: &LauncherModsInstallMarker,
) -> Result<bool, String> {
    if !mods_dir.exists() {
        return Ok(false);
    }
    if marker.files.is_empty() {
        return mods_dir_has_payload(mods_dir, marker_path);
    }
    let managed_paths = marker
        .files
        .iter()
        .map(|file| normalize_manifest_relative_path(&file.path))
        .collect::<Result<HashSet<_>, _>>()?;
    mods_dir_has_unmanaged_files_inner(mods_dir, mods_dir, marker_path, &managed_paths)
}

fn mods_dir_has_unmanaged_files_inner(
    root_dir: &Path,
    current_dir: &Path,
    marker_path: &Path,
    managed_paths: &HashSet<PathBuf>,
) -> Result<bool, String> {
    let read_dir = fs::read_dir(current_dir).map_err(|e| {
        format!(
            "Failed to inspect mods directory {}: {e}",
            current_dir.to_string_lossy()
        )
    })?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path == marker_path {
            continue;
        }
        if path.is_dir() {
            if mods_dir_has_unmanaged_files_inner(root_dir, &path, marker_path, managed_paths)? {
                return Ok(true);
            }
            continue;
        }
        let relative_path = path.strip_prefix(root_dir).map_err(|e| {
            format!(
                "Failed to resolve mods file path {}: {e}",
                path.to_string_lossy()
            )
        })?;
        if !managed_paths.contains(relative_path) {
            return Ok(true);
        }
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

fn sanitize_launcher_mod_package(
    mods_dir: &Path,
    installed_files: &mut Vec<LauncherInstalledFileRecord>,
) -> Result<(), String> {
    extract_nested_launcher_mod_jars(mods_dir, installed_files)?;
    remove_unsupported_launcher_runtime_mods(mods_dir, installed_files)?;
    Ok(())
}

fn extract_nested_launcher_mod_jars(
    mods_dir: &Path,
    installed_files: &mut Vec<LauncherInstalledFileRecord>,
) -> Result<(), String> {
    let package_files = installed_files.clone();
    let mut known_paths: HashSet<String> = installed_files
        .iter()
        .map(|file| file.path.to_ascii_lowercase())
        .collect();
    let mut nested_files = Vec::new();

    for file in package_files {
        let relative_path = normalize_manifest_relative_path(&file.path)?;
        let package_path = mods_dir.join(&relative_path);
        if !is_jar_file_name(&file.path) || !package_path.exists() {
            continue;
        }

        let input = fs::File::open(&package_path).map_err(|e| {
            format!(
                "Failed to open launcher mod {}: {e}",
                package_path.display()
            )
        })?;
        let mut archive = zip::ZipArchive::new(input).map_err(|e| {
            format!(
                "Invalid launcher mod archive {}: {e}",
                package_path.display()
            )
        })?;

        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
            if entry.name().ends_with('/') {
                continue;
            }
            let Some(enclosed) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
                continue;
            };
            if !is_nested_launcher_mod_jar_path(&enclosed) {
                continue;
            }
            let Some(file_name) = enclosed.file_name() else {
                continue;
            };

            let nested_relative_path = PathBuf::from(file_name);
            let nested_key = nested_relative_path
                .to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase();
            if known_paths.contains(&nested_key) {
                continue;
            }

            let out_path = mods_dir.join(&nested_relative_path);
            let mut out_file = fs::File::create(&out_path).map_err(|e| {
                format!(
                    "Failed to create nested launcher mod {}: {e}",
                    out_path.display()
                )
            })?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| {
                format!(
                    "Failed to write nested launcher mod {}: {e}",
                    out_path.display()
                )
            })?;
            nested_files.push(build_launcher_installed_file_record(
                &out_path,
                &nested_relative_path,
            )?);
            known_paths.insert(nested_key);
        }
    }

    installed_files.extend(nested_files);
    Ok(())
}

fn remove_unsupported_launcher_runtime_mods(
    mods_dir: &Path,
    installed_files: &mut Vec<LauncherInstalledFileRecord>,
) -> Result<(), String> {
    let mut retained = Vec::with_capacity(installed_files.len());
    for file in installed_files.drain(..) {
        let name = launcher_installed_file_name(&file.path);
        if !is_jar_file_name(&name) {
            retained.push(file);
            continue;
        }
        let relative_path = normalize_manifest_relative_path(&file.path)?;
        let target_path = mods_dir.join(&relative_path);
        if is_unsupported_launcher_runtime_mod_name(&name)
            || fabric_mod_uses_named_namespace(&target_path)?
        {
            if target_path.exists() {
                fs::remove_file(&target_path).map_err(|e| {
                    format!(
                        "Failed to remove unsupported runtime mod {}: {e}",
                        target_path.display()
                    )
                })?;
            }
            continue;
        }
        retained.push(file);
    }
    *installed_files = retained;
    Ok(())
}

fn is_nested_launcher_mod_jar_path(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    normalized.starts_with("meta-inf/jars/") && normalized.ends_with(".jar")
}

fn launcher_package_has_unsupported_runtime_mods(
    mods_dir: &Path,
    marker: &LauncherModsInstallMarker,
) -> Result<bool, String> {
    for file in &marker.files {
        if !is_jar_file_name(&file.path) {
            continue;
        }
        let name = launcher_installed_file_name(&file.path);
        if is_unsupported_launcher_runtime_mod_name(&name) {
            return Ok(true);
        }
        let relative_path = normalize_manifest_relative_path(&file.path)?;
        let target_path = mods_dir.join(relative_path);
        if fabric_mod_uses_named_namespace(&target_path)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn mods_dir_has_unsupported_runtime_mods(mods_dir: &Path) -> Result<bool, String> {
    if !mods_dir.exists() {
        return Ok(false);
    }
    let read_dir = fs::read_dir(mods_dir).map_err(|e| {
        format!(
            "Failed to inspect mods directory {}: {e}",
            mods_dir.display()
        )
    })?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let name = name.to_ascii_lowercase();
        if !is_jar_file_name(&name) {
            continue;
        }
        if is_unsupported_launcher_runtime_mod_name(&name)
            || fabric_mod_uses_named_namespace(&path)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn fabric_mod_uses_named_namespace(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let file = fs::File::open(path)
        .map_err(|e| format!("Failed to open Fabric module {}: {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid Fabric module archive {}: {e}", path.display()))?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        if entry.name().ends_with('/') {
            continue;
        }
        let Some(enclosed) = entry.enclosed_name().map(|value| value.to_path_buf()) else {
            continue;
        };
        let Some(file_name) = enclosed.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".accesswidener") {
            continue;
        }
        let mut content = String::new();
        entry
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read access widener {}: {e}", path.display()))?;
        if let Some(first_line) = content.lines().next() {
            if first_line.split_whitespace().any(|part| part == "named") {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

fn launcher_installed_file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_ascii_lowercase()
}

fn file_name_has_loom_namespace_marker(name: &str) -> bool {
    name.split('-')
        .any(|part| part.len() == 8 && part.chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn is_unsupported_launcher_runtime_mod_name(name: &str) -> bool {
    is_jar_file_name(name) && file_name_has_loom_namespace_marker(name)
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

#[cfg(test)]
mod tests {
    use super::{
        cleanup_launch_natives_dir, fabric_mod_uses_named_namespace,
        is_nested_launcher_mod_jar_path, is_unsupported_launcher_runtime_mod_name,
        launcher_package_has_unsupported_runtime_mods, FabricInstallResult, ForgeInstallResult,
        LauncherInstalledFileRecord, LauncherModsInstallMarker,
    };
    use std::fs;
    use std::io::Write;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn cleanup_launch_natives_dir_removes_directory_tree() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("fpsmaster-launcher-natives-{unique}"));
        let nested = dir.join("child").join("file.txt");
        fs::create_dir_all(nested.parent().expect("nested parent should exist"))
            .expect("test directory should be created");
        fs::write(&nested, "test").expect("test file should be written");

        cleanup_launch_natives_dir(&dir);

        assert!(!dir.exists());
    }

    #[test]
    fn detects_nested_launcher_mod_jars() {
        assert!(is_nested_launcher_mod_jar_path(Path::new(
            "META-INF/jars/fabric-biome-api-v1-17.1.1+4fc5413f3e.jar"
        )));
        assert!(!is_nested_launcher_mod_jar_path(Path::new(
            "fabric-biome-api-v1-17.1.1+4fc5413f3e.jar"
        )));
        assert!(is_nested_launcher_mod_jar_path(Path::new(
            "META-INF/jars/kotlin-stdlib-2.4.0.jar"
        )));
    }

    #[test]
    fn detects_named_access_widener_mods() {
        assert!(is_unsupported_launcher_runtime_mod_name(
            "fabric-biome-api-v1-48d44a6c-17.1.1+4fc5413f3e.jar"
        ));
        assert!(is_unsupported_launcher_runtime_mod_name(
            "fabric-api-48d44a6c-0.141.4+1.21.11.jar"
        ));
        assert!(!is_unsupported_launcher_runtime_mod_name(
            "fabric-language-kotlin-1.13.8+kotlin.2.2.10.jar"
        ));
        assert!(!is_unsupported_launcher_runtime_mod_name(
            "sodium-fabric-0.7.1.jar"
        ));

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("fpsmaster-fabric-api-test-{unique}"));
        fs::create_dir_all(&dir).expect("test directory should be created");
        let named_module = dir.join("fabric-biome-api-v1-48d44a6c-17.1.1+4fc5413f3e.jar");
        let intermediary_module = dir.join("fabric-block-view-api-v2-1.0.39+4ebb5c083e.jar");
        write_accesswidener_jar(&named_module, "accessWidener v1 named");
        write_accesswidener_jar(&intermediary_module, "accessWidener v1 intermediary");

        assert!(fabric_mod_uses_named_namespace(&named_module).expect("named jar should be read"));
        assert!(!fabric_mod_uses_named_namespace(&intermediary_module)
            .expect("intermediary jar should be read"));

        let marker = LauncherModsInstallMarker {
            version_tag: "4.0.0".to_string(),
            checksum: None,
            manifest_url: None,
            download_url: "https://example.invalid/nova.zip".to_string(),
            files: vec![
                installed_file("fabric-api-48d44a6c-0.141.4+1.21.11.jar"),
                installed_file("fabric-biome-api-v1-48d44a6c-17.1.1+4fc5413f3e.jar"),
                installed_file("fabric-language-kotlin-1.13.8+kotlin.2.2.10.jar"),
                installed_file("nova-4.0.0.jar"),
            ],
            installed_at_epoch_sec: 1,
        };
        assert!(launcher_package_has_unsupported_runtime_mods(&dir, &marker)
            .expect("named package should be checked"));

        let intermediary_marker = LauncherModsInstallMarker {
            files: vec![installed_file(
                "fabric-block-view-api-v2-1.0.39+4ebb5c083e.jar",
            )],
            ..marker
        };
        assert!(
            !launcher_package_has_unsupported_runtime_mods(&dir, &intermediary_marker)
                .expect("intermediary package should be checked")
        );
        assert!(is_unsupported_launcher_runtime_mod_name(
            "mcef-48d44a6c-3.3.0-1.21.11.jar"
        ));
        assert!(is_unsupported_launcher_runtime_mod_name(
            "sodium-48d44a6c-mc1.21.11-0.8.12-fabric.jar"
        ));
        assert!(!is_unsupported_launcher_runtime_mod_name(
            "mcef-3.3.0-1.21.11.jar"
        ));

        fs::remove_dir_all(&dir).expect("test directory should be removed");
    }

    fn installed_file(path: &str) -> LauncherInstalledFileRecord {
        LauncherInstalledFileRecord {
            path: path.to_string(),
            size: None,
            checksum: None,
        }
    }

    fn write_accesswidener_jar(path: &Path, first_line: &str) {
        let file = fs::File::create(path).expect("test jar should be created");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        writer
            .start_file("fabric.mod.json", options)
            .expect("fabric.mod.json should be added");
        writer
            .write_all(br#"{"schemaVersion":1,"id":"fabric-test","version":"1.0.0"}"#)
            .expect("fabric.mod.json should be written");
        writer
            .start_file("test.accesswidener", options)
            .expect("access widener should be added");
        writer
            .write_all(format!("{first_line}\n").as_bytes())
            .expect("access widener should be written");
        writer.finish().expect("test jar should be finalized");
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
        (bucket.total_r / bucket.total_weight)
            .round()
            .clamp(0.0, 255.0) as u8,
        (bucket.total_g / bucket.total_weight)
            .round()
            .clamp(0.0, 255.0) as u8,
        (bucket.total_b / bucket.total_weight)
            .round()
            .clamp(0.0, 255.0) as u8,
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
            if let Ok(window) = ensure_main_window(app) {
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
            create_tray(&app.handle())?;
            let launched_from_autostart = is_autostart_launch();
            if let Some(window) = app.get_webview_window("main") {
                attach_main_window_handlers(&window, &app.handle());
                if launched_from_autostart {
                    let _ = window.destroy();
                }
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
            destroy_current_window,
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
            install_native_app,
            prepare_extreme_assets,
            launch_native_app,
            list_vanilla_versions,
            install_vanilla,
            verify_installed_files,
            build_vanilla_launch_plan,
            launch_vanilla,
            cancel_install,
            list_fabric_loaders,
            install_fabric,
            list_forge_versions,
            list_optifine_versions,
            install_forge,
            install_optifine,
            poll_ui_logs,
            poll_game_runtime,
            is_version_installed,
            get_version_profile_base_version,
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
            terminate_game_process,
            secure_storage_get,
            secure_storage_set,
            secure_storage_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
