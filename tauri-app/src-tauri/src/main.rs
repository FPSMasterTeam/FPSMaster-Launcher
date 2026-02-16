use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::{env, fs};
use tauri::{Emitter, Manager};

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
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    window
        .show()
        .map_err(|e| format!("Failed to show main window: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus main window: {e}"))?;
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
        other => {
            return Err(format!(
                "Unsupported instance section '{other}'. Expected saves/mods/resourcepacks"
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
        .setup(|app| {
            let _ = app.path().app_data_dir();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ensure_jdk,
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
            terminate_game_process
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
