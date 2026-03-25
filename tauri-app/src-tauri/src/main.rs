use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, fs};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};
#[cfg(target_os = "macos")]
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt;

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
    #[serde(rename = "profilePath")]
    profile_path: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherNewsItem {
    id: String,
    title: String,
    summary: String,
    #[serde(rename = "publishedAt", default)]
    published_at: Option<String>,
    #[serde(default)]
    pinned: bool,
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
    online: TelemetryOnlineSummary,
    dashboard: Option<LauncherDashboard>,
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
struct LauncherModsInstallMarker {
    #[serde(rename = "versionTag")]
    version_tag: String,
    #[serde(default)]
    checksum: Option<String>,
    #[serde(rename = "manifestUrl", default)]
    manifest_url: Option<String>,
    #[serde(rename = "downloadUrl")]
    download_url: String,
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
const TRAY_SHOW_ID: &str = "tray_show";
const TRAY_HIDE_ID: &str = "tray_hide";
const TRAY_QUIT_ID: &str = "tray_quit";

#[derive(Debug, Serialize)]
struct GameRuntimeStats {
    pid: i64,
    running: bool,
    #[serde(rename = "memoryMb")]
    memory_mb: Option<u64>,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct InstanceSectionEntry {
    name: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

fn ui_log_store() -> &'static Mutex<UiLogStore> {
    UI_LOG_STORE.get_or_init(|| Mutex::new(UiLogStore::default()))
}

fn game_runtime_starts() -> &'static Mutex<HashMap<i64, std::time::Instant>> {
    GAME_RUNTIME_STARTS.get_or_init(|| Mutex::new(HashMap::new()))
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
    Ok(())
}

fn show_main_window_internal(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
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
}

impl Default for LauncherRuntimeState {
    fn default() -> Self {
        Self {
            minimize_to_tray: AtomicBool::new(true),
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

    let memory_kb = query_process_memory_kb(pid)?;
    let running = memory_kb.is_some();
    let memory_mb = memory_kb.map(|kb| kb / 1024);
    let elapsed_ms = if let Ok(store) = game_runtime_starts().lock() {
        store
            .get(&pid)
            .map(|start| start.elapsed().as_millis())
            .and_then(|value| u64::try_from(value).ok())
    } else {
        None
    };

    Ok(GameRuntimeStats {
        pid,
        running,
        memory_mb,
        elapsed_ms,
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
    if to_dir.exists() {
        return Err(format!(
            "Target version directory already exists but profile json is missing: {}",
            to_dir.display()
        ));
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

    let renamed_from_json = to_dir.join(format!("{from_id}.json"));
    if renamed_from_json.exists() {
        fs::rename(&renamed_from_json, &to_json).map_err(|e| {
            format!(
                "Failed to rename version json from {} to {}: {e}",
                renamed_from_json.display(),
                to_json.display()
            )
        })?;
    }
    if !to_json.exists() {
        return Err(format!(
            "Version json missing after rename, expected {}",
            to_json.display()
        ));
    }

    rewrite_version_profile_id(&to_json, to_id)?;

    Ok(to_id.to_string())
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

#[tauri::command]
fn get_default_game_dir() -> Result<String, String> {
    let path = default_game_dir_path()?;
    Ok(strip_windows_verbatim_prefix(&path)
        .to_string_lossy()
        .to_string())
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
    let runtime_root = game_dir_path.join("runtime").join(format!("jdk-{major}"));
    fs::create_dir_all(&runtime_root).map_err(|e| format!("Failed creating runtime dir: {e}"))?;

    if let Some(java_path) = locate_java_binary(&runtime_root) {
        emit_log(
            Some(&window),
            "info",
            &format!(
                "JDK already exists major={major} path={}",
                java_path.to_string_lossy()
            ),
        );
        return Ok(JdkEnsureResult {
            major_version: major,
            java_path: java_path.to_string_lossy().to_string(),
            cached: true,
        });
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
            Some(&window),
            "info",
            &format!(
                "Downloading JDK {major} [{}/{}] {}: {}",
                index + 1,
                sources.len(),
                source.name,
                source.url
            ),
        );

        match download_file_blocking(Some(&window), &source.name, &source.url, &archive_path) {
            Ok(()) => {
                downloaded = true;
                emit_log(
                    Some(&window),
                    "info",
                    &format!("JDK download succeeded from {}", source.name),
                );
                break;
            }
            Err(err) => {
                source_errors.push(format!("{} => {}", source.name, err));
                emit_log(
                    Some(&window),
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
        emit_log(Some(&window), "stderr", &merged_error);
        return Err(merged_error);
    }

    emit_log(
        Some(&window),
        "info",
        &format!("Extracting JDK archive {}", archive_path.to_string_lossy()),
    );
    if cfg!(windows) {
        extract_zip(&archive_path, &runtime_root)
            .map_err(|e| format!("Failed extracting JDK zip: {e}"))?;
    } else {
        extract_tar_gz(&archive_path, &runtime_root)
            .map_err(|e| format!("Failed extracting JDK tar.gz: {e}"))?;
    }
    let _ = fs::remove_file(&archive_path);

    let java_path = locate_java_binary(&runtime_root)
        .ok_or_else(|| "JDK extracted but java executable not found".to_string())?;

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
    let endpoint = format!("{}/api/v1/auth/login", normalize_api_base_url(&base_url)?);
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
        .append_pair("limit", &limit.unwrap_or(4).clamp(1, 12).to_string());

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

fn modrinth_search_projects_blocking(
    query: String,
    project_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ModrinthSearchResult>, String> {
    let normalized_query = query.trim().to_string();
    if normalized_query.is_empty() {
        return Err("Search query cannot be empty".to_string());
    }

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
        .append_pair("query", &normalized_query)
        .append_pair("limit", &limit.unwrap_or(18).clamp(1, 50).to_string())
        .append_pair("index", "downloads")
        .append_pair("facets", &facets);

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
    download_file_quiet_blocking(&client, &file.url, &download_path)
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

    let next_target_path = build_content_target_path(&runtime_root, &normalized_project_type, &file.filename)?;
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

    let resolved_version_number = if version.version_number.trim().is_empty() {
        version.name.clone()
    } else {
        version.version_number.clone()
    };
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
    )? && mods_dir_has_payload(&mods_dir, &marker_path)?
    {
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
            manifest_source,
            &normalized_tag,
            &mods_dir,
            clean_existing.unwrap_or(true),
        )?
    } else {
        if clean_existing.unwrap_or(true) {
            clear_directory_contents(&mods_dir)?;
        }

        let archive_path = env::temp_dir().join(format!(
            "fpsmaster-launcher-mods-{}-{}.zip",
            std::process::id(),
            now_epoch_millis()
        ));
        let download_result =
            download_file_blocking(None, "launcher-mods", &normalized_url, &archive_path);
        if let Err(err) = download_result {
            let _ = fs::remove_file(&archive_path);
            return Err(format!("Failed to download launcher package: {err}"));
        }
        if let Some(expected_checksum) = checksum.as_deref() {
            verify_file_sha256(&archive_path, expected_checksum)
                .map_err(|err| format!("Launcher package checksum mismatch: {err}"))?;
        }

        let extract_result = extract_launcher_mod_archive(&archive_path, &mods_dir);
        let _ = fs::remove_file(&archive_path);
        extract_result?
    };

    let marker = LauncherModsInstallMarker {
        version_tag: normalized_tag.clone(),
        checksum: checksum
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        manifest_url: normalized_manifest_url,
        download_url: normalized_url,
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
        installed_files,
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
    let installed = version_tag.is_some() && mods_dir_has_payload(&mods_dir, &marker_path)?;
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
    clean_existing: bool,
) -> Result<usize, String> {
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

    let install_result = install_manifest_files_into_stage(manifest_url, &manifest, &stage_dir);
    if let Err(err) = install_result {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(err);
    }
    let installed_files = install_result?;

    if clean_existing {
        if let Err(err) = replace_directory_with_stage(mods_dir, &stage_dir) {
            let _ = fs::remove_dir_all(&stage_dir);
            return Err(err);
        }
    } else {
        fs::create_dir_all(mods_dir).map_err(|e| {
            format!(
                "Failed to create mods directory {}: {e}",
                mods_dir.display()
            )
        })?;
        copy_directory_contents(&stage_dir, mods_dir)?;
        let _ = fs::remove_dir_all(&stage_dir);
    }

    Ok(installed_files)
}

fn install_manifest_files_into_stage(
    manifest_url: &str,
    manifest: &LauncherPackageManifest,
    stage_dir: &Path,
) -> Result<usize, String> {
    let client = build_blocking_http_client()?;
    let base_url = resolve_manifest_base_url(manifest_url, manifest.base_url.as_deref())?;
    let mut installed_files = 0_usize;

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

        installed_files += 1;
    }

    if installed_files == 0 {
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
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FPSMasterLauncher/0.2 (+https://github.com/fpsmaster)";

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
        other => Err(format!(
            "Unsupported content project type '{other}'. Expected mod/resourcepack/shader"
        )),
    }
}

fn normalize_content_source(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "modrinth" => Ok("modrinth".to_string()),
        other => Err(format!(
            "Unsupported content source '{other}'. Expected modrinth"
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
            format!(
                "Installed content record not found for {source}:{content_type}:{project_id}"
            )
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

    let canonical_runtime = fs::canonicalize(runtime_root).unwrap_or_else(|_| runtime_root.to_path_buf());
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

fn download_file_quiet_blocking(
    client: &reqwest::blocking::Client,
    url: &str,
    target: &Path,
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

        let mut file = fs::File::create(&tmp)
            .map_err(|e| format!("Failed to create temp file {}: {e}", tmp.display()))?;
        let write_result = std::io::copy(&mut response, &mut file);
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

#[tauri::command]
async fn list_vanilla_versions(window: tauri::Window) -> Result<Vec<String>, String> {
    let output = run_java_core_async(Some(window), vec!["list-versions".to_string()]).await?;
    serde_json::from_str::<Vec<String>>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
async fn install_vanilla(
    window: tauri::Window,
    game_dir: String,
    version_id: String,
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
    wait_for_exit: Option<bool>,
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
            wait_for_exit,
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
    wait_for_exit: Option<bool>,
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
    )?;

    let mut normalized_command = normalize_game_command_tokens(plan.command.clone());
    if normalized_command.is_empty() {
        return Err("Launch command is empty".to_string());
    }
    normalized_command[0] = prefer_java_with_console(&normalized_command[0]);
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

    let refs: Vec<&str> = command.iter().map(String::as_str).collect();
    let output = run_java_core(Some(window), &refs)?;
    serde_json::from_str::<LaunchPlan>(&output)
        .map_err(|e| format!("Invalid launch plan output: {e}"))
}

fn prefer_java_with_console(executable: &str) -> String {
    if !cfg!(windows) {
        return executable.to_string();
    }

    let lower = executable.to_lowercase();
    if !lower.ends_with("javaw.exe") {
        return executable.to_string();
    }

    let java_path = Path::new(executable)
        .with_file_name("java.exe")
        .to_string_lossy()
        .to_string();
    if Path::new(&java_path).exists() {
        return java_path;
    }

    executable.to_string()
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
        other => {
            return Err(format!(
            "Unsupported instance section '{other}'. Expected saves/mods/resourcepacks/shaderpacks"
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
        entries.push(InstanceSectionEntry {
            name: item.file_name().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
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

fn open_path_in_explorer(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let status = Command::new("explorer")
            .arg(path)
            .status()
            .map_err(|e| format!("Failed to open folder with explorer: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("Explorer returned non-zero status: {status}"));
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
    let output = Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
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
        let mut command = Command::new("cmd");
        command.arg("/C");
        command.arg(executable);
        command.args(args);
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
) -> Result<Vec<String>, String> {
    let output = run_java_core_async(
        Some(window),
        vec![
            "list-fabric-loaders".to_string(),
            "--game-version".to_string(),
            game_version,
        ],
    )
    .await?;
    serde_json::from_str::<Vec<String>>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
async fn install_fabric(
    window: tauri::Window,
    game_dir: String,
    game_version: String,
    loader_version: String,
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

#[tauri::command]
async fn list_forge_versions(
    window: tauri::Window,
    game_version: String,
) -> Result<Vec<String>, String> {
    let output = run_java_core_async(
        Some(window),
        vec![
            "list-forge-versions".to_string(),
            "--game-version".to_string(),
            game_version,
        ],
    )
    .await?;
    serde_json::from_str::<Vec<String>>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
async fn install_forge(
    window: tauri::Window,
    game_dir: String,
    forge_version: String,
    java_path: Option<String>,
    ipc_session: Option<String>,
) -> Result<ForgeInstallResult, String> {
    let game_dir = resolve_game_dir_path(&game_dir)?
        .to_string_lossy()
        .to_string();
    let java_exe = java_path.unwrap_or_else(|| "java".to_string());
    let mut command = vec![
        "install-forge".to_string(),
        "--game-dir".to_string(),
        game_dir,
        "--forge-version".to_string(),
        forge_version,
        "--java".to_string(),
        java_exe,
    ];
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
    let mut full_args: Vec<String> = vec!["-jar".to_string(), jar.to_string_lossy().to_string()];
    full_args.extend(args.iter().map(|x| (*x).to_string()));
    let command_preview = format_quoted_command("java", &full_args);
    emit_log(window, "info", &format!("run: {command_preview}"));
    if cfg!(windows) {
        emit_log(window, "info", "spawn shell: cmd /C");
    }

    let mut java_cmd = build_platform_command("java", &full_args, None);
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
            if cfg!(windows) { "cmd /C" } else { "direct" },
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
    let candidates = [
        PathBuf::from("../java-core/build/libs/fpsmaster-launcher-core-0.1.0-all.jar"),
        PathBuf::from("../java-core/build/libs/fpsmaster-launcher-core-0.1.0.jar"),
        PathBuf::from("../../java-core/build/libs/fpsmaster-launcher-core-0.1.0-all.jar"),
        PathBuf::from("../../java-core/build/libs/fpsmaster-launcher-core-0.1.0.jar"),
    ];

    for candidate in candidates {
        if candidate.exists() {
            return candidate
                .absolutize()
                .map_err(|e| format!("Failed to resolve java-core jar path: {e}"))
                .map(|p| strip_windows_verbatim_prefix(p.as_ref()));
        }
    }

    Err(
        "java-core jar not found. Build java-core first with gradlew -p java-core build"
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

fn normalize_api_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("API base URL is empty".to_string());
    }
    Ok(trimmed.to_string())
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
        return Err(extract_api_error_message(body)
            .unwrap_or_else(|| format!("versions list failed with HTTP {}", status.as_u16())));
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
        return Err(extract_api_error_message(body).unwrap_or_else(|| {
            format!("launcher dashboard failed with HTTP {}", status.as_u16())
        }));
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
        return Err(extract_api_error_message(body)
            .unwrap_or_else(|| format!("launcher home failed with HTTP {}", status.as_u16())));
    }

    serde_json::from_value::<LauncherHomePayload>(value)
        .map_err(|e| format!("launcher home response missing data: {e}"))
}

fn parse_api_envelope<T: for<'de> Deserialize<'de>>(
    status: reqwest::StatusCode,
    body: &str,
    context: &str,
) -> Result<T, String> {
    match serde_json::from_str::<ApiEnvelope<T>>(body) {
        Ok(payload) => {
            if !status.is_success() || !payload.success {
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
                    .unwrap_or_else(|| format!("{context} failed with HTTP {}", status.as_u16()));
                return Err(message);
            }
            payload
                .data
                .ok_or_else(|| format!("{context} response missing data"))
        }
        Err(err) => {
            if let Some(message) = extract_api_error_message(body) {
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

fn clear_directory_contents(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|e| format!("Failed removing directory {}: {e}", path.display()))?;
        } else {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed removing file {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn extract_launcher_mod_archive(archive: &Path, mods_dir: &Path) -> Result<usize, String> {
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

    let mut installed_files = 0_usize;
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
        installed_files += 1;
    }

    if installed_files == 0 {
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

fn main() {
    tauri::Builder::default()
        .manage(LauncherRuntimeState::default())
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
                if launched_from_autostart {
                    let _ = window.hide();
                }
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if should_minimize_to_tray(&app_handle) {
                            api.prevent_close();
                            let _ = hide_main_window_internal(&app_handle);
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
            modrinth_search_projects,
            install_modrinth_project,
            list_installed_content,
            uninstall_installed_content,
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
            list_instance_section_entries,
            open_instance_section,
            get_default_game_dir,
            show_main_window,
            hide_main_window,
            configure_tray_behavior,
            set_launch_on_startup,
            terminate_game_process
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
