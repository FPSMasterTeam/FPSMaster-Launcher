use crate::{
    build_blocking_http_client, compute_sha1_hex, emit_log, InstallResult, JavaRuntimeRequirement,
    LaunchPlan,
};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DownloadSource {
    OfficialOnly,
    MirrorOnly,
    MirrorFirst,
    OfficialFirst,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadEndpoint {
    Official,
    Mirror,
}

impl DownloadSource {
    const BMCLAPI_ROOT: &'static str = "https://bmclapi2.bangbang93.com";
    const OFFICIAL_VERSION_MANIFEST_URL: &'static str =
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
    const MIRROR_VERSION_MANIFEST_URL: &'static str =
        "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json";
    const OFFICIAL_LIBRARY_REPO: &'static str = "https://libraries.minecraft.net/";
    const OFFICIAL_ASSET_REPO: &'static str = "https://resources.download.minecraft.net/";
    const VERSION_LIST_TIMEOUT: Duration = Duration::from_secs(15);
    const METADATA_TIMEOUT: Duration = Duration::from_secs(15);

    pub(crate) fn from_id(raw: Option<&str>) -> Result<Self, String> {
        let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(Self::MirrorFirst);
        };
        match raw.to_ascii_lowercase().as_str() {
            "official" | "mojang" | "official-only" => Ok(Self::OfficialOnly),
            "mirror-only" => Ok(Self::MirrorOnly),
            "bmclapi" | "mirror" | "mirror-first" => Ok(Self::MirrorFirst),
            "official-first" => Ok(Self::OfficialFirst),
            _ => Err(format!("Unsupported download source: {raw}")),
        }
    }

    fn endpoints(self) -> Vec<DownloadEndpoint> {
        match self {
            Self::OfficialOnly => vec![DownloadEndpoint::Official],
            Self::MirrorOnly => vec![DownloadEndpoint::Mirror],
            Self::MirrorFirst => vec![DownloadEndpoint::Mirror, DownloadEndpoint::Official],
            Self::OfficialFirst => vec![DownloadEndpoint::Official, DownloadEndpoint::Mirror],
        }
    }

    fn default_library_repo(self) -> &'static str {
        Self::OFFICIAL_LIBRARY_REPO
    }

    fn default_asset_repo(self) -> &'static str {
        Self::OFFICIAL_ASSET_REPO
    }

    fn rewrite_url_for_mirror(url: &str) -> String {
        let replacements = [
            ("https://bmclapi2.bangbang93.com", Self::BMCLAPI_ROOT),
            ("https://launchermeta.mojang.com", Self::BMCLAPI_ROOT),
            ("https://piston-meta.mojang.com", Self::BMCLAPI_ROOT),
            ("https://piston-data.mojang.com", Self::BMCLAPI_ROOT),
            ("https://launcher.mojang.com", Self::BMCLAPI_ROOT),
            (
                "https://libraries.minecraft.net",
                "https://bmclapi2.bangbang93.com/libraries",
            ),
            (
                "https://resources.download.minecraft.net",
                "https://bmclapi2.bangbang93.com/assets",
            ),
            (
                "http://files.minecraftforge.net/maven",
                "https://bmclapi2.bangbang93.com/maven",
            ),
            (
                "https://files.minecraftforge.net/maven",
                "https://bmclapi2.bangbang93.com/maven",
            ),
            (
                "https://maven.minecraftforge.net",
                "https://bmclapi2.bangbang93.com/maven",
            ),
            (
                "https://meta.fabricmc.net",
                "https://bmclapi2.bangbang93.com/fabric-meta",
            ),
            (
                "https://maven.fabricmc.net",
                "https://bmclapi2.bangbang93.com/maven",
            ),
        ];

        let mut rewritten = url.to_string();
        for (prefix, replacement) in replacements {
            if let Some(suffix) = rewritten.strip_prefix(prefix) {
                rewritten = format!("{replacement}{suffix}");
            }
        }
        rewritten
    }

    fn candidate_urls(self, url: &str) -> Vec<String> {
        if url.trim().is_empty() {
            return Vec::new();
        }
        let official = url.to_string();
        let mirror = Self::rewrite_url_for_mirror(url);
        match self {
            Self::OfficialOnly => vec![official],
            Self::MirrorOnly => unique_urls(vec![mirror]),
            Self::MirrorFirst => unique_urls(vec![mirror, official]),
            Self::OfficialFirst => unique_urls(vec![official, mirror]),
        }
    }

    fn metadata_candidate_urls(self, url: &str) -> Vec<String> {
        if url.trim().is_empty() {
            return Vec::new();
        }
        let official = normalize_metadata_url(url);
        let mirror = Self::rewrite_url_for_mirror(&official);
        match self {
            Self::OfficialOnly => vec![official],
            Self::MirrorOnly => unique_urls(vec![mirror]),
            Self::MirrorFirst => unique_urls(vec![mirror, official]),
            Self::OfficialFirst => unique_urls(vec![official, mirror]),
        }
    }

    fn version_manifest_urls(self) -> Vec<String> {
        self.pair_candidates(
            Self::OFFICIAL_VERSION_MANIFEST_URL.to_string(),
            Self::MIRROR_VERSION_MANIFEST_URL.to_string(),
        )
    }

    fn fabric_loader_list_urls(self, game_version: &str) -> Vec<String> {
        self.pair_candidates(
            format!("https://meta.fabricmc.net/v2/versions/loader/{game_version}"),
            format!(
                "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/{game_version}"
            ),
        )
    }

    fn fabric_loader_profile_urls(self, game_version: &str, loader_version: &str) -> Vec<String> {
        self.pair_candidates(
            format!("https://meta.fabricmc.net/v2/versions/loader/{game_version}/{loader_version}"),
            format!(
                "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/{game_version}/{loader_version}"
            ),
        )
    }

    fn forge_installer_urls(self, game_version: &str, forge_version: &str) -> Vec<String> {
        let official = format!(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/{forge_version}/forge-{forge_version}-installer.jar"
        );
        let prefix = format!("{game_version}-");
        let remainder = forge_version.strip_prefix(&prefix).unwrap_or(forge_version);
        let mirror = if let Some((version, branch)) = remainder.split_once('-') {
            format!(
                "https://bmclapi2.bangbang93.com/forge/download?mcversion={game_version}&version={version}&category=installer&format=jar&branch={branch}"
            )
        } else {
            format!(
                "https://bmclapi2.bangbang93.com/forge/download?mcversion={game_version}&version={remainder}&category=installer&format=jar"
            )
        };
        self.pair_candidates(official, mirror)
    }

    fn pair_candidates(self, official: String, mirror: String) -> Vec<String> {
        match self {
            Self::OfficialOnly => vec![official],
            Self::MirrorOnly => vec![mirror],
            Self::MirrorFirst => vec![mirror, official],
            Self::OfficialFirst => vec![official, mirror],
        }
    }
}

fn install_cancel_error(session: Option<&str>) -> Result<(), String> {
    if crate::is_install_cancelled(session) {
        Err("Installation cancelled".to_string())
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct VanillaLaunchRequest {
    pub(crate) game_dir: PathBuf,
    pub(crate) version_id: String,
    pub(crate) player_name: String,
    pub(crate) uuid: String,
    pub(crate) access_token: String,
    pub(crate) java_path: PathBuf,
    pub(crate) max_memory_mb: i32,
    pub(crate) server_address: Option<String>,
    pub(crate) fpsmaster_token: Option<String>,
}

#[derive(Debug)]
pub(crate) struct VanillaResolvedLaunchPlan {
    pub(crate) plan: LaunchPlan,
    pub(crate) natives_dir: PathBuf,
}

#[derive(Debug, Clone)]
struct VersionDescriptor {
    merged: Value,
    jar_version_id: String,
}

#[derive(Debug, Clone)]
struct ResolvedLibrary {
    path: PathBuf,
    download_urls: Vec<String>,
    sha1: Option<String>,
    classpath_entry: bool,
    native_entry: bool,
}

#[derive(Debug, Clone)]
struct MavenCoordinates {
    group: String,
    artifact: String,
    version: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct OptiFineVersionListRow {
    #[serde(rename = "mcversion")]
    game_version: String,
    #[serde(rename = "patch")]
    patch: String,
    #[serde(rename = "type")]
    optifine_type: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    forge: Option<String>,
}

impl MavenCoordinates {
    fn parse(descriptor: &str) -> Result<Self, String> {
        let parts: Vec<&str> = descriptor.split(':').collect();
        if parts.len() < 3 {
            return Err(format!("Invalid maven descriptor: {descriptor}"));
        }
        Ok(Self {
            group: parts[0].to_string(),
            artifact: parts[1].to_string(),
            version: parts[2].to_string(),
        })
    }

    fn to_jar_path(&self) -> String {
        format!(
            "{}/{}/{}/{}-{}.jar",
            self.group.replace('.', "/"),
            self.artifact,
            self.version,
            self.artifact,
            self.version
        )
    }
}

pub(crate) fn list_vanilla_versions(
    window: Option<&tauri::Window>,
    download_source_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let source = DownloadSource::from_id(download_source_id)?;
    let manifest = get_json_from_candidates(
        window,
        &source.version_manifest_urls(),
        Some(DownloadSource::VERSION_LIST_TIMEOUT),
    )?;
    let versions = manifest
        .get("versions")
        .and_then(Value::as_array)
        .ok_or_else(|| "Version manifest missing versions array".to_string())?;
    let mut result = Vec::with_capacity(versions.len());
    for item in versions {
        let version_id = item
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Version manifest contains item without id".to_string())?;
        result.push(version_id.to_string());
    }
    Ok(result)
}

pub(crate) fn resolve_java_runtime_requirement(
    game_dir: Option<&Path>,
    version_id: &str,
    download_source_id: Option<&str>,
) -> Result<JavaRuntimeRequirement, String> {
    let source = DownloadSource::from_id(download_source_id)?;
    if let Some(game_dir) = game_dir {
        let local_version_json = game_dir
            .join("versions")
            .join(version_id)
            .join(format!("{version_id}.json"));
        if local_version_json.is_file() {
            let descriptor = resolve_version_descriptor(game_dir, version_id, 0)?;
            let (major_version, component) = extract_java_version(&descriptor.merged);
            return Ok(JavaRuntimeRequirement {
                version_id: version_id.to_string(),
                major_version,
                component,
            });
        }
    }

    let version_info = find_version_from_manifest(None, None, "runtime", version_id, source)?;
    let version_url = version_info
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Version manifest entry missing url for {version_id}"))?;
    let version_json =
        get_json_from_candidates(None, &source.metadata_candidate_urls(version_url), None)?;
    let (major_version, component) = extract_java_version(&version_json);
    Ok(JavaRuntimeRequirement {
        version_id: version_id.to_string(),
        major_version,
        component,
    })
}

/// True when this profile must run under an x64 (Rosetta) JVM on Apple Silicon: its
/// native libraries (LWJGL) ship no arm64 macOS build, so a native arm64 JVM would fail
/// to load them. Detected by the absence of any `arm64` macOS native classifier in the
/// merged metadata — present only in MC 1.19+ (LWJGL 3.3.1+). Always false off Apple
/// Silicon, where the native runtime is the only choice anyway.
pub(crate) fn macos_requires_x64_runtime(game_dir: &Path, version_id: &str) -> bool {
    if !(cfg!(target_os = "macos") && std::env::consts::ARCH == "aarch64") {
        return false;
    }
    let Ok(descriptor) = resolve_version_descriptor(game_dir, version_id, 0) else {
        // Can't tell — assume native; the runtime check would surface a clearer error.
        return false;
    };
    !descriptor.merged.to_string().contains("arm64")
}

pub(crate) fn install_vanilla(
    window: Option<&tauri::Window>,
    game_dir: &Path,
    version_id: &str,
    download_source_id: Option<&str>,
    download_threads: usize,
    ipc_session: Option<&str>,
) -> Result<InstallResult, String> {
    install_cancel_error(ipc_session)?;
    let source = DownloadSource::from_id(download_source_id)?;
    let normalized_game_dir = game_dir.to_path_buf();
    fs::create_dir_all(&normalized_game_dir).map_err(|e| {
        format!(
            "Failed to create game directory {}: {e}",
            normalized_game_dir.display()
        )
    })?;

    let phase = "vanilla";
    emit_install_phase_start(
        window,
        ipc_session,
        phase,
        "prepare",
        &format!("Prepare install for version={version_id}"),
    );

    emit_install_phase_start(
        window,
        ipc_session,
        phase,
        "resolve-version",
        &format!("Resolving version metadata for {version_id}"),
    );
    emit_install_progress(
        window,
        ipc_session,
        phase,
        "resolve-version",
        0,
        2,
        0,
        2,
        "Fetching version manifest",
    );
    let version_info = find_version_from_manifest(window, ipc_session, phase, version_id, source)?;
    emit_install_progress(
        window,
        ipc_session,
        phase,
        "resolve-version",
        1,
        2,
        1,
        1,
        "Version manifest resolved",
    );
    let version_json_url = version_info
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Version manifest entry missing url for {version_id}"))?;
    let version_json = get_json_from_candidates(
        window,
        &source.metadata_candidate_urls(version_json_url),
        Some(DownloadSource::METADATA_TIMEOUT),
    )?;
    install_cancel_error(ipc_session)?;
    emit_install_progress(
        window,
        ipc_session,
        phase,
        "resolve-version",
        2,
        2,
        2,
        0,
        "Version metadata ready",
    );
    let version_dir = normalized_game_dir.join("versions").join(version_id);
    fs::create_dir_all(&version_dir).map_err(|e| {
        format!(
            "Failed to create version dir {}: {e}",
            version_dir.display()
        )
    })?;

    let version_json_path = version_dir.join(format!("{version_id}.json"));
    fs::write(
        &version_json_path,
        serde_json::to_string(&version_json)
            .map_err(|e| format!("Failed to serialize version json for {version_id}: {e}"))?,
    )
    .map_err(|e| {
        format!(
            "Failed to write version json {}: {e}",
            version_json_path.display()
        )
    })?;

    emit_install_phase_start(window, ipc_session, phase, "client", "Download client jar");
    let client_downloaded = download_client(
        window,
        &version_json,
        &version_dir,
        version_id,
        phase,
        ipc_session,
        source,
    )?;
    emit_install_progress(
        window,
        ipc_session,
        phase,
        "client",
        1,
        1,
        if client_downloaded { 1 } else { 0 },
        if client_downloaded { 0 } else { 1 },
        if client_downloaded {
            "Client jar downloaded"
        } else {
            "Client jar already cached"
        },
    );

    emit_install_phase_start(
        window,
        ipc_session,
        phase,
        "libraries",
        "Download libraries",
    );
    let libraries_downloaded = download_libraries(
        window,
        &version_json,
        &normalized_game_dir,
        phase,
        ipc_session,
        source,
        download_threads,
    )?;

    emit_install_phase_start(window, ipc_session, phase, "assets", "Download assets");
    let assets_downloaded = download_assets(
        window,
        &version_json,
        &normalized_game_dir,
        phase,
        ipc_session,
        source,
        download_threads,
    )?;

    emit_install_phase_complete(
        window,
        ipc_session,
        phase,
        "complete",
        &format!(
            "Install completed version={version_id} libraries={libraries_downloaded} assets={assets_downloaded}"
        ),
    );

    Ok(InstallResult {
        version_id: version_id.to_string(),
        version_json_path: version_json_path.to_string_lossy().to_string(),
        libraries_downloaded,
        assets_downloaded,
    })
}

/// Verify the integrity of an already-installed profile (client jar, libraries and
/// assets) by re-hashing every declared file against the SHA1 recorded in the local
/// metadata, repairing any missing or corrupt file. Reuses the install download path
/// (which skips files whose SHA1 already matches and re-downloads the rest) so the UI
/// gets the same per-item progress feedback as a fresh install, under a `verify` phase.
///
/// Metadata is resolved fully offline from the local `<version>.json` (and its
/// `inheritsFrom` chain), so an intact installation verifies without any network call
/// and never re-runs loader processors — network is only touched to repair a bad file.
pub(crate) fn verify_installed_files(
    window: Option<&tauri::Window>,
    game_dir: &Path,
    version_id: &str,
    download_source_id: Option<&str>,
    download_threads: usize,
    ipc_session: Option<&str>,
) -> Result<crate::VerifyResult, String> {
    install_cancel_error(ipc_session)?;
    let source = DownloadSource::from_id(download_source_id)?;
    let phase = "verify";
    emit_install_phase_start(
        window,
        ipc_session,
        phase,
        "prepare",
        &format!("Verifying installed files for {version_id}"),
    );

    let descriptor = resolve_version_descriptor(game_dir, version_id, 0)?;
    let merged = &descriptor.merged;
    let jar_version_id = descriptor.jar_version_id.clone();
    let version_dir = game_dir.join("versions").join(&jar_version_id);

    emit_install_phase_start(window, ipc_session, phase, "client", "Verify client jar");
    let client_repaired = download_client(
        window,
        merged,
        &version_dir,
        &jar_version_id,
        phase,
        ipc_session,
        source,
    )?;
    emit_install_progress(
        window,
        ipc_session,
        phase,
        "client",
        1,
        1,
        if client_repaired { 1 } else { 0 },
        if client_repaired { 0 } else { 1 },
        if client_repaired {
            "Client jar repaired"
        } else {
            "Client jar verified"
        },
    );

    emit_install_phase_start(window, ipc_session, phase, "libraries", "Verify libraries");
    let libraries_repaired = download_libraries(
        window,
        merged,
        game_dir,
        phase,
        ipc_session,
        source,
        download_threads,
    )?;

    emit_install_phase_start(window, ipc_session, phase, "assets", "Verify assets");
    let assets_repaired = download_assets(
        window,
        merged,
        game_dir,
        phase,
        ipc_session,
        source,
        download_threads,
    )?;

    let repaired = i32::from(client_repaired) + libraries_repaired + assets_repaired;
    emit_install_phase_complete(
        window,
        ipc_session,
        phase,
        "complete",
        &format!("Verify completed version={version_id} repaired={repaired}"),
    );

    Ok(crate::VerifyResult {
        version_id: version_id.to_string(),
        client_repaired,
        libraries_repaired,
        assets_repaired,
        repaired,
    })
}

pub(crate) fn list_fabric_loader_versions(
    window: Option<&tauri::Window>,
    game_version: &str,
    download_source_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let source = DownloadSource::from_id(download_source_id)?;
    let payload = get_json_from_candidates(
        window,
        &source.fabric_loader_list_urls(game_version),
        Some(DownloadSource::VERSION_LIST_TIMEOUT),
    )?;
    let rows = payload
        .as_array()
        .ok_or_else(|| format!("Fabric loader list is not an array for {game_version}"))?;
    let mut result = Vec::new();
    for row in rows {
        if let Some(version) = row
            .get("loader")
            .and_then(|value| value.get("version"))
            .and_then(Value::as_str)
        {
            result.push(version.to_string());
        }
    }
    Ok(result)
}

pub(crate) fn install_fabric(
    window: Option<&tauri::Window>,
    game_dir: &Path,
    game_version: &str,
    requested_loader_version: &str,
    download_source_id: Option<&str>,
    download_threads: usize,
    ipc_session: Option<&str>,
) -> Result<crate::FabricInstallResult, String> {
    install_cancel_error(ipc_session)?;
    let source = DownloadSource::from_id(download_source_id)?;
    emit_install_phase_start(
        window,
        ipc_session,
        "fabric",
        "prepare",
        &format!("Prepare fabric install gameVersion={game_version}"),
    );

    let base_version_json = game_dir
        .join("versions")
        .join(game_version)
        .join(format!("{game_version}.json"));
    if !base_version_json.is_file() {
        install_vanilla(
            window,
            game_dir,
            game_version,
            download_source_id,
            download_threads,
            ipc_session,
        )?;
    }

    let loader_version = if requested_loader_version.trim().is_empty() {
        let all = list_fabric_loader_versions(window, game_version, download_source_id)?;
        all.into_iter()
            .find(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("No fabric loader available for {game_version}"))?
    } else {
        requested_loader_version.trim().to_string()
    };

    emit_install_phase_start(
        window,
        ipc_session,
        "fabric",
        "resolve-loader",
        &format!("Resolving fabric loader metadata for {game_version}"),
    );
    let row = get_json_from_candidates(
        window,
        &source.fabric_loader_profile_urls(game_version, &loader_version),
        Some(DownloadSource::METADATA_TIMEOUT),
    )?;
    install_cancel_error(ipc_session)?;
    emit_install_progress(
        window,
        ipc_session,
        "fabric",
        "resolve-loader",
        1,
        1,
        1,
        0,
        "Fabric loader metadata ready",
    );
    let launcher_meta = row
        .get("launcherMeta")
        .and_then(Value::as_object)
        .ok_or_else(|| "Fabric profile missing launcherMeta".to_string())?;
    let intermediary = row
        .get("intermediary")
        .and_then(Value::as_object)
        .ok_or_else(|| "Fabric profile missing intermediary".to_string())?;
    let loader = row
        .get("loader")
        .and_then(Value::as_object)
        .ok_or_else(|| "Fabric profile missing loader".to_string())?;
    let created = row
        .get("created")
        .and_then(Value::as_str)
        .unwrap_or("1970-01-01T00:00:00Z");

    let profile_id = format!("fabric-loader-{loader_version}-{game_version}");
    let main_class_value = launcher_meta
        .get("mainClass")
        .ok_or_else(|| "Fabric launcherMeta missing mainClass".to_string())?;
    let main_class = if let Some(client) = main_class_value
        .as_object()
        .and_then(|value| value.get("client"))
        .and_then(Value::as_str)
    {
        client.to_string()
    } else {
        main_class_value
            .as_str()
            .ok_or_else(|| "Fabric mainClass is invalid".to_string())?
            .to_string()
    };

    let mut version_json = serde_json::Map::new();
    version_json.insert("id".to_string(), Value::String(profile_id.clone()));
    version_json.insert(
        "inheritsFrom".to_string(),
        Value::String(game_version.to_string()),
    );
    version_json.insert("time".to_string(), Value::String(created.to_string()));
    version_json.insert(
        "releaseTime".to_string(),
        Value::String(created.to_string()),
    );
    version_json.insert("mainClass".to_string(), Value::String(main_class));
    if let Some(arguments) = launcher_meta.get("arguments") {
        version_json.insert("arguments".to_string(), arguments.clone());
    }

    let mut libraries = Vec::new();
    if let Some(groups) = launcher_meta.get("libraries").and_then(Value::as_object) {
        for key in ["common", "client", "server"] {
            if let Some(entries) = groups.get(key).and_then(Value::as_array) {
                libraries.extend(entries.iter().cloned());
            }
        }
    }

    libraries.push(json!({
        "name": intermediary
            .get("maven")
            .and_then(Value::as_str)
            .ok_or_else(|| "Fabric intermediary missing maven".to_string())?,
        "url": "https://maven.fabricmc.net/"
    }));
    libraries.push(json!({
        "name": loader
            .get("maven")
            .and_then(Value::as_str)
            .ok_or_else(|| "Fabric loader missing maven".to_string())?,
        "url": "https://maven.fabricmc.net/"
    }));
    version_json.insert("libraries".to_string(), Value::Array(libraries));

    let profile_dir = game_dir.join("versions").join(&profile_id);
    fs::create_dir_all(&profile_dir).map_err(|e| {
        format!(
            "Failed to create fabric profile dir {}: {e}",
            profile_dir.display()
        )
    })?;
    let profile_json_path = profile_dir.join(format!("{profile_id}.json"));
    fs::write(
        &profile_json_path,
        serde_json::to_string(&Value::Object(version_json))
            .map_err(|e| format!("Failed to serialize fabric profile {profile_id}: {e}"))?,
    )
    .map_err(|e| {
        format!(
            "Failed to write fabric profile {}: {e}",
            profile_json_path.display()
        )
    })?;

    emit_install_phase_start(
        window,
        ipc_session,
        "fabric",
        "libraries",
        "Download fabric libraries",
    );
    let libraries_downloaded = download_libraries(
        window,
        &read_json_file(&profile_json_path)?,
        game_dir,
        "fabric",
        ipc_session,
        source,
        download_threads,
    )?;
    emit_install_phase_complete(
        window,
        ipc_session,
        "fabric",
        "complete",
        &format!("Fabric install completed profile={profile_id} libraries={libraries_downloaded}"),
    );

    Ok(crate::FabricInstallResult {
        profile_id,
        loader_version: Some(loader_version),
        profile_json_path: profile_json_path.to_string_lossy().to_string(),
        libraries_downloaded,
    })
}

pub(crate) fn list_forge_versions(
    window: Option<&tauri::Window>,
    game_version: &str,
    download_source_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let source = DownloadSource::from_id(download_source_id)?;
    let mirror_url = format!("https://bmclapi2.bangbang93.com/forge/minecraft/{game_version}");
    let official_url =
        "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
    for endpoint in source.endpoints() {
        match endpoint {
            DownloadEndpoint::Mirror => {
                emit_log(
                    window,
                    "info",
                    &format!("Listing forge versions from mirror: {mirror_url}"),
                );
                let payload = match get_json_with_timeout(
                    &mirror_url,
                    Some(DownloadSource::VERSION_LIST_TIMEOUT),
                ) {
                    Ok(payload) => payload,
                    Err(error) if source != DownloadSource::MirrorOnly => {
                        emit_log(
                            window,
                            "warn",
                            &format!("Forge version list mirror request failed: {error}"),
                        );
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let rows = payload.as_array().ok_or_else(|| {
                    format!("Forge version list is not an array for {game_version}")
                })?;
                let mut versions = Vec::new();
                for row in rows {
                    let Some(version) = row.get("version").and_then(Value::as_str) else {
                        continue;
                    };
                    let has_installer = row
                        .get("files")
                        .and_then(Value::as_array)
                        .map(|files| {
                            files.iter().any(|file| {
                                file.get("category").and_then(Value::as_str) == Some("installer")
                                    && file.get("format").and_then(Value::as_str) == Some("jar")
                            })
                        })
                        .unwrap_or(false);
                    if !has_installer {
                        continue;
                    }
                    let branch = row.get("branch").and_then(Value::as_str).unwrap_or("");
                    let full = if branch.is_empty() {
                        format!("{game_version}-{version}")
                    } else {
                        format!("{game_version}-{version}-{branch}")
                    };
                    versions.push(full);
                }
                versions.sort_by(|left, right| compare_forge_versions(right, left));
                versions.dedup();
                return Ok(versions);
            }
            DownloadEndpoint::Official => {
                emit_log(
                    window,
                    "info",
                    &format!("Listing forge versions from official: {official_url}"),
                );
                let xml = match get_text_with_timeout(
                    official_url,
                    Some(DownloadSource::VERSION_LIST_TIMEOUT),
                ) {
                    Ok(xml) => xml,
                    Err(error) if source != DownloadSource::OfficialOnly => {
                        emit_log(
                            window,
                            "warn",
                            &format!("Forge version list official request failed: {error}"),
                        );
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let prefix = format!("{game_version}-");
                let mut versions = Vec::new();
                let mut index = 0usize;
                while let Some(begin) = xml[index..].find("<version>") {
                    let begin = index + begin + "<version>".len();
                    let Some(end_offset) = xml[begin..].find("</version>") else {
                        break;
                    };
                    let end = begin + end_offset;
                    let candidate = xml[begin..end].trim();
                    if candidate.starts_with(&prefix) {
                        versions.push(candidate.to_string());
                    }
                    index = end + "</version>".len();
                }
                versions.sort_by(|left, right| compare_forge_versions(right, left));
                versions.dedup();
                return Ok(versions);
            }
        }
    }
    Err(format!(
        "No forge version source succeeded for {game_version}"
    ))
}

pub(crate) fn list_optifine_versions(
    window: Option<&tauri::Window>,
    game_version: &str,
    loader: &str,
    loader_version: Option<&str>,
    download_source_id: Option<&str>,
) -> Result<Vec<crate::OptiFineVersionInfo>, String> {
    let source = DownloadSource::from_id(download_source_id)?;
    let payload = get_json_from_candidates(
        window,
        &source.pair_candidates(
            "https://bmclapi2.bangbang93.com/optifine/versionlist".to_string(),
            "https://bmclapi2.bangbang93.com/optifine/versionlist".to_string(),
        ),
        Some(DownloadSource::VERSION_LIST_TIMEOUT),
    )?;
    let rows: Vec<OptiFineVersionListRow> = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid OptiFine version list response: {e}"))?;
    let normalized_game_version = normalize_optifine_game_version(game_version);
    let normalized_loader = loader.trim().to_ascii_lowercase();
    let normalized_loader_version = loader_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    let mut unique = HashSet::new();
    let mut result = Vec::new();
    for row in rows {
        if normalize_optifine_game_version(&row.game_version) != normalized_game_version {
            continue;
        }
        let version = format!("{}_{}", row.optifine_type.trim(), row.patch.trim());
        if !unique.insert(version.clone()) {
            continue;
        }
        let compatibility = resolve_optifine_compatibility(
            &normalized_game_version,
            &version,
            &normalized_loader,
            normalized_loader_version.as_deref(),
            row.forge.as_deref(),
        );
        let is_preview = row.patch.starts_with("pre") || row.patch.starts_with("alpha");
        let file_name = row
            .filename
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                if is_preview {
                    format!(
                        "preview_OptiFine_{}_{}.jar",
                        normalize_optifine_game_version(&row.game_version),
                        version
                    )
                } else {
                    format!(
                        "OptiFine_{}_{}.jar",
                        normalize_optifine_game_version(&row.game_version),
                        version
                    )
                }
            });
        result.push(crate::OptiFineVersionInfo {
            id: format!("{}:{}", normalized_game_version, version),
            game_version: normalized_game_version.clone(),
            version,
            file_name,
            optifine_type: row.optifine_type.clone(),
            patch: row.patch.clone(),
            is_preview,
            forge_requirement: row.forge.clone(),
            compatibility: compatibility.0.to_string(),
            incompatibility_reason: compatibility.1,
        });
    }

    result.sort_by(|left, right| compare_optifine_versions(&right.version, &left.version));
    Ok(result)
}

fn normalize_optifine_game_version(input: &str) -> String {
    match input.trim() {
        "1.8.0" => "1.8".to_string(),
        "1.9.0" => "1.9".to_string(),
        other => other.to_string(),
    }
}

fn resolve_optifine_compatibility(
    game_version: &str,
    optifine_version: &str,
    loader: &str,
    loader_version: Option<&str>,
    forge_requirement: Option<&str>,
) -> (&'static str, Option<String>) {
    if loader == "fabric" {
        return (
            "incompatible",
            Some("OptiFine is not compatible with Fabric in this launcher.".to_string()),
        );
    }
    if loader != "forge" {
        return ("compatible", None);
    }

    let normalized_loader_version = loader_version.unwrap_or("").trim();
    if normalized_loader_version.is_empty() {
        return ("unknown", None);
    }

    let Some(requirement) = forge_requirement
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return ("compatible", None);
    };
    if requirement.eq_ignore_ascii_case("Forge N/A") {
        return (
            "incompatible",
            Some("This OptiFine release does not support Forge.".to_string()),
        );
    }
    if normalize_optifine_game_version(game_version) == "1.8.9"
        && optifine_version.starts_with("HD_U_M6")
    {
        return ("compatible", None);
    }
    let Some(required_build) = requirement
        .split('#')
        .nth(1)
        .or_else(|| requirement.split_whitespace().last())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return ("unknown", None);
    };
    let forge_version_part = normalized_loader_version
        .split('-')
        .nth(1)
        .unwrap_or(normalized_loader_version);
    let build_number = forge_version_part
        .split('.')
        .last()
        .unwrap_or(forge_version_part);
    if forge_version_part == required_build || build_number == required_build {
        ("compatible", None)
    } else {
        (
            "incompatible",
            Some(format!(
                "Requires Forge build {required_build}, but selected Forge is {forge_version_part}."
            )),
        )
    }
}

fn compare_optifine_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |input: &str| -> Vec<String> {
        input
            .split(['_', '-'])
            .filter(|item| !item.trim().is_empty())
            .map(|item| item.trim().to_string())
            .collect()
    };
    let left_parts = parse(left);
    let right_parts = parse(right);
    for index in 0..left_parts.len().max(right_parts.len()) {
        let l = left_parts.get(index).map(String::as_str).unwrap_or("");
        let r = right_parts.get(index).map(String::as_str).unwrap_or("");
        if l == r {
            continue;
        }
        let l_num = l.parse::<i32>().ok();
        let r_num = r.parse::<i32>().ok();
        match (l_num, r_num) {
            (Some(a), Some(b)) if a != b => return a.cmp(&b),
            _ => return l.cmp(r),
        }
    }
    std::cmp::Ordering::Equal
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

pub(crate) fn install_forge(
    window: Option<&tauri::Window>,
    game_dir: &Path,
    requested_forge_version: &str,
    java_executable: &Path,
    download_source_id: Option<&str>,
    download_threads: usize,
    ipc_session: Option<&str>,
) -> Result<crate::ForgeInstallResult, String> {
    install_cancel_error(ipc_session)?;
    let source = DownloadSource::from_id(download_source_id)?;
    let forge_version = requested_forge_version.trim();
    if forge_version.is_empty() {
        return Err("Forge version cannot be empty".to_string());
    }
    let game_version = forge_version
        .split('-')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Invalid forge version: {forge_version}"))?;

    emit_install_phase_start(
        window,
        ipc_session,
        "forge",
        "prepare",
        &format!("Prepare forge install gameVersion={game_version}"),
    );

    let base_version_json = game_dir
        .join("versions")
        .join(game_version)
        .join(format!("{game_version}.json"));
    if !base_version_json.is_file() {
        install_vanilla(
            window,
            game_dir,
            game_version,
            download_source_id,
            download_threads,
            ipc_session,
        )?;
    }

    ensure_launcher_profiles(game_dir)?;
    let installer_urls = source.forge_installer_urls(game_version, forge_version);
    let installer_url = installer_urls
        .first()
        .cloned()
        .ok_or_else(|| format!("No forge installer URL available for {forge_version}"))?;
    emit_install_phase_start(
        window,
        ipc_session,
        "forge",
        "resolve-installer",
        &format!("Resolving forge installer for {forge_version}"),
    );
    emit_install_progress(
        window,
        ipc_session,
        "forge",
        "resolve-installer",
        1,
        1,
        1,
        0,
        "Forge installer URL ready",
    );

    let installer_name = format!("forge-{forge_version}-installer.jar");
    let installer_path = game_dir.join("installers").join(&installer_name);
    emit_install_phase_start(
        window,
        ipc_session,
        "forge",
        "installer",
        &format!("Run forge installer {forge_version}"),
    );
    emit_install_progress(
        window,
        ipc_session,
        "forge",
        "download-installer",
        0,
        1,
        0,
        1,
        "Downloading forge installer",
    );
    let installer_artifact = DownloadArtifact::new(
        "forge-installer",
        "forge",
        "download-installer",
        &installer_path,
        "installer",
    );
    let downloaded_installer = download_file_with_ipc(
        window,
        ipc_session,
        &installer_urls,
        &installer_path,
        None,
        "forge-installer",
        &installer_artifact,
    )?;
    install_cancel_error(ipc_session)?;
    emit_install_progress(
        window,
        ipc_session,
        "forge",
        "download-installer",
        1,
        1,
        if downloaded_installer { 1 } else { 0 },
        if downloaded_installer { 0 } else { 1 },
        "Forge installer ready",
    );

    let install_profile = inspect_forge_installer(&installer_path)?;
    if !install_profile.new_style {
        emit_install_phase_start(
            window,
            ipc_session,
            "forge",
            "legacy-profile",
            "Detected legacy forge installer profile",
        );
        let profile_id = install_forge_old_profile(
            game_dir,
            forge_version,
            &installer_path,
            &install_profile.payload,
        )?;
        let profile_json_path = game_dir
            .join("versions")
            .join(&profile_id)
            .join(format!("{profile_id}.json"));
        emit_install_phase_complete(
            window,
            ipc_session,
            "forge",
            "complete",
            &format!("Forge install completed profile={profile_id}"),
        );
        return Ok(crate::ForgeInstallResult {
            profile_id,
            forge_version: forge_version.to_string(),
            profile_json_path: profile_json_path.to_string_lossy().to_string(),
            installer_url,
        });
    }

    emit_install_phase_start(
        window,
        ipc_session,
        "forge",
        "run-installer",
        "Running forge installer (first attempt)",
    );
    let first = run_forge_installer(
        game_dir,
        java_executable,
        &installer_path,
        &[
            "--installClient",
            "--installDir",
            &game_dir.to_string_lossy(),
        ],
    )?;
    let profile_id = if first.exit_code == 0 {
        select_forge_profile_id_after_install(
            game_dir,
            game_version,
            forge_version,
            &install_profile.payload,
        )?
    } else {
        emit_install_phase_start(
            window,
            ipc_session,
            "forge",
            "fallback-installer",
            "Retry forge installer with fallback args",
        );
        let fallback = run_forge_installer(
            game_dir,
            java_executable,
            &installer_path,
            &["--installClient"],
        )?;
        if fallback.exit_code != 0 {
            return Err(format!(
                "Forge installer failed. first={} fallback={}",
                first.output, fallback.output
            ));
        }
        select_forge_profile_id_after_install(
            game_dir,
            game_version,
            forge_version,
            &install_profile.payload,
        )?
    };

    let profile_json_path = game_dir
        .join("versions")
        .join(&profile_id)
        .join(format!("{profile_id}.json"));
    if !profile_json_path.is_file() {
        return Err(format!(
            "Forge profile json not found after install: {}",
            profile_json_path.display()
        ));
    }
    emit_install_phase_complete(
        window,
        ipc_session,
        "forge",
        "complete",
        &format!("Forge install completed profile={profile_id}"),
    );
    Ok(crate::ForgeInstallResult {
        profile_id,
        forge_version: forge_version.to_string(),
        profile_json_path: profile_json_path.to_string_lossy().to_string(),
        installer_url,
    })
}

pub(crate) fn install_optifine(
    window: Option<&tauri::Window>,
    game_dir: &Path,
    version_id: &str,
    game_version: &str,
    loader: &str,
    loader_version: Option<&str>,
    requested_optifine_version: &str,
    download_source_id: Option<&str>,
    ipc_session: Option<&str>,
) -> Result<crate::OptiFineInstallResult, String> {
    install_cancel_error(ipc_session)?;
    let normalized_version_id = version_id.trim();
    let normalized_game_version = game_version.trim();
    let normalized_loader = loader.trim().to_ascii_lowercase();
    let normalized_optifine_version = requested_optifine_version.trim();
    if normalized_version_id.is_empty()
        || normalized_game_version.is_empty()
        || normalized_optifine_version.is_empty()
    {
        return Err("OptiFine install arguments cannot be empty".to_string());
    }
    if normalized_loader == "fabric" {
        return Err("OptiFine cannot be installed together with Fabric".to_string());
    }

    let available = list_optifine_versions(
        window,
        normalized_game_version,
        &normalized_loader,
        loader_version,
        download_source_id,
    )?;
    let selected = available
        .into_iter()
        .find(|item| item.version == normalized_optifine_version)
        .ok_or_else(|| format!("OptiFine version not found: {normalized_optifine_version}"))?;
    if selected.compatibility == "incompatible" {
        return Err(selected
            .incompatibility_reason
            .unwrap_or_else(|| "Selected OptiFine version is incompatible".to_string()));
    }

    emit_install_phase_start(
        window,
        ipc_session,
        "optifine",
        "prepare",
        &format!("Prepare OptiFine install version={normalized_optifine_version}"),
    );

    let mods_dir = resolve_version_runtime_dir(game_dir, normalized_version_id)?.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| {
        format!(
            "Failed to create OptiFine mods dir {}: {e}",
            mods_dir.display()
        )
    })?;

    let target_path = mods_dir.join(&selected.file_name);
    let artifact = DownloadArtifact::new("optifine", "optifine", "download", &target_path, "mod");
    remove_existing_optifine_jars(&mods_dir, &target_path)?;

    if target_path.is_file() {
        emit_install_phase_complete(
            window,
            ipc_session,
            "optifine",
            "complete",
            &format!("OptiFine already installed: {}", target_path.display()),
        );
        return Ok(crate::OptiFineInstallResult {
            version_id: normalized_version_id.to_string(),
            opti_fine_version: selected.version,
            file_name: selected.file_name,
            installed_path: target_path.to_string_lossy().to_string(),
            skipped: true,
        });
    }

    let download_url = build_optifine_download_url(
        normalized_game_version,
        &selected.optifine_type,
        &selected.patch,
    );
    let source = DownloadSource::from_id(download_source_id)?;
    let urls = source.pair_candidates(download_url.clone(), download_url);
    let fetched = download_file_with_ipc(
        window,
        ipc_session,
        &urls,
        &target_path,
        None,
        "optifine",
        &artifact,
    )?;
    if !fetched && !target_path.is_file() {
        return Err("OptiFine download was skipped but target file is missing".to_string());
    }

    emit_install_phase_complete(
        window,
        ipc_session,
        "optifine",
        "complete",
        &format!("OptiFine install completed file={}", target_path.display()),
    );
    Ok(crate::OptiFineInstallResult {
        version_id: normalized_version_id.to_string(),
        opti_fine_version: selected.version,
        file_name: selected.file_name,
        installed_path: target_path.to_string_lossy().to_string(),
        skipped: false,
    })
}

fn build_optifine_download_url(game_version: &str, optifine_type: &str, patch: &str) -> String {
    let lookup_version = match game_version.trim() {
        "1.8" => "1.8.0".to_string(),
        "1.9" => "1.9.0".to_string(),
        other => other.to_string(),
    };
    format!(
        "https://bmclapi2.bangbang93.com/optifine/{lookup_version}/{}/{patch}",
        optifine_type.trim()
    )
}

fn remove_existing_optifine_jars(mods_dir: &Path, keep_path: &Path) -> Result<(), String> {
    if !mods_dir.exists() {
        return Ok(());
    }
    let read_dir = fs::read_dir(mods_dir)
        .map_err(|e| format!("Failed to inspect mods dir {}: {e}", mods_dir.display()))?;
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to inspect OptiFine candidate: {e}"))?;
        let path = entry.path();
        if path == keep_path || !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if name.to_ascii_lowercase().contains("optifine") {
            fs::remove_file(&path).map_err(|e| {
                format!(
                    "Failed to remove existing OptiFine jar {}: {e}",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

pub(crate) fn build_vanilla_launch_plan(
    window: Option<&tauri::Window>,
    request: &VanillaLaunchRequest,
    download_source_id: Option<&str>,
) -> Result<VanillaResolvedLaunchPlan, String> {
    let source = DownloadSource::from_id(download_source_id)?;
    let descriptor = resolve_version_descriptor(&request.game_dir, &request.version_id, 0)?;
    let version_json = descriptor.merged;
    let rule_features = build_rule_features();

    let version_dir = request
        .game_dir
        .join("versions")
        .join(request.version_id.trim());
    let natives_base_dir = version_dir.join("natives");
    fs::create_dir_all(&natives_base_dir).map_err(|e| {
        format!(
            "Failed to create natives directory {}: {e}",
            natives_base_dir.display()
        )
    })?;
    let natives_dir = create_temp_natives_dir(&natives_base_dir)?;

    let mut classpath_entries = Vec::new();
    for library in resolve_libraries(&version_json, &request.game_dir, &rule_features, source)? {
        ensure_library_downloaded(window, &library)?;
        if library.classpath_entry {
            classpath_entries.push(library.path.clone());
        }
        if library.native_entry {
            extract_native_jar(&library.path, &natives_dir)?;
        }
    }

    let jar_version_id = descriptor.jar_version_id;
    let client_jar = request
        .game_dir
        .join("versions")
        .join(&jar_version_id)
        .join(format!("{jar_version_id}.jar"));
    ensure_client_jar_downloaded(window, &version_json, &client_jar, source)?;
    classpath_entries.push(client_jar);

    let classpath = build_classpath(&classpath_entries);
    let variables = build_variables(request, &version_json, &natives_dir, &classpath)?;
    let mut jvm_args = vec![
        request.java_path.to_string_lossy().to_string(),
        format!("-Xmx{}M", request.max_memory_mb),
        format!("-Djava.library.path={}", natives_dir.to_string_lossy()),
    ];
    if let Some(args) = version_json
        .get("arguments")
        .and_then(|value| value.get("jvm"))
        .and_then(Value::as_array)
    {
        jvm_args.extend(resolve_argument_array(args, &variables, &rule_features));
    }
    jvm_args = normalize_jvm_arguments(jvm_args);

    // Inject the FPSMaster platform auth token only for preset Edge/Nova instances so the
    // client inherits the launcher login. Edge/Nova read -Dfpsmaster.auth.token at startup.
    if matches!(request.version_id.trim(), "FPSMaster-Edge" | "FPSMaster-Nova") {
        if let Some(token) = request
            .fpsmaster_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            jvm_args.push(format!("-Dfpsmaster.auth.token={token}"));
        }
    }

    let main_class = version_json
        .get("mainClass")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Version {} missing mainClass", request.version_id))?
        .to_string();
    let mut game_args = if let Some(args) = version_json
        .get("arguments")
        .and_then(|value| value.get("game"))
        .and_then(Value::as_array)
    {
        resolve_argument_array(args, &variables, &rule_features)
    } else if let Some(raw) = version_json
        .get("minecraftArguments")
        .and_then(Value::as_str)
    {
        raw.split(' ')
            .filter_map(|token| {
                let replaced = replace_variables(token, &variables).trim().to_string();
                if replaced.is_empty() {
                    None
                } else {
                    Some(replaced)
                }
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    ensure_default_resolution_args(&mut game_args, &variables);

    if let Some(server) = request
        .server_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        game_args.push("--server".to_string());
        game_args.push(server.to_string());
    }

    let mut command = jvm_args.clone();
    if !contains_classpath_arg(&jvm_args) {
        command.push("-cp".to_string());
        command.push(classpath.clone());
    }
    command.push(main_class.clone());
    command.extend(game_args);

    Ok(VanillaResolvedLaunchPlan {
        plan: LaunchPlan {
            command,
            classpath,
            main_class,
        },
        natives_dir,
    })
}

fn create_temp_natives_dir(base: &Path) -> Result<PathBuf, String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to read system clock: {e}"))?
        .as_millis();
    for index in 0..1024u32 {
        let candidate = base.join(format!("run-{timestamp}-{index}"));
        if !candidate.exists() {
            fs::create_dir_all(&candidate).map_err(|e| {
                format!(
                    "Failed to create natives temp directory {}: {e}",
                    candidate.display()
                )
            })?;
            return Ok(candidate);
        }
    }
    Err(format!(
        "Failed to allocate natives temp directory under {}",
        base.display()
    ))
}

fn extract_java_version(version_json: &Value) -> (i32, String) {
    let major = version_json
        .get("javaVersion")
        .and_then(|value| value.get("majorVersion"))
        .and_then(Value::as_i64)
        .unwrap_or(8) as i32;
    let component = version_json
        .get("javaVersion")
        .and_then(|value| value.get("component"))
        .and_then(Value::as_str)
        .unwrap_or("jre-legacy")
        .to_string();
    (major, component)
}

fn resolve_version_descriptor(
    game_dir: &Path,
    version_id: &str,
    depth: usize,
) -> Result<VersionDescriptor, String> {
    if depth > 8 {
        return Err(format!(
            "Version inheritance depth exceeded limit for {version_id}"
        ));
    }

    let version_json_path = game_dir
        .join("versions")
        .join(version_id)
        .join(format!("{version_id}.json"));
    let text = fs::read_to_string(&version_json_path).map_err(|e| {
        format!(
            "Failed to read version metadata {}: {e}",
            version_json_path.display()
        )
    })?;
    let raw: Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "Invalid version metadata {}: {e}",
            version_json_path.display()
        )
    })?;
    let Some(object) = raw.as_object() else {
        return Err(format!(
            "Version metadata is not an object: {}",
            version_json_path.display()
        ));
    };

    if let Some(parent_id) = object.get("inheritsFrom").and_then(Value::as_str) {
        let parent = resolve_version_descriptor(game_dir, parent_id, depth + 1)?;
        let merged = merge_version_json(&parent.merged, &raw);
        let jar_version_id = object
            .get("jar")
            .and_then(Value::as_str)
            .unwrap_or(parent.jar_version_id.as_str())
            .to_string();
        return Ok(VersionDescriptor {
            merged,
            jar_version_id,
        });
    }

    let jar_version_id = object
        .get("jar")
        .and_then(Value::as_str)
        .unwrap_or(version_id)
        .to_string();
    Ok(VersionDescriptor {
        merged: raw,
        jar_version_id,
    })
}

fn merge_version_json(parent: &Value, child: &Value) -> Value {
    let mut merged = parent.clone();
    let Some(parent_object) = parent.as_object() else {
        return child.clone();
    };
    let Some(child_object) = child.as_object() else {
        return merged;
    };
    let Some(merged_object) = merged.as_object_mut() else {
        return child.clone();
    };

    for (key, value) in child_object {
        if key == "libraries" && value.is_array() {
            let mut combined = parent_object
                .get("libraries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(child_array) = value.as_array() {
                combined.extend(child_array.iter().cloned());
            }
            merged_object.insert(key.clone(), Value::Array(combined));
            continue;
        }

        if key == "arguments" && value.is_object() {
            let parent_arguments = parent_object.get("arguments").and_then(Value::as_object);
            let child_arguments = value.as_object().expect("arguments already checked");
            merged_object.insert(
                key.clone(),
                Value::Object(merge_arguments(parent_arguments, child_arguments)),
            );
            continue;
        }

        merged_object.insert(key.clone(), value.clone());
    }

    merged
}

fn merge_arguments(
    parent: Option<&Map<String, Value>>,
    child: &Map<String, Value>,
) -> Map<String, Value> {
    let mut merged = parent.cloned().unwrap_or_default();
    for (key, value) in child {
        if value.is_array() && merged.get(key).and_then(Value::as_array).is_some() {
            let mut combined = merged
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(child_array) = value.as_array() {
                combined.extend(child_array.iter().cloned());
            }
            merged.insert(key.clone(), Value::Array(combined));
        } else {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged
}

fn ensure_default_resolution_args(
    game_args: &mut Vec<String>,
    variables: &HashMap<String, String>,
) {
    if game_args
        .iter()
        .any(|arg| arg == "--width" || arg == "--height")
    {
        return;
    }
    let width = variables
        .get("${resolution_width}")
        .cloned()
        .unwrap_or_else(|| "1200".to_string());
    let height = variables
        .get("${resolution_height}")
        .cloned()
        .unwrap_or_else(|| "700".to_string());
    game_args.extend(["--width".to_string(), width, "--height".to_string(), height]);
}

fn build_rule_features() -> HashMap<String, bool> {
    HashMap::from([
        ("is_demo_user".to_string(), false),
        ("has_custom_resolution".to_string(), true),
        ("has_quick_plays_support".to_string(), false),
        ("is_quick_play_singleplayer".to_string(), false),
        ("is_quick_play_multiplayer".to_string(), false),
        ("is_quick_play_realms".to_string(), false),
    ])
}

fn resolve_libraries(
    version_json: &Value,
    game_dir: &Path,
    rule_features: &HashMap<String, bool>,
    source: DownloadSource,
) -> Result<Vec<ResolvedLibrary>, String> {
    let libraries = version_json
        .get("libraries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut resolved = Vec::new();

    for library in libraries {
        if !rules_match(
            library.get("rules").and_then(Value::as_array),
            rule_features,
        ) {
            continue;
        }

        let name = library
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "Library entry missing name".to_string())?;
        let library_repo = library
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or(source.default_library_repo());

        let downloads = library.get("downloads");
        let classifiers = downloads.and_then(|value| value.get("classifiers"));
        let native_key = resolve_native_classifier_key(&library, classifiers);

        if let (Some(native_key), Some(classifiers)) = (
            native_key.as_deref(),
            classifiers.and_then(Value::as_object),
        ) {
            if let Some(classifier) = classifiers.get(native_key).and_then(Value::as_object) {
                let path = classifier
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("Native classifier missing path for {name}"))?;
                let target = game_dir.join("libraries").join(path);
                let urls = classifier
                    .get("url")
                    .and_then(Value::as_str)
                    .map(|url| source.candidate_urls(url))
                    .unwrap_or_else(|| {
                        source.candidate_urls(&format!(
                            "{}{}",
                            normalize_base_url(library_repo),
                            path
                        ))
                    });
                let sha1 = classifier
                    .get("sha1")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                resolved.push(ResolvedLibrary {
                    path: target,
                    download_urls: urls,
                    sha1,
                    classpath_entry: false,
                    native_entry: true,
                });
            }
        }

        if let Some(artifact) = downloads
            .and_then(|value| value.get("artifact"))
            .and_then(Value::as_object)
        {
            let path = artifact
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("Library artifact missing path for {name}"))?;
            let target = game_dir.join("libraries").join(path);
            let urls = artifact
                .get("url")
                .and_then(Value::as_str)
                .map(|url| source.candidate_urls(url))
                .unwrap_or_else(|| {
                    source.candidate_urls(&format!("{}{}", normalize_base_url(library_repo), path))
                });
            let sha1 = artifact
                .get("sha1")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            resolved.push(ResolvedLibrary {
                path: target,
                download_urls: urls,
                sha1,
                classpath_entry: true,
                native_entry: false,
            });
            continue;
        }

        if native_key.is_none() {
            let coordinates = MavenCoordinates::parse(name)?;
            let path = coordinates.to_jar_path();
            let target = game_dir.join("libraries").join(&path);
            resolved.push(ResolvedLibrary {
                path: target,
                download_urls: source.candidate_urls(&format!(
                    "{}{}",
                    normalize_base_url(library_repo),
                    path
                )),
                sha1: None,
                classpath_entry: true,
                native_entry: false,
            });
        }
    }

    Ok(resolved)
}

fn rules_match(rules: Option<&Vec<Value>>, features: &HashMap<String, bool>) -> bool {
    let Some(rules) = rules else {
        return true;
    };
    if rules.is_empty() {
        return true;
    }

    let mut allowed = false;
    let current_os = minecraft_os_name();
    for rule in rules {
        let Some(rule_object) = rule.as_object() else {
            continue;
        };
        let mut matches = true;

        if let Some(os_name) = rule_object
            .get("os")
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
        {
            matches = current_os == os_name;
        }

        if matches {
            if let Some(feature_map) = rule_object.get("features").and_then(Value::as_object) {
                for (name, expected) in feature_map {
                    let expected = expected.as_bool().unwrap_or(false);
                    let actual = features.get(name).copied().unwrap_or(false);
                    if actual != expected {
                        matches = false;
                        break;
                    }
                }
            }
        }

        if !matches {
            continue;
        }

        match rule_object.get("action").and_then(Value::as_str) {
            Some("allow") => allowed = true,
            Some("disallow") => allowed = false,
            _ => {}
        }
    }
    allowed
}

fn resolve_native_classifier_key(library: &Value, classifiers: Option<&Value>) -> Option<String> {
    let classifiers = classifiers?.as_object()?;
    if classifiers.is_empty() {
        return None;
    }

    let os_name = minecraft_os_name();
    let arch = arch_token();
    if let Some(native_name) = library
        .get("natives")
        .and_then(|value| value.get(os_name))
        .and_then(Value::as_str)
    {
        return Some(native_name.replace("${arch}", arch));
    }

    let candidates = [
        format!("natives-{os_name}-{arch}"),
        format!("native-{os_name}-{arch}"),
        format!("natives-{os_name}"),
        format!("native-{os_name}"),
        format!("{os_name}-{arch}"),
        os_name.to_string(),
    ];
    candidates
        .into_iter()
        .find(|candidate| classifiers.contains_key(candidate))
}

fn build_variables(
    request: &VanillaLaunchRequest,
    version_json: &Value,
    natives_dir: &Path,
    classpath: &str,
) -> Result<HashMap<String, String>, String> {
    let asset_index_name = version_json
        .get("assetIndex")
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Version {} missing assetIndex.id", request.version_id))?;

    let mut variables = HashMap::new();
    variables.insert(
        "${auth_player_name}".to_string(),
        request.player_name.clone(),
    );
    variables.insert("${auth_uuid}".to_string(), request.uuid.clone());
    variables.insert(
        "${auth_access_token}".to_string(),
        request.access_token.clone(),
    );
    variables.insert("${version_name}".to_string(), request.version_id.clone());
    variables.insert(
        "${game_directory}".to_string(),
        request.game_dir.to_string_lossy().to_string(),
    );
    variables.insert(
        "${assets_root}".to_string(),
        request
            .game_dir
            .join("assets")
            .to_string_lossy()
            .to_string(),
    );
    variables.insert(
        "${assets_index_name}".to_string(),
        asset_index_name.to_string(),
    );
    variables.insert(
        "${natives_directory}".to_string(),
        natives_dir.to_string_lossy().to_string(),
    );
    variables.insert("${classpath}".to_string(), classpath.to_string());
    variables.insert(
        "${version_type}".to_string(),
        version_json
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("release")
            .to_string(),
    );
    variables.insert(
        "${launcher_name}".to_string(),
        "FPSMasterLauncher".to_string(),
    );
    variables.insert("${launcher_version}".to_string(), "0.1.0".to_string());
    variables.insert("${user_type}".to_string(), "msa".to_string());
    variables.insert("${auth_xuid}".to_string(), "0".to_string());
    variables.insert(
        "${clientid}".to_string(),
        "057064c6-d180-43df-b010-834b4571532f".to_string(),
    );
    variables.insert("${user_properties}".to_string(), "{}".to_string());
    variables.insert("${profile_properties}".to_string(), "{}".to_string());
    variables.insert("${auth_session}".to_string(), request.access_token.clone());
    variables.insert(
        "${game_assets}".to_string(),
        request
            .game_dir
            .join("assets")
            .join("virtual")
            .join("legacy")
            .to_string_lossy()
            .to_string(),
    );
    variables.insert(
        "${library_directory}".to_string(),
        request
            .game_dir
            .join("libraries")
            .to_string_lossy()
            .to_string(),
    );
    variables.insert("${resolution_width}".to_string(), "1200".to_string());
    variables.insert("${resolution_height}".to_string(), "700".to_string());
    variables.insert(
        "${classpath_separator}".to_string(),
        classpath_separator().to_string(),
    );
    variables.insert(
        "${primary_jar}".to_string(),
        request
            .game_dir
            .join("versions")
            .join(&request.version_id)
            .join(format!("{}.jar", request.version_id))
            .to_string_lossy()
            .to_string(),
    );
    Ok(variables)
}

fn resolve_argument_array(
    arguments: &[Value],
    variables: &HashMap<String, String>,
    features: &HashMap<String, bool>,
) -> Vec<String> {
    let mut result = Vec::new();
    for argument in arguments {
        if let Some(raw) = argument.as_str() {
            append_resolved_arguments(&[raw.to_string()], variables, &mut result);
            continue;
        }

        let Some(object) = argument.as_object() else {
            continue;
        };
        if !rules_match(object.get("rules").and_then(Value::as_array), features) {
            continue;
        }

        match object.get("value") {
            Some(Value::Array(values)) => {
                let raw_tokens = values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect::<Vec<_>>();
                append_resolved_arguments(&raw_tokens, variables, &mut result);
            }
            Some(Value::String(value)) => {
                append_resolved_arguments(&[value.clone()], variables, &mut result);
            }
            _ => {}
        }
    }
    result
}

fn append_resolved_arguments(
    raw_tokens: &[String],
    variables: &HashMap<String, String>,
    target: &mut Vec<String>,
) {
    let mut index = 0usize;
    while index < raw_tokens.len() {
        let current = replace_variables(&raw_tokens[index], variables)
            .trim()
            .to_string();
        if current.starts_with("--")
            && index + 1 < raw_tokens.len()
            && !raw_tokens[index + 1].starts_with("--")
        {
            let next = replace_variables(&raw_tokens[index + 1], variables)
                .trim()
                .to_string();
            if !should_omit_resolved_arg(&current) && !should_omit_resolved_arg(&next) {
                target.push(current);
                target.push(next);
            }
            index += 2;
            continue;
        }

        if !should_omit_resolved_arg(&current) {
            target.push(current);
        }
        index += 1;
    }
}

fn replace_variables(input: &str, variables: &HashMap<String, String>) -> String {
    let mut result = input.to_string();
    for (key, value) in variables {
        result = result.replace(key, value);
    }
    result
}

fn should_omit_resolved_arg(arg: &str) -> bool {
    let trimmed = arg.trim();
    trimmed.is_empty() || is_bare_unresolved_placeholder(trimmed)
}

/// True only when the whole token is a single unresolved `${name}` placeholder
/// (`name` being the launcher's identifier form: ASCII letters/digits/`_`), e.g.
/// `${quickPlayRealms}`.
///
/// The previous check was `arg.contains("${")`, which discarded *any* argument
/// merely containing the two characters `${` — including a legitimate launch
/// argument whose path contains them, such as a game directory like
/// `D:\games\mc${x}\.minecraft` (and the `--gameDir` value pointing at it), or a
/// joined system property like `-Dfoo=${bar}`. Minecraft's own unresolved feature
/// placeholders (`${quickPlayPath}`, `${quickPlayRealms}`, …) are always
/// standalone tokens, so restricting the drop to whole-token placeholders keeps
/// every real path/argument intact while still discarding the template leftovers.
fn is_bare_unresolved_placeholder(arg: &str) -> bool {
    arg.len() > 3
        && arg.starts_with("${")
        && arg.ends_with('}')
        && arg[2..arg.len() - 1]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn normalize_jvm_arguments(args: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::with_capacity(args.len());
    let mut index = 0usize;
    while index < args.len() {
        let current = &args[index];

        if let Some(value) = current.strip_prefix("-Djava.library.path ") {
            normalized.push(format!("-Djava.library.path={}", value.trim()));
            index += 1;
            continue;
        }

        if current == "-Djava.library.path" && index + 1 < args.len() {
            normalized.push(format!("-Djava.library.path={}", args[index + 1]));
            index += 2;
            continue;
        }

        if current.starts_with("-D") && !current.contains('=') && index + 1 < args.len() {
            let next = &args[index + 1];
            if next.starts_with('.') {
                normalized.push(format!("{current}{next}"));
                index += 2;
                continue;
            }
        }

        normalized.push(current.clone());
        index += 1;
    }
    normalized
}

fn contains_classpath_arg(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "-cp" || arg == "-classpath" || arg.starts_with("-Djava.class.path="))
}

fn build_classpath(entries: &[PathBuf]) -> String {
    let mut values = entries
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    values.sort();
    values.join(&classpath_separator().to_string())
}

fn ensure_library_downloaded(
    window: Option<&tauri::Window>,
    library: &ResolvedLibrary,
) -> Result<(), String> {
    if library.path.is_file() {
        return Ok(());
    }
    if library.download_urls.is_empty() {
        return Err(format!(
            "Missing download URL for library {}",
            library.path.display()
        ));
    }
    download_file(
        window,
        &library.download_urls,
        &library.path,
        library.sha1.as_deref(),
        "library",
    )
}

fn ensure_client_jar_downloaded(
    window: Option<&tauri::Window>,
    version_json: &Value,
    client_jar: &Path,
    source: DownloadSource,
) -> Result<(), String> {
    if client_jar.is_file() {
        return Ok(());
    }
    let client = version_json
        .get("downloads")
        .and_then(|value| value.get("client"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            format!(
                "Client download info missing and jar not found: {}",
                client_jar.display()
            )
        })?;
    let url = client
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "Client download entry missing url".to_string())?;
    let sha1 = client.get("sha1").and_then(Value::as_str);
    download_file(
        window,
        &source.candidate_urls(url),
        client_jar,
        sha1,
        "client",
    )
}

fn download_file(
    window: Option<&tauri::Window>,
    urls: &[String],
    target: &Path,
    expected_sha1: Option<&str>,
    label: &str,
) -> Result<(), String> {
    if target.is_file() {
        if let Some(expected_sha1) = expected_sha1 {
            if let Ok(actual) = compute_sha1_hex(target) {
                if actual.eq_ignore_ascii_case(expected_sha1) {
                    return Ok(());
                }
            }
        } else {
            return Ok(());
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("Target path has no parent: {}", target.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;

    let tmp = target.with_extension("download");
    // Not the shared download client: this path buffers the whole body via `.bytes()`,
    // where reqwest applies the client timeout as a single whole-body deadline. The client
    // jar (tens of MB) legitimately needs longer than the streaming client's short per-read
    // timeout, so keep the generous general-purpose client here.
    let client = build_blocking_http_client()?;
    let mut last_error = None;
    for url in urls {
        let response = match client.get(url).send() {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(format!("Failed to download {label} from {url}: {error}"));
                continue;
            }
        };
        if !response.status().is_success() {
            last_error = Some(format!(
                "Failed to download {label} from {url}: HTTP {}",
                response.status()
            ));
            continue;
        }

        let bytes = match response.bytes() {
            Ok(bytes) => bytes,
            Err(error) => {
                last_error = Some(format!(
                    "Failed reading {label} response from {url}: {error}"
                ));
                continue;
            }
        };
        if let Err(error) = fs::write(&tmp, &bytes) {
            last_error = Some(format!(
                "Failed writing temp file {}: {error}",
                tmp.display()
            ));
            continue;
        }

        if let Some(expected_sha1) = expected_sha1 {
            match compute_sha1_hex(&tmp) {
                Ok(actual) if actual.eq_ignore_ascii_case(expected_sha1) => {}
                Ok(actual) => {
                    let _ = fs::remove_file(&tmp);
                    last_error = Some(format!(
                        "SHA1 mismatch for {url}: expected={expected_sha1} actual={actual}"
                    ));
                    continue;
                }
                Err(error) => {
                    let _ = fs::remove_file(&tmp);
                    last_error = Some(error);
                    continue;
                }
            }
        }

        fs::rename(&tmp, target)
            .or_else(|_| {
                fs::copy(&tmp, target)
                    .map(|_| ())
                    .and_then(|_| fs::remove_file(&tmp))
            })
            .map_err(|e| format!("Failed to move temp file to {}: {e}", target.display()))?;

        emit_log(
            window,
            "info",
            &format!("Downloaded {label}: {}", target.display()),
        );
        return Ok(());
    }

    Err(last_error.unwrap_or_else(|| format!("Failed downloading {label} to {}", target.display())))
}

fn download_file_with_ipc(
    window: Option<&tauri::Window>,
    session: Option<&str>,
    urls: &[String],
    target: &Path,
    expected_sha1: Option<&str>,
    label: &str,
    artifact: &DownloadArtifact,
) -> Result<bool, String> {
    const DOWNLOAD_PROGRESS_CHUNK_SIZE: usize = 64 * 1024;
    install_cancel_error(session)?;
    if target.is_file() {
        if let Some(expected_sha1) = expected_sha1 {
            if let Ok(actual) = compute_sha1_hex(target) {
                if actual.eq_ignore_ascii_case(expected_sha1) {
                    let total = fs::metadata(target).ok().map(|meta| meta.len());
                    emit_download_item_complete(
                        window,
                        session,
                        artifact,
                        Some(0),
                        total,
                        true,
                        "Already cached",
                    );
                    return Ok(false);
                }
            }
        } else {
            let total = fs::metadata(target).ok().map(|meta| meta.len());
            emit_download_item_complete(
                window,
                session,
                artifact,
                Some(0),
                total,
                true,
                "Already cached",
            );
            return Ok(false);
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("Target path has no parent: {}", target.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;

    emit_download_item_start(window, session, artifact, Some(0), None, "Queued");
    let tmp = target.with_extension("download");
    let client = download_http_client()?;
    let mut last_error = None;
    for url in urls {
        for attempt in 1..=DOWNLOAD_RETRY_ATTEMPTS {
            install_cancel_error(session)?;
            let response = match client.get(url).send() {
                Ok(response) => response,
                Err(error) => {
                    last_error = Some(format!("Failed to download {label} from {url}: {error}"));
                    if attempt < DOWNLOAD_RETRY_ATTEMPTS {
                        emit_download_item_start(
                            window,
                            session,
                            artifact,
                            Some(0),
                            None,
                            &format!("Retrying ({attempt}/{})", DOWNLOAD_RETRY_ATTEMPTS - 1),
                        );
                    }
                    continue;
                }
            };
            if !response.status().is_success() {
                let status = response.status();
                last_error = Some(format!(
                    "Failed to download {label} from {url}: HTTP {status}"
                ));
                // A 4xx means this URL will never serve the file (e.g. the mirror
                // simply doesn't have it) — retrying it is pointless, so fail over to
                // the next candidate immediately instead of burning all attempts here.
                if status.is_client_error() {
                    break;
                }
                if attempt < DOWNLOAD_RETRY_ATTEMPTS {
                    emit_download_item_start(
                        window,
                        session,
                        artifact,
                        Some(0),
                        None,
                        &format!("Retrying ({attempt}/{})", DOWNLOAD_RETRY_ATTEMPTS - 1),
                    );
                }
                continue;
            }

            let total = response.content_length();
            emit_download_item_start(window, session, artifact, Some(0), total, "Downloading");
            let mut response = response;
            let mut output = match fs::File::create(&tmp) {
                Ok(file) => file,
                Err(error) => {
                    last_error = Some(format!(
                        "Failed writing temp file {}: {error}",
                        tmp.display()
                    ));
                    if attempt < DOWNLOAD_RETRY_ATTEMPTS {
                        emit_download_item_start(
                            window,
                            session,
                            artifact,
                            Some(0),
                            total,
                            &format!("Retrying ({attempt}/{})", DOWNLOAD_RETRY_ATTEMPTS - 1),
                        );
                    }
                    continue;
                }
            };
            let mut buffer = [0_u8; DOWNLOAD_PROGRESS_CHUNK_SIZE];
            let mut downloaded_bytes = 0_u64;
            let mut stream_failed = None::<String>;
            let mut last_progress_emit = Instant::now();
            loop {
                install_cancel_error(session)?;
                match response.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read_bytes) => {
                        if let Err(error) = output.write_all(&buffer[..read_bytes]) {
                            stream_failed = Some(format!(
                                "Failed writing temp file {}: {error}",
                                tmp.display()
                            ));
                            break;
                        }
                        downloaded_bytes += read_bytes as u64;
                        if last_progress_emit.elapsed() >= DOWNLOAD_PROGRESS_EMIT_INTERVAL {
                            last_progress_emit = Instant::now();
                            emit_download_item_progress(
                                window,
                                session,
                                artifact,
                                Some(downloaded_bytes),
                                total,
                                "Downloading",
                            );
                        }
                    }
                    Err(error) => {
                        stream_failed = Some(format!(
                            "Failed reading {label} response from {url}: {error}"
                        ));
                        break;
                    }
                }
            }
            if let Some(error) = stream_failed {
                let _ = fs::remove_file(&tmp);
                last_error = Some(error);
                if attempt < DOWNLOAD_RETRY_ATTEMPTS {
                    emit_download_item_start(
                        window,
                        session,
                        artifact,
                        Some(0),
                        total,
                        &format!("Retrying ({attempt}/{})", DOWNLOAD_RETRY_ATTEMPTS - 1),
                    );
                }
                continue;
            }
            if let Err(error) = output.flush() {
                let _ = fs::remove_file(&tmp);
                last_error = Some(format!(
                    "Failed flushing temp file {}: {error}",
                    tmp.display()
                ));
                if attempt < DOWNLOAD_RETRY_ATTEMPTS {
                    emit_download_item_start(
                        window,
                        session,
                        artifact,
                        Some(0),
                        total,
                        &format!("Retrying ({attempt}/{})", DOWNLOAD_RETRY_ATTEMPTS - 1),
                    );
                }
                continue;
            }
            install_cancel_error(session)?;

            if let Some(expected_sha1) = expected_sha1 {
                match compute_sha1_hex(&tmp) {
                    Ok(actual) if actual.eq_ignore_ascii_case(expected_sha1) => {}
                    Ok(actual) => {
                        let _ = fs::remove_file(&tmp);
                        emit_log(
                            window,
                            "warn",
                            &format!(
                                "Checksum mismatch for {label}: expected sha1={expected_sha1}, got {actual}; re-downloading"
                            ),
                        );
                        last_error = Some(format!(
                            "SHA1 mismatch for {url}: expected={expected_sha1} actual={actual}"
                        ));
                        if attempt < DOWNLOAD_RETRY_ATTEMPTS {
                            emit_download_item_start(
                                window,
                                session,
                                artifact,
                                Some(0),
                                total.or(Some(downloaded_bytes)),
                                &format!(
                                    "Checksum failed, retrying ({attempt}/{})",
                                    DOWNLOAD_RETRY_ATTEMPTS - 1
                                ),
                            );
                        }
                        continue;
                    }
                    Err(error) => {
                        let _ = fs::remove_file(&tmp);
                        last_error = Some(error);
                        if attempt < DOWNLOAD_RETRY_ATTEMPTS {
                            emit_download_item_start(
                                window,
                                session,
                                artifact,
                                Some(0),
                                total.or(Some(downloaded_bytes)),
                                &format!("Retrying ({attempt}/{})", DOWNLOAD_RETRY_ATTEMPTS - 1),
                            );
                        }
                        continue;
                    }
                }
            }

            fs::rename(&tmp, target)
                .or_else(|_| {
                    fs::copy(&tmp, target)
                        .map(|_| ())
                        .and_then(|_| fs::remove_file(&tmp))
                })
                .map_err(|e| format!("Failed to move temp file to {}: {e}", target.display()))?;

            emit_log(
                window,
                "info",
                &format!("Downloaded {label}: {}", target.display()),
            );
            emit_download_item_complete(
                window,
                session,
                artifact,
                Some(downloaded_bytes),
                total.or(Some(downloaded_bytes)),
                false,
                "Completed",
            );
            return Ok(true);
        }
    }

    let error =
        last_error.unwrap_or_else(|| format!("Failed downloading {label} to {}", target.display()));
    emit_download_item_error(window, session, artifact, &error);
    Err(error)
}

fn extract_native_jar(native_jar: &Path, natives_dir: &Path) -> Result<(), String> {
    if !native_jar.is_file() {
        return Ok(());
    }
    let file = fs::File::open(native_jar)
        .map_err(|e| format!("Failed to open native jar {}: {e}", native_jar.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid native jar {}: {e}", native_jar.display()))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| {
            format!(
                "Failed to read native jar entry {index} from {}: {e}",
                native_jar.display()
            )
        })?;
        let name = entry.name().replace('\\', "/");
        if name.starts_with("META-INF") || entry.is_dir() {
            continue;
        }
        let target = natives_dir.join(&name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create native output directory {}: {e}",
                    parent.display()
                )
            })?;
        }
        let mut output = fs::File::create(&target).map_err(|e| {
            format!(
                "Failed to create extracted native {}: {e}",
                target.display()
            )
        })?;
        io::copy(&mut entry, &mut output)
            .map_err(|e| format!("Failed to extract native {}: {e}", target.display()))?;
    }
    Ok(())
}

fn get_json_with_timeout(url: &str, timeout: Option<Duration>) -> Result<Value, String> {
    let client = build_http_client_with_optional_timeout(timeout)?;
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Request failed url={url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Request failed url={url} status={}",
            response.status()
        ));
    }
    response
        .json::<Value>()
        .map_err(|e| format!("Invalid JSON from {url}: {e}"))
}

fn get_json_from_candidates(
    window: Option<&tauri::Window>,
    urls: &[String],
    timeout: Option<Duration>,
) -> Result<Value, String> {
    let mut last_error = None;
    for url in urls {
        emit_log(window, "info", &format!("Fetching metadata: {url}"));
        match get_json_with_timeout(url, timeout) {
            Ok(payload) => return Ok(payload),
            Err(error) => {
                emit_log(
                    window,
                    "warn",
                    &format!("Metadata request failed, trying next source if available: {error}"),
                );
                last_error = Some(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "No candidate URL provided".to_string()))
}

fn get_text_with_timeout(url: &str, timeout: Option<Duration>) -> Result<String, String> {
    let client = build_http_client_with_optional_timeout(timeout)?;
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Request failed url={url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Request failed url={url} status={}",
            response.status()
        ));
    }
    response
        .text()
        .map_err(|e| format!("Invalid text response from {url}: {e}"))
}

fn build_http_client_with_optional_timeout(
    timeout: Option<Duration>,
) -> Result<reqwest::blocking::Client, String> {
    match timeout {
        Some(timeout) => reqwest::blocking::Client::builder()
            .timeout(timeout)
            .user_agent(crate::JDK_DOWNLOAD_USER_AGENT)
            .build()
            .map_err(|e| format!("Failed to build blocking HTTP client: {e}")),
        None => build_blocking_http_client(),
    }
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read JSON file {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("Invalid JSON file {}: {e}", path.display()))
}

fn find_version_from_manifest(
    window: Option<&tauri::Window>,
    ipc_session: Option<&str>,
    phase: &str,
    version_id: &str,
    source: DownloadSource,
) -> Result<Value, String> {
    emit_install_phase_start(
        window,
        ipc_session,
        phase,
        "fetch-manifest",
        &format!("Fetching version manifest for {version_id}"),
    );
    let manifest = get_json_from_candidates(
        window,
        &source.version_manifest_urls(),
        Some(DownloadSource::METADATA_TIMEOUT),
    )?;
    let versions = manifest
        .get("versions")
        .and_then(Value::as_array)
        .ok_or_else(|| "Version manifest missing versions array".to_string())?;
    versions
        .iter()
        .find(|value| value.get("id").and_then(Value::as_str) == Some(version_id))
        .cloned()
        .ok_or_else(|| format!("Version not found in manifest: {version_id}"))
}

fn unique_urls(urls: Vec<String>) -> Vec<String> {
    let mut seen = Vec::<String>::new();
    for url in urls {
        if !seen.iter().any(|existing| existing == &url) {
            seen.push(url);
        }
    }
    seen
}

fn normalize_metadata_url(url: &str) -> String {
    if url.starts_with("https://") || url.starts_with("http://") {
        return url.to_string();
    }
    if let Some(suffix) = url.strip_prefix('/') {
        return format!("https://piston-meta.mojang.com/{suffix}");
    }
    url.to_string()
}

fn normalize_base_url(url: &str) -> String {
    if url.ends_with('/') {
        url.to_string()
    } else {
        format!("{url}/")
    }
}

fn minecraft_os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn arch_token() -> &'static str {
    if cfg!(target_pointer_width = "64") {
        "64"
    } else {
        "32"
    }
}

fn classpath_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

#[derive(Debug, Clone)]
struct ForgeInstallerProfile {
    new_style: bool,
    payload: Value,
}

#[derive(Debug, Clone)]
struct ProcessOutput {
    exit_code: i32,
    output: String,
}

fn compare_forge_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let left_parts = left.split(['-', '.']).collect::<Vec<_>>();
    let right_parts = right.split(['-', '.']).collect::<Vec<_>>();
    let max = left_parts.len().max(right_parts.len());
    for index in 0..max {
        let left_value = left_parts
            .get(index)
            .and_then(|value| value.parse::<i32>().ok())
            .unwrap_or(0);
        let right_value = right_parts
            .get(index)
            .and_then(|value| value.parse::<i32>().ok())
            .unwrap_or(0);
        let cmp = left_value.cmp(&right_value);
        if cmp != std::cmp::Ordering::Equal {
            return cmp;
        }
    }
    left.cmp(right)
}

fn ensure_launcher_profiles(game_dir: &Path) -> Result<(), String> {
    let launcher_profiles = game_dir.join("launcher_profiles.json");
    if launcher_profiles.exists() {
        return Ok(());
    }
    fs::write(
        &launcher_profiles,
        r#"{
  "profiles": {
    "FPSMaster": {
      "name": "FPSMaster",
      "type": "custom",
      "lastVersionId": "latest-release"
    }
  },
  "selectedProfile": "FPSMaster",
  "clientToken": "00000000000000000000000000000000",
  "authenticationDatabase": {},
  "settings": {},
  "version": 3
}"#,
    )
    .map_err(|e| {
        format!(
            "Failed to write launcher profiles {}: {e}",
            launcher_profiles.display()
        )
    })
}

fn inspect_forge_installer(installer_path: &Path) -> Result<ForgeInstallerProfile, String> {
    let file = fs::File::open(installer_path).map_err(|e| {
        format!(
            "Failed to open forge installer {}: {e}",
            installer_path.display()
        )
    })?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid forge installer {}: {e}", installer_path.display()))?;
    let mut entry = archive
        .by_name("install_profile.json")
        .map_err(|e| format!("Forge installer missing install_profile.json: {e}"))?;
    let mut text = String::new();
    use std::io::Read;
    entry
        .read_to_string(&mut text)
        .map_err(|e| format!("Failed reading install_profile.json: {e}"))?;
    let payload: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid forge install_profile.json: {e}"))?;
    Ok(ForgeInstallerProfile {
        new_style: payload.get("spec").is_some(),
        payload,
    })
}

fn install_forge_old_profile(
    game_dir: &Path,
    forge_version: &str,
    installer_path: &Path,
    install_profile: &Value,
) -> Result<String, String> {
    let install = install_profile
        .get("install")
        .and_then(Value::as_object)
        .ok_or_else(|| "Old forge installer is missing install block".to_string())?;
    let version_info = install_profile
        .get("versionInfo")
        .ok_or_else(|| "Old forge installer is missing versionInfo block".to_string())?;
    let file_path = install
        .get("filePath")
        .and_then(Value::as_str)
        .ok_or_else(|| "Old forge installer missing filePath".to_string())?;
    let path_descriptor = install
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "Old forge installer missing path".to_string())?;

    let artifact = MavenCoordinates::parse(path_descriptor)?;
    let target_library = game_dir.join("libraries").join(artifact.to_jar_path());
    if let Some(parent) = target_library.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create forge library dir {}: {e}",
                parent.display()
            )
        })?;
    }

    let file = fs::File::open(installer_path).map_err(|e| {
        format!(
            "Failed to open forge installer {}: {e}",
            installer_path.display()
        )
    })?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid forge installer {}: {e}", installer_path.display()))?;
    let mut entry = archive.by_name(file_path).map_err(|e| {
        format!(
            "Old forge installer universal jar not found {} in {}: {e}",
            file_path,
            installer_path.display()
        )
    })?;
    let mut output = fs::File::create(&target_library).map_err(|e| {
        format!(
            "Failed to create forge universal jar {}: {e}",
            target_library.display()
        )
    })?;
    io::copy(&mut entry, &mut output).map_err(|e| {
        format!(
            "Failed to extract forge universal jar {}: {e}",
            target_library.display()
        )
    })?;

    let version_id = version_info
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Forge legacy profile missing id for {forge_version}"))?
        .to_string();
    let version_dir = game_dir.join("versions").join(&version_id);
    fs::create_dir_all(&version_dir).map_err(|e| {
        format!(
            "Failed to create forge version dir {}: {e}",
            version_dir.display()
        )
    })?;
    let version_json_path = version_dir.join(format!("{version_id}.json"));
    fs::write(
        &version_json_path,
        serde_json::to_string(version_info)
            .map_err(|e| format!("Failed to serialize forge legacy profile {version_id}: {e}"))?,
    )
    .map_err(|e| {
        format!(
            "Failed to write forge legacy profile {}: {e}",
            version_json_path.display()
        )
    })?;
    Ok(version_id)
}

fn run_forge_installer(
    game_dir: &Path,
    java_executable: &Path,
    installer_path: &Path,
    args: &[&str],
) -> Result<ProcessOutput, String> {
    let mut command = std::process::Command::new(java_executable);
    command.arg("-jar").arg(installer_path);
    command.args(args);
    command.current_dir(game_dir);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().map_err(|e| {
        format!(
            "Failed to run forge installer {}: {e}",
            installer_path.display()
        )
    })?;
    let mut text = String::new();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(ProcessOutput {
        exit_code: output.status.code().unwrap_or(-1),
        output: text,
    })
}

fn select_forge_profile_id_after_install(
    game_dir: &Path,
    game_version: &str,
    forge_version: &str,
    install_profile: &Value,
) -> Result<String, String> {
    for candidate in forge_profile_id_candidates(game_version, forge_version, install_profile) {
        let profile_json = game_dir
            .join("versions")
            .join(&candidate)
            .join(format!("{candidate}.json"));
        if profile_json.is_file() {
            return Ok(candidate);
        }
    }
    first_profile_id_after_install(game_dir, game_version)
}

fn forge_profile_id_candidates(
    game_version: &str,
    forge_version: &str,
    install_profile: &Value,
) -> Vec<String> {
    let mut candidates = Vec::new();
    push_forge_profile_id_candidate(
        &mut candidates,
        install_profile.get("version").and_then(Value::as_str),
    );
    push_forge_profile_id_candidate(
        &mut candidates,
        install_profile.get("json").and_then(Value::as_str),
    );
    if let Some(forge_part) = forge_version
        .strip_prefix(game_version)
        .and_then(|value| value.strip_prefix('-'))
        .filter(|value| !value.trim().is_empty())
    {
        push_forge_profile_id_candidate(
            &mut candidates,
            Some(&format!("{game_version}-forge-{forge_part}")),
        );
    }
    push_forge_profile_id_candidate(
        &mut candidates,
        Some(&format!("{game_version}-forge{forge_version}")),
    );
    candidates
}

fn push_forge_profile_id_candidate(candidates: &mut Vec<String>, value: Option<&str>) {
    let Some(raw_value) = value.map(str::trim).filter(|item| !item.is_empty()) else {
        return;
    };
    let normalized = raw_value.trim_end_matches(['/', '\\']);
    let profile_id = if normalized.ends_with(".json") {
        Path::new(normalized)
            .file_stem()
            .map(|item| item.to_string_lossy().to_string())
            .unwrap_or_else(|| normalized.trim_end_matches(".json").to_string())
    } else {
        Path::new(normalized)
            .file_name()
            .map(|item| item.to_string_lossy().to_string())
            .unwrap_or_else(|| normalized.to_string())
    };
    if !profile_id.is_empty() && !candidates.iter().any(|item| item == &profile_id) {
        candidates.push(profile_id);
    }
}

fn first_profile_id_after_install(game_dir: &Path, game_version: &str) -> Result<String, String> {
    let versions_dir = game_dir.join("versions");
    let read_dir = fs::read_dir(&versions_dir).map_err(|e| {
        format!(
            "Failed to read forge versions dir {}: {e}",
            versions_dir.display()
        )
    })?;
    let mut candidates = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed reading forge versions dir entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
        else {
            continue;
        };
        if name.contains("forge") && name.contains(game_version) {
            candidates.push(name);
        }
    }
    candidates.sort();
    candidates
        .pop()
        .ok_or_else(|| "Forge profile not found after installer run".to_string())
}

fn download_client(
    window: Option<&tauri::Window>,
    version_json: &Value,
    version_dir: &Path,
    version_id: &str,
    phase: &str,
    ipc_session: Option<&str>,
    source: DownloadSource,
) -> Result<bool, String> {
    let client = version_json
        .get("downloads")
        .and_then(|value| value.get("client"))
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Client download info missing for {version_id}"))?;
    let url = client
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Client download url missing for {version_id}"))?;
    let sha1 = client.get("sha1").and_then(Value::as_str);
    let target = version_dir.join(format!("{version_id}.jar"));
    let artifact = DownloadArtifact::new("client", phase, "client", &target, "client");
    download_file_with_ipc(
        window,
        ipc_session,
        &source.candidate_urls(url),
        &target,
        sha1,
        "client",
        &artifact,
    )
}

fn download_libraries(
    window: Option<&tauri::Window>,
    version_json: &Value,
    game_dir: &Path,
    phase: &str,
    ipc_session: Option<&str>,
    source: DownloadSource,
    download_threads: usize,
) -> Result<i32, String> {
    install_cancel_error(ipc_session)?;
    let libraries = resolve_libraries(version_json, game_dir, &build_rule_features(), source)?;
    let mut unique = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for library in libraries {
        if library.download_urls.is_empty() {
            continue;
        }
        if seen.insert(library.path.clone()) {
            unique.push(library);
        }
    }

    let total = unique.len();
    emit_install_progress(
        window,
        ipc_session,
        phase,
        "libraries",
        0,
        total as i32,
        0,
        total as i32,
        "Start downloading libraries",
    );
    let jobs = unique
        .into_iter()
        .map(|library| {
            let target = library.path.clone();
            DownloadJob {
                urls: library.download_urls,
                target,
                expected_sha1: library.sha1,
                label: "library".to_string(),
                artifact: DownloadArtifact::new(
                    if library.native_entry {
                        "native"
                    } else {
                        "library"
                    },
                    phase,
                    "libraries",
                    &library.path,
                    if library.native_entry {
                        "native"
                    } else {
                        "library"
                    },
                ),
            }
        })
        .collect::<Vec<_>>();
    download_jobs_in_parallel(
        window,
        ipc_session,
        phase,
        "libraries",
        jobs,
        download_threads,
    )
}

fn download_assets(
    window: Option<&tauri::Window>,
    version_json: &Value,
    game_dir: &Path,
    phase: &str,
    ipc_session: Option<&str>,
    source: DownloadSource,
    download_threads: usize,
) -> Result<i32, String> {
    install_cancel_error(ipc_session)?;
    let asset_index = version_json
        .get("assetIndex")
        .and_then(Value::as_object)
        .ok_or_else(|| "Version metadata missing assetIndex".to_string())?;
    let asset_index_id = asset_index
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "assetIndex missing id".to_string())?;
    let asset_index_url = asset_index
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "assetIndex missing url".to_string())?;
    let asset_index_sha1 = asset_index.get("sha1").and_then(Value::as_str);
    let asset_index_path = game_dir
        .join("assets")
        .join("indexes")
        .join(format!("{asset_index_id}.json"));
    let asset_index_artifact = DownloadArtifact::new(
        "asset-index",
        phase,
        "assets",
        &asset_index_path,
        "asset-index",
    );
    let _ = download_file_with_ipc(
        window,
        ipc_session,
        &source.candidate_urls(asset_index_url),
        &asset_index_path,
        asset_index_sha1,
        "asset-index",
        &asset_index_artifact,
    )?;
    install_cancel_error(ipc_session)?;

    let index_text = fs::read_to_string(&asset_index_path).map_err(|e| {
        format!(
            "Failed to read asset index {}: {e}",
            asset_index_path.display()
        )
    })?;
    let index_json: Value = serde_json::from_str(&index_text)
        .map_err(|e| format!("Invalid asset index {}: {e}", asset_index_path.display()))?;
    let objects = index_json
        .get("objects")
        .and_then(Value::as_object)
        .ok_or_else(|| "Asset index missing objects".to_string())?;

    emit_install_progress(
        window,
        ipc_session,
        phase,
        "assets",
        0,
        objects.len() as i32,
        0,
        objects.len() as i32,
        "Start downloading assets",
    );

    let mut unique_assets: Vec<(String, PathBuf, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for object in objects.values() {
        let hash = object
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(|| "Asset object missing hash".to_string())?;
        let prefix = &hash[0..2];
        let target = game_dir
            .join("assets")
            .join("objects")
            .join(prefix)
            .join(hash);
        if seen.insert(target.clone()) {
            unique_assets.push((hash.to_string(), target, hash.to_string()));
        }
    }

    let jobs = unique_assets
        .iter()
        .map(|(_, target, hash)| DownloadJob {
            urls: source.candidate_urls(&format!(
                "{}{}/{}",
                source.default_asset_repo(),
                &hash[0..2],
                hash
            )),
            target: target.clone(),
            expected_sha1: Some(hash.clone()),
            label: "asset".to_string(),
            artifact: DownloadArtifact::new("asset", phase, "assets", target, "asset"),
        })
        .collect::<Vec<_>>();
    let _downloaded =
        download_jobs_in_parallel(window, ipc_session, phase, "assets", jobs, download_threads)?;

    let legacy_dir = game_dir.join("assets").join("virtual").join("legacy");
    fs::create_dir_all(&legacy_dir).map_err(|e| {
        format!(
            "Failed to create legacy assets dir {}: {e}",
            legacy_dir.display()
        )
    })?;
    for (path, object) in objects {
        let hash = object
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(|| "Asset object missing hash".to_string())?;
        let source_path = game_dir
            .join("assets")
            .join("objects")
            .join(&hash[0..2])
            .join(hash);
        let target = legacy_dir.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create asset parent {}: {e}", parent.display()))?;
        }
        if !target.exists() {
            fs::copy(&source_path, &target).map_err(|e| {
                format!(
                    "Failed to copy legacy asset {} to {}: {e}",
                    source_path.display(),
                    target.display()
                )
            })?;
        }
    }

    Ok(unique_assets.len() as i32)
}

#[derive(Debug, Clone)]
struct DownloadJob {
    urls: Vec<String>,
    target: PathBuf,
    expected_sha1: Option<String>,
    label: String,
    artifact: DownloadArtifact,
}

const DOWNLOAD_RETRY_ATTEMPTS: usize = 3;
// Progress IPC per item at most this often; the dialog only refreshes on a 500ms
// poll, so per-64KB-chunk events were pure serialization overhead.
const DOWNLOAD_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(200);

// One shared HTTP client for all file downloads. reqwest pools keep-alive connections
// per client, so building a client per file (the previous behavior) forced a fresh
// DNS + TCP + TLS handshake for every one of the thousands of small asset/library
// files — the dominant cost of an install, far ahead of actual transfer time.
//
// This is deliberately separate from the general API/metadata client so its aggressive
// stall detection stays on the download hot path — it is used only by the streaming
// `download_file_with_ipc`. The timeout is the important part: for reqwest's blocking
// client, `Response`'s `Read` impl wraps *each* `read()` call in `wait::timeout(_, timeout)`
// (see reqwest blocking/response.rs), so on a streamed body this acts as a per-read idle
// timeout, not a whole-request deadline — a healthy transfer resets it on every chunk.
// Without it a peer that accepts the connection then stalls mid-body — extremely common
// for the Mojang CDN from mainland China — blocks until the total timeout before the next
// mirror candidate is tried, so fallback never appears to happen. 20s of complete silence
// on the socket is a genuine stall and triggers a fast failover to the next candidate.
fn download_http_client() -> Result<&'static reqwest::blocking::Client, String> {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::LAUNCHER_HTTP_USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| client))
}

fn download_jobs_in_parallel(
    window: Option<&tauri::Window>,
    ipc_session: Option<&str>,
    phase: &str,
    stage: &str,
    jobs: Vec<DownloadJob>,
    download_threads: usize,
) -> Result<i32, String> {
    if jobs.is_empty() {
        return Ok(0);
    }

    let total = jobs.len();
    let worker_count = download_threads.max(1).min(total);
    for job in &jobs {
        emit_download_item_start(window, ipc_session, &job.artifact, Some(0), None, "Queued");
    }
    let queue = Arc::new(Mutex::new(std::collections::VecDeque::from(jobs)));
    let completed = Arc::new(AtomicUsize::new(0));
    let downloaded = Arc::new(AtomicUsize::new(0));
    let error = Arc::new(Mutex::new(None::<String>));
    let window_cloned = window.cloned();
    let session_owned = ipc_session.map(ToString::to_string);
    let phase_owned = phase.to_string();
    let stage_owned = stage.to_string();

    let mut workers = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let queue = Arc::clone(&queue);
        let completed = Arc::clone(&completed);
        let downloaded = Arc::clone(&downloaded);
        let error = Arc::clone(&error);
        let window = window_cloned.clone();
        let session = session_owned.clone();
        let phase = phase_owned.clone();
        let stage = stage_owned.clone();
        workers.push(thread::spawn(move || loop {
            if error.lock().unwrap().is_some() {
                return;
            }
            if let Err(cancel_error) = install_cancel_error(session.as_deref()) {
                *error.lock().unwrap() = Some(cancel_error);
                return;
            }

            let next = {
                let mut guard = queue.lock().unwrap();
                guard.pop_front()
            };
            let Some(job) = next else {
                return;
            };

            let outcome = download_file_with_ipc(
                window.as_ref(),
                session.as_deref(),
                &job.urls,
                &job.target,
                job.expected_sha1.as_deref(),
                &job.label,
                &job.artifact,
            );

            match outcome {
                Ok(fetched) => {
                    let current = completed.fetch_add(1, Ordering::Relaxed) + 1;
                    if fetched {
                        downloaded.fetch_add(1, Ordering::Relaxed);
                    }
                    let downloaded_now = downloaded.load(Ordering::Relaxed);
                    emit_install_progress(
                        window.as_ref(),
                        session.as_deref(),
                        &phase,
                        &stage,
                        current as i32,
                        total as i32,
                        downloaded_now as i32,
                        (current - downloaded_now) as i32,
                        &format!("Downloaded {stage} {current}/{total}"),
                    );
                }
                Err(err) => {
                    *error.lock().unwrap() = Some(err);
                    return;
                }
            }
        }));
    }

    for worker in workers {
        if worker.join().is_err() {
            return Err(format!("{stage} download worker panicked"));
        }
    }

    if let Some(err) = error.lock().unwrap().clone() {
        return Err(err);
    }

    Ok(downloaded.load(Ordering::Relaxed) as i32)
}

#[derive(Debug, Clone)]
struct DownloadArtifact {
    id: String,
    name: String,
    kind: String,
    stage: String,
    phase: String,
}

impl DownloadArtifact {
    fn new(prefix: &str, phase: &str, stage: &str, path: &Path, kind: &str) -> Self {
        Self {
            id: format!(
                "{prefix}:{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(path.to_string_lossy().as_bytes())
            ),
            name: path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string_lossy().to_string()),
            kind: kind.to_string(),
            stage: stage.to_string(),
            phase: phase.to_string(),
        }
    }
}

fn emit_install_phase_start(
    window: Option<&tauri::Window>,
    session: Option<&str>,
    phase: &str,
    stage: &str,
    message: &str,
) {
    emit_install_ipc(
        window,
        session,
        "phase-start",
        phase,
        stage,
        None,
        None,
        None,
        None,
        Some(message),
        None,
    );
}

fn emit_install_phase_complete(
    window: Option<&tauri::Window>,
    session: Option<&str>,
    phase: &str,
    stage: &str,
    message: &str,
) {
    emit_install_ipc(
        window,
        session,
        "phase-complete",
        phase,
        stage,
        None,
        None,
        None,
        None,
        Some(message),
        None,
    );
}

fn emit_install_progress(
    window: Option<&tauri::Window>,
    session: Option<&str>,
    phase: &str,
    stage: &str,
    current: i32,
    total: i32,
    downloaded: i32,
    cached: i32,
    message: &str,
) {
    emit_install_ipc(
        window,
        session,
        "progress",
        phase,
        stage,
        Some(current),
        Some(total),
        Some(downloaded),
        Some(cached),
        Some(message),
        None,
    );
}

fn emit_download_item_start(
    window: Option<&tauri::Window>,
    session: Option<&str>,
    artifact: &DownloadArtifact,
    current_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: &str,
) {
    emit_install_item_ipc(
        window,
        session,
        "item-start",
        artifact,
        current_bytes,
        total_bytes,
        Some(message),
        None,
        None,
    );
}

fn emit_download_item_progress(
    window: Option<&tauri::Window>,
    session: Option<&str>,
    artifact: &DownloadArtifact,
    current_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: &str,
) {
    emit_install_item_ipc(
        window,
        session,
        "item-progress",
        artifact,
        current_bytes,
        total_bytes,
        Some(message),
        None,
        None,
    );
}

fn emit_download_item_complete(
    window: Option<&tauri::Window>,
    session: Option<&str>,
    artifact: &DownloadArtifact,
    current_bytes: Option<u64>,
    total_bytes: Option<u64>,
    cached: bool,
    message: &str,
) {
    emit_install_item_ipc(
        window,
        session,
        "item-complete",
        artifact,
        current_bytes,
        total_bytes,
        Some(message),
        None,
        Some(cached),
    );
}

fn emit_download_item_error(
    window: Option<&tauri::Window>,
    session: Option<&str>,
    artifact: &DownloadArtifact,
    error: &str,
) {
    emit_install_item_ipc(
        window,
        session,
        "item-error",
        artifact,
        None,
        None,
        Some(error),
        Some(error),
        None,
    );
}

fn emit_install_ipc(
    window: Option<&tauri::Window>,
    session: Option<&str>,
    event: &str,
    phase: &str,
    stage: &str,
    current: Option<i32>,
    total: Option<i32>,
    downloaded: Option<i32>,
    cached: Option<i32>,
    message: Option<&str>,
    error: Option<&str>,
) {
    let mut payload = serde_json::Map::new();
    payload.insert("channel".to_string(), Value::String("install".to_string()));
    payload.insert("event".to_string(), Value::String(event.to_string()));
    payload.insert("phase".to_string(), Value::String(phase.to_string()));
    payload.insert("stage".to_string(), Value::String(stage.to_string()));
    if let Some(session) = session.filter(|value| !value.trim().is_empty()) {
        payload.insert(
            "session".to_string(),
            Value::String(session.trim().to_string()),
        );
    }
    if let Some(current) = current {
        payload.insert("current".to_string(), Value::Number(current.into()));
    }
    if let Some(total) = total {
        payload.insert("total".to_string(), Value::Number(total.into()));
    }
    if let Some(downloaded) = downloaded {
        payload.insert("downloaded".to_string(), Value::Number(downloaded.into()));
    }
    if let Some(cached) = cached {
        payload.insert("cached".to_string(), Value::Number(cached.into()));
    }
    if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
        payload.insert("message".to_string(), Value::String(message.to_string()));
    }
    if let Some(error) = error.filter(|value| !value.trim().is_empty()) {
        payload.insert("error".to_string(), Value::String(error.to_string()));
    }

    let line = format!(
        "[ipc]{}",
        serde_json::to_string(&Value::Object(payload)).unwrap_or_else(|_| "{}".to_string())
    );
    emit_log(window, "stderr", &line);
}

fn emit_install_item_ipc(
    window: Option<&tauri::Window>,
    session: Option<&str>,
    event: &str,
    artifact: &DownloadArtifact,
    current_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: Option<&str>,
    error: Option<&str>,
    cached: Option<bool>,
) {
    let mut payload = serde_json::Map::new();
    payload.insert("channel".to_string(), Value::String("install".to_string()));
    payload.insert("event".to_string(), Value::String(event.to_string()));
    payload.insert("phase".to_string(), Value::String(artifact.phase.clone()));
    payload.insert("stage".to_string(), Value::String(artifact.stage.clone()));
    if let Some(session) = session.filter(|value| !value.trim().is_empty()) {
        payload.insert(
            "session".to_string(),
            Value::String(session.trim().to_string()),
        );
    }
    payload.insert("itemId".to_string(), Value::String(artifact.id.clone()));
    payload.insert("itemName".to_string(), Value::String(artifact.name.clone()));
    payload.insert("itemKind".to_string(), Value::String(artifact.kind.clone()));
    if let Some(current_bytes) = current_bytes {
        payload.insert(
            "itemCurrentBytes".to_string(),
            Value::Number(current_bytes.into()),
        );
    }
    if let Some(total_bytes) = total_bytes {
        payload.insert(
            "itemTotalBytes".to_string(),
            Value::Number(total_bytes.into()),
        );
    }
    if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
        payload.insert("message".to_string(), Value::String(message.to_string()));
    }
    if let Some(error) = error.filter(|value| !value.trim().is_empty()) {
        payload.insert("error".to_string(), Value::String(error.to_string()));
    }
    if let Some(cached) = cached {
        payload.insert("itemCached".to_string(), Value::Bool(cached));
    }

    let line = format!(
        "[ipc]{}",
        serde_json::to_string(&Value::Object(payload)).unwrap_or_else(|_| "{}".to_string())
    );
    emit_log(window, "stderr", &line);
}

#[cfg(test)]
mod tests {
    use super::{
        build_rule_features, build_vanilla_launch_plan, forge_profile_id_candidates,
        resolve_java_runtime_requirement, resolve_optifine_compatibility, should_omit_resolved_arg,
        DownloadSource, VanillaLaunchRequest,
    };
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("fpsmaster-launcher-{name}-{unique}"));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    #[test]
    fn download_source_matches_existing_aliases_and_rewrites() {
        assert_eq!(
            DownloadSource::from_id(Some("mojang")).expect("alias should resolve"),
            DownloadSource::OfficialOnly
        );
        assert_eq!(
            DownloadSource::from_id(Some("mirror")).expect("alias should resolve"),
            DownloadSource::MirrorFirst
        );
        assert_eq!(
            DownloadSource::MirrorFirst.version_manifest_urls(),
            vec![
                "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json".to_string(),
                "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json".to_string()
            ]
        );
        assert_eq!(
            DownloadSource::rewrite_url_for_mirror(
                "https://libraries.minecraft.net/com/example/demo/1.0/demo-1.0.jar"
            ),
            "https://bmclapi2.bangbang93.com/libraries/com/example/demo/1.0/demo-1.0.jar"
        );
    }

    #[test]
    fn resolve_java_runtime_requirement_uses_local_inherited_version_metadata() {
        let game_dir = make_temp_dir("java-runtime");
        let parent_dir = game_dir.join("versions").join("1.20.1");
        let child_dir = game_dir.join("versions").join("custom");
        fs::create_dir_all(&parent_dir).expect("parent dir should exist");
        fs::create_dir_all(&child_dir).expect("child dir should exist");

        fs::write(
            parent_dir.join("1.20.1.json"),
            json!({
                "id": "1.20.1",
                "mainClass": "net.minecraft.client.main.Main",
                "assetIndex": { "id": "1.20" },
                "libraries": [],
                "javaVersion": {
                    "majorVersion": 21,
                    "component": "java-runtime-gamma"
                }
            })
            .to_string(),
        )
        .expect("parent version json should be written");

        fs::write(
            child_dir.join("custom.json"),
            json!({
                "id": "custom",
                "inheritsFrom": "1.20.1"
            })
            .to_string(),
        )
        .expect("child version json should be written");

        let requirement = resolve_java_runtime_requirement(Some(&game_dir), "custom", None)
            .expect("local java runtime requirement should resolve");
        assert_eq!(requirement.major_version, 21);
        assert_eq!(requirement.component, "java-runtime-gamma");
    }

    #[test]
    fn build_launch_plan_skips_feature_gated_demo_arg_by_default() {
        let game_dir = make_temp_dir("build-plan");
        let version_dir = game_dir.join("versions").join("test-version");
        fs::create_dir_all(&version_dir).expect("version dir should exist");
        fs::write(version_dir.join("test-version.jar"), "").expect("jar should exist");
        fs::write(
            version_dir.join("test-version.json"),
            json!({
                "id": "test-version",
                "mainClass": "net.minecraft.client.main.Main",
                "libraries": [],
                "assetIndex": { "id": "test-assets" },
                "arguments": {
                    "jvm": ["-Djava.library.path", "${natives_directory}"],
                    "game": [
                        {
                            "rules": [
                                {
                                    "action": "allow",
                                    "features": { "is_demo_user": true }
                                }
                            ],
                            "value": "--demo"
                        },
                        {
                            "rules": [
                                {
                                    "action": "allow",
                                    "features": { "has_custom_resolution": true }
                                }
                            ],
                            "value": ["--width", "${resolution_width}", "--height", "${resolution_height}"]
                        },
                        "--username",
                        "${auth_player_name}"
                    ]
                }
            })
            .to_string(),
        )
        .expect("version json should be written");

        let request = VanillaLaunchRequest {
            game_dir: game_dir.clone(),
            version_id: "test-version".to_string(),
            player_name: "Player".to_string(),
            uuid: "00000000-0000-0000-0000-000000000000".to_string(),
            access_token: "offline".to_string(),
            java_path: PathBuf::from("java"),
            max_memory_mb: 1024,
            server_address: None,
            fpsmaster_token: None,
        };
        let plan =
            build_vanilla_launch_plan(None, &request, None).expect("launch plan should be built");

        assert!(!plan.plan.command.contains(&"--demo".to_string()));
        assert!(plan.plan.command.contains(&"--username".to_string()));
        assert!(plan.plan.command.contains(&"Player".to_string()));
        assert!(plan
            .plan
            .command
            .windows(2)
            .any(|args| args == ["--width", "1200"]));
        assert!(plan
            .plan
            .command
            .windows(2)
            .any(|args| args == ["--height", "700"]));
        assert!(plan.natives_dir.starts_with(version_dir.join("natives")));
    }

    #[test]
    fn build_launch_plan_creates_isolated_natives_directory_per_call() {
        let game_dir = make_temp_dir("isolated-natives");
        let version_dir = game_dir.join("versions").join("test-version");
        fs::create_dir_all(&version_dir).expect("version dir should exist");
        fs::write(version_dir.join("test-version.jar"), "").expect("jar should exist");
        fs::write(
            version_dir.join("test-version.json"),
            json!({
                "id": "test-version",
                "mainClass": "missing.Main",
                "libraries": [],
                "assetIndex": { "id": "test-assets" },
                "arguments": {
                    "jvm": ["-Djava.library.path", "${natives_directory}"],
                    "game": ["--username", "${auth_player_name}"]
                }
            })
            .to_string(),
        )
        .expect("version json should be written");

        let request = VanillaLaunchRequest {
            game_dir: game_dir.clone(),
            version_id: "test-version".to_string(),
            player_name: "Player".to_string(),
            uuid: "00000000-0000-0000-0000-000000000000".to_string(),
            access_token: "offline".to_string(),
            java_path: PathBuf::from("java"),
            max_memory_mb: 512,
            server_address: None,
            fpsmaster_token: None,
        };

        let first = build_vanilla_launch_plan(None, &request, None)
            .expect("first launch plan should build");
        let second = build_vanilla_launch_plan(None, &request, None)
            .expect("second launch plan should build");

        assert_ne!(first.natives_dir, second.natives_dir);
        assert!(first.natives_dir.starts_with(version_dir.join("natives")));
        assert!(second.natives_dir.starts_with(version_dir.join("natives")));
    }

    #[test]
    fn rule_features_keep_expected_defaults() {
        let features = build_rule_features();
        assert_eq!(features.get("is_demo_user"), Some(&false));
        assert_eq!(features.get("has_custom_resolution"), Some(&true));
    }

    #[test]
    fn optifine_without_forge_hint_is_compatible_with_forge() {
        let compatibility = resolve_optifine_compatibility(
            "1.8.9",
            "HD_U_L6_pre1",
            "forge",
            Some("1.8.9-11.15.1.2318-1.8.9"),
            None,
        );

        assert_eq!(compatibility, ("compatible", None));
    }

    #[test]
    fn optifine_189_m6_preview_is_compatible_with_latest_forge() {
        let compatibility = resolve_optifine_compatibility(
            "1.8.9",
            "HD_U_M6_pre2",
            "forge",
            Some("1.8.9-11.15.1.2318-1.8.9"),
            Some("Forge #1902"),
        );

        assert_eq!(compatibility, ("compatible", None));
    }

    #[test]
    fn forge_profile_candidates_keep_dotted_profile_ids() {
        let candidates = forge_profile_id_candidates(
            "1.20.1",
            "1.20.1-47.0.35",
            &json!({
                "version": "1.20.1-forge-47.0.35",
                "json": "versions/1.20.1-forge-47.0.35/1.20.1-forge-47.0.35.json"
            }),
        );

        assert_eq!(candidates[0], "1.20.1-forge-47.0.35");
        assert!(candidates.iter().any(|item| item == "1.20.1-forge-47.0.35"));
    }

    #[test]
    fn omit_arg_drops_only_bare_unresolved_placeholders() {
        // Standalone unresolved template tokens are still dropped.
        assert!(should_omit_resolved_arg("${quickPlayRealms}"));
        assert!(should_omit_resolved_arg("  ${quickPlayPath}  "));
        assert!(should_omit_resolved_arg("${game_directory}"));
        assert!(should_omit_resolved_arg(""));
    }

    #[test]
    fn omit_arg_keeps_real_paths_and_joined_props() {
        // Real launch arguments must survive even when they contain `${`.
        assert!(!should_omit_resolved_arg(r"D:\games\mc${test}\.minecraft"));
        assert!(!should_omit_resolved_arg(
            r"-Djava.library.path=C:\Users\a${b}\natives"
        ));
        // A joined property with an unresolved value is passed through literally
        // rather than silently dropped (harmless, and never true for MC's own args).
        assert!(!should_omit_resolved_arg("-Dfoo=${bar}"));
        // Chinese / spaced paths were never at risk but are covered for regression.
        assert!(!should_omit_resolved_arg(
            r"C:\Users\张三\AppData\Roaming\FPSMaster"
        ));
        assert!(!should_omit_resolved_arg(
            r"C:\Program Files\Eclipse Adoptium"
        ));
    }
}
