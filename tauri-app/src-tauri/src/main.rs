use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

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
    #[serde(rename = "installerPath")]
    installer_path: String,
    #[serde(rename = "exitCode")]
    exit_code: i32,
    #[serde(rename = "installerOutput")]
    installer_output: String,
}

#[tauri::command]
fn ensure_jdk(base_dir: String) -> Result<String, String> {
    let runtime_dir = Path::new(&base_dir).join("runtime");
    std::fs::create_dir_all(&runtime_dir).map_err(|e| e.to_string())?;
    Ok(runtime_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn list_vanilla_versions() -> Result<Vec<String>, String> {
    let output = run_java_core(&["list-versions"])?;
    serde_json::from_str::<Vec<String>>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
fn install_vanilla(game_dir: String, version_id: String) -> Result<InstallResult, String> {
    let output = run_java_core(&[
        "install-vanilla",
        "--game-dir",
        &game_dir,
        "--version",
        &version_id,
    ])?;
    serde_json::from_str::<InstallResult>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
fn build_vanilla_launch_plan(
    game_dir: String,
    version_id: String,
    player_name: String,
    uuid: String,
    access_token: String,
    max_memory_mb: i32,
) -> Result<LaunchPlan, String> {
    let max_memory = max_memory_mb.to_string();
    let output = run_java_core(&[
        "build-launch-plan",
        "--game-dir",
        &game_dir,
        "--version",
        &version_id,
        "--player",
        &player_name,
        "--uuid",
        &uuid,
        "--access-token",
        &access_token,
        "--max-memory",
        &max_memory,
    ])?;
    serde_json::from_str::<LaunchPlan>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
fn list_fabric_loaders(game_version: String) -> Result<Vec<String>, String> {
    let output = run_java_core(&["list-fabric-loaders", "--game-version", &game_version])?;
    serde_json::from_str::<Vec<String>>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
fn install_fabric(
    game_dir: String,
    game_version: String,
    loader_version: String,
) -> Result<FabricInstallResult, String> {
    let output = run_java_core(&[
        "install-fabric",
        "--game-dir",
        &game_dir,
        "--game-version",
        &game_version,
        "--loader-version",
        &loader_version,
    ])?;
    serde_json::from_str::<FabricInstallResult>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
fn list_forge_versions(game_version: String) -> Result<Vec<String>, String> {
    let output = run_java_core(&["list-forge-versions", "--game-version", &game_version])?;
    serde_json::from_str::<Vec<String>>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

#[tauri::command]
fn install_forge(
    game_dir: String,
    forge_version: String,
    java_path: Option<String>,
) -> Result<ForgeInstallResult, String> {
    let java_exe = java_path.unwrap_or_else(|| "java".to_string());
    let output = run_java_core(&[
        "install-forge",
        "--game-dir",
        &game_dir,
        "--forge-version",
        &forge_version,
        "--java",
        &java_exe,
    ])?;
    serde_json::from_str::<ForgeInstallResult>(&output)
        .map_err(|e| format!("Invalid java-core output: {e}"))
}

fn run_java_core(args: &[&str]) -> Result<String, String> {
    let jar = java_core_jar_path()?;
    let output = Command::new("java")
        .arg("-jar")
        .arg(&jar)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run java core: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        return Err(format!(
            "java-core command failed. stdout={stdout}; stderr={stderr}"
        ));
    }

    let text = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    Ok(text.trim().to_string())
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
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize java-core jar path: {e}"));
        }
    }

    Err(
        "java-core jar not found. Build java-core first with gradlew -p java-core build"
            .to_string(),
    )
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
            list_fabric_loaders,
            install_fabric,
            list_forge_versions,
            install_forge
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
