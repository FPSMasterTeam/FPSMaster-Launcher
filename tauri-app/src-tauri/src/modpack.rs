//! Modpack installation for Modrinth (.mrpack) and CurseForge modpack archives.
//!
//! The install pipeline is split into explicit stages so every failure keeps its
//! stage context instead of surfacing as a generic (or misleading) error:
//!   catalog       -> resolve the pack version/file from the platform API
//!   download-pack -> fetch the pack archive itself
//!   parse         -> open the archive and read its index/manifest
//!   loader        -> install vanilla + Fabric/Forge and create the instance dir
//!   files         -> download the mods/resources listed by the pack
//!   overrides     -> extract the bundled overrides into the instance dir
//!   finalize      -> record instance metadata
//!
//! Error strings returned to the frontend carry a `[modpack:<stage>]` prefix so
//! the UI can render a stage-specific message (see Content.tsx).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::Emitter;

use crate::minecraft_core;

pub(crate) const MODPACK_PROGRESS_EVENT: &str = "modpack-install-progress";

const STAGE_CATALOG: &str = "catalog";
const STAGE_DOWNLOAD_PACK: &str = "download-pack";
const STAGE_PARSE: &str = "parse";
const STAGE_LOADER: &str = "loader";
const STAGE_FILES: &str = "files";
const STAGE_OVERRIDES: &str = "overrides";
const STAGE_FINALIZE: &str = "finalize";

/// CurseForge class id for modpacks (mods=6, resourcepacks=12, shaders=6552).
pub(crate) const CURSEFORGE_MODPACK_CLASS_ID: u64 = 4471;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ModpackInstallProgressEvent {
    #[serde(rename = "projectKey")]
    pub project_key: String,
    pub stage: String,
    pub message: String,
    pub current: u64,
    pub total: u64,
    pub percent: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ModpackInstallResult {
    pub source: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "projectTitle")]
    pub project_title: String,
    /// Display name for the created instance (pack name from the manifest).
    pub name: String,
    /// Version id of the created instance runtime dir under `versions/`.
    #[serde(rename = "versionId")]
    pub version_id: String,
    #[serde(rename = "baseVersion")]
    pub base_version: String,
    pub loader: String,
    #[serde(rename = "loaderVersion")]
    pub loader_version: Option<String>,
    #[serde(rename = "packVersion")]
    pub pack_version: String,
    #[serde(rename = "fileCount")]
    pub file_count: u64,
    #[serde(rename = "overrideCount")]
    pub override_count: u64,
}

fn stage_err(stage: &str, message: impl AsRef<str>) -> String {
    format!("[modpack:{stage}] {}", message.as_ref())
}

fn emit_modpack_progress(
    window: Option<&tauri::Window>,
    project_key: &str,
    stage: &str,
    message: &str,
    current: u64,
    total: u64,
) {
    let Some(target_window) = window else {
        return;
    };
    let percent = if total > 0 {
        u8::try_from(current.saturating_mul(100).min(total.saturating_mul(100)) / total).ok()
    } else {
        None
    };
    let _ = target_window.emit(
        MODPACK_PROGRESS_EVENT,
        ModpackInstallProgressEvent {
            project_key: project_key.to_string(),
            stage: stage.to_string(),
            message: message.to_string(),
            current,
            total,
            percent,
        },
    );
}

// ---------------------------------------------------------------------------
// Parsed pack model (shared between Modrinth and CurseForge)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ModpackLoaderRequirement {
    /// "vanilla" | "fabric" | "forge"
    pub loader: String,
    pub loader_version: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedModpack {
    pub name: String,
    pub pack_version: String,
    pub minecraft_version: String,
    pub loader: ModpackLoaderRequirement,
}

// ---------------------------------------------------------------------------
// Modrinth .mrpack index (modrinth.index.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct MrpackIndex {
    #[serde(rename = "formatVersion", default)]
    pub format_version: u32,
    #[serde(default)]
    pub game: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "versionId", default)]
    pub version_id: String,
    #[serde(default)]
    pub files: Vec<MrpackFileEntry>,
    #[serde(default)]
    pub dependencies: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct MrpackFileEntry {
    pub path: String,
    #[serde(default)]
    pub hashes: HashMap<String, String>,
    #[serde(default)]
    pub env: Option<MrpackFileEnv>,
    #[serde(default)]
    pub downloads: Vec<String>,
    #[serde(rename = "fileSize", default)]
    pub file_size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct MrpackFileEnv {
    #[serde(default)]
    pub client: Option<String>,
}

pub(crate) fn parse_mrpack_index(raw: &str) -> Result<MrpackIndex, String> {
    let index = serde_json::from_str::<MrpackIndex>(raw)
        .map_err(|e| format!("Invalid modrinth.index.json: {e}"))?;
    if index.format_version != 1 {
        return Err(format!(
            "Unsupported mrpack format version {}",
            index.format_version
        ));
    }
    if !index.game.trim().eq_ignore_ascii_case("minecraft") {
        return Err(format!(
            "Unsupported mrpack game '{}'; expected minecraft",
            index.game.trim()
        ));
    }
    if dependency_value(&index.dependencies, "minecraft")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err("modrinth.index.json is missing the required minecraft dependency".to_string());
    }
    Ok(index)
}

fn dependency_value<'a>(
    dependencies: &'a HashMap<String, String>,
    expected_key: &str,
) -> Option<&'a str> {
    dependencies
        .iter()
        .find(|(key, _)| key.trim().eq_ignore_ascii_case(expected_key))
        .map(|(_, value)| value.as_str())
}

pub(crate) fn resolve_mrpack_loader(
    dependencies: &HashMap<String, String>,
) -> Result<ModpackLoaderRequirement, String> {
    let normalized: HashMap<String, String> = dependencies
        .iter()
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    for unsupported in ["quilt-loader", "neoforge"] {
        if normalized.contains_key(unsupported) {
            let label = if unsupported == "quilt-loader" {
                "Quilt"
            } else {
                "NeoForge"
            };
            return Err(format!(
                "This modpack requires the {label} loader, which this launcher cannot install yet. \
                 Choose a Fabric or Forge modpack instead."
            ));
        }
    }
    if let Some(version) = normalized.get("fabric-loader") {
        return Ok(ModpackLoaderRequirement {
            loader: "fabric".to_string(),
            loader_version: Some(version.clone()).filter(|value| !value.is_empty()),
        });
    }
    if let Some(version) = normalized.get("forge") {
        return Ok(ModpackLoaderRequirement {
            loader: "forge".to_string(),
            loader_version: Some(version.clone()).filter(|value| !value.is_empty()),
        });
    }
    Ok(ModpackLoaderRequirement {
        loader: "vanilla".to_string(),
        loader_version: None,
    })
}

// ---------------------------------------------------------------------------
// CurseForge modpack manifest (manifest.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CurseForgeManifest {
    #[serde(rename = "manifestType", default)]
    pub manifest_type: String,
    #[serde(rename = "manifestVersion", default)]
    pub manifest_version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    pub minecraft: CurseForgeManifestMinecraft,
    #[serde(default)]
    pub files: Vec<CurseForgeManifestFile>,
    #[serde(default)]
    pub overrides: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CurseForgeManifestMinecraft {
    pub version: String,
    #[serde(rename = "modLoaders", default)]
    pub mod_loaders: Vec<CurseForgeManifestModLoader>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CurseForgeManifestModLoader {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CurseForgeManifestFile {
    #[serde(rename = "projectID")]
    pub project_id: u64,
    #[serde(rename = "fileID")]
    pub file_id: u64,
    #[serde(default = "default_true")]
    pub required: bool,
}

fn default_true() -> bool {
    true
}

pub(crate) fn parse_curseforge_manifest(raw: &str) -> Result<CurseForgeManifest, String> {
    let manifest = serde_json::from_str::<CurseForgeManifest>(raw)
        .map_err(|e| format!("Invalid CurseForge manifest.json: {e}"))?;
    if manifest.manifest_type.trim() != "minecraftModpack" {
        return Err(format!(
            "Unsupported CurseForge manifest type '{}'; expected minecraftModpack",
            manifest.manifest_type.trim()
        ));
    }
    if manifest.manifest_version != 1 {
        return Err(format!(
            "Unsupported CurseForge manifest version {}",
            manifest.manifest_version
        ));
    }
    if manifest.minecraft.version.trim().is_empty() {
        return Err("CurseForge manifest is missing the Minecraft version".to_string());
    }
    if manifest
        .files
        .iter()
        .any(|entry| entry.project_id == 0 || entry.file_id == 0)
    {
        return Err(
            "CurseForge manifest contains an invalid zero project ID or file ID".to_string(),
        );
    }
    Ok(manifest)
}

pub(crate) fn resolve_curseforge_manifest_loader(
    mod_loaders: &[CurseForgeManifestModLoader],
) -> Result<ModpackLoaderRequirement, String> {
    let selected = mod_loaders
        .iter()
        .find(|entry| entry.primary)
        .or_else(|| mod_loaders.first());
    let Some(entry) = selected else {
        return Ok(ModpackLoaderRequirement {
            loader: "vanilla".to_string(),
            loader_version: None,
        });
    };
    let raw = entry.id.trim();
    let (kind, version) = match raw.split_once('-') {
        Some((kind, version)) => (kind.trim().to_ascii_lowercase(), version.trim().to_string()),
        None => (raw.to_ascii_lowercase(), String::new()),
    };
    match kind.as_str() {
        "fabric" => Ok(ModpackLoaderRequirement {
            loader: "fabric".to_string(),
            loader_version: Some(version).filter(|value| !value.is_empty()),
        }),
        "forge" => Ok(ModpackLoaderRequirement {
            loader: "forge".to_string(),
            loader_version: Some(version).filter(|value| !value.is_empty()),
        }),
        "quilt" | "neoforge" => Err(format!(
            "This modpack requires the {} loader, which this launcher cannot install yet. \
             Choose a Fabric or Forge modpack instead.",
            if kind == "quilt" { "Quilt" } else { "NeoForge" }
        )),
        other => Err(format!(
            "This modpack requires an unknown mod loader '{other}'"
        )),
    }
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/// Normalize a pack-provided relative path and reject anything that could
/// escape the instance directory (absolute paths, drive prefixes, `..`).
pub(crate) fn safe_relative_path(raw: &str) -> Result<PathBuf, String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("Modpack file path cannot be empty".to_string());
    }
    if normalized.starts_with('/') {
        return Err(format!("Modpack file path must be relative: {normalized}"));
    }
    // Reject Windows drive/UNC prefixes explicitly; on non-Windows hosts
    // `C:` would otherwise parse as a Normal component.
    if normalized.contains(':') {
        return Err(format!(
            "Modpack file path contains an invalid character: {normalized}"
        ));
    }
    let candidate = PathBuf::from(&normalized);
    let mut relative = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "Modpack file path attempts to escape the instance directory: {normalized}"
                ));
            }
        }
    }
    if relative.as_os_str().is_empty() {
        return Err(format!("Modpack file path is empty after normalizing: {normalized}"));
    }
    Ok(relative)
}

/// Join a pack-relative path onto the instance root, guaranteeing the result
/// stays inside the root.
pub(crate) fn safe_join(instance_root: &Path, raw: &str) -> Result<PathBuf, String> {
    let relative = safe_relative_path(raw)?;
    let joined = instance_root.join(&relative);
    if !joined.starts_with(instance_root) {
        return Err(format!(
            "Modpack file path resolves outside the instance directory: {raw}"
        ));
    }
    Ok(joined)
}

// ---------------------------------------------------------------------------
// Overrides extraction
// ---------------------------------------------------------------------------

/// Extract every archive entry under `prefix/` into the instance root.
/// Returns the number of files written. Entries with unsafe paths are
/// rejected (zip-slip protection).
pub(crate) fn extract_override_entries<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    prefix: &str,
    instance_root: &Path,
) -> Result<u64, String> {
    let normalized_prefix = format!("{}/", prefix.trim_end_matches('/'));
    let mut written = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read modpack archive entry: {e}"))?;
        let raw_name = entry.name().replace('\\', "/");
        if !raw_name.starts_with(&normalized_prefix) {
            continue;
        }
        let relative_raw = &raw_name[normalized_prefix.len()..];
        if relative_raw.is_empty() {
            continue;
        }
        if entry.is_dir() {
            let dir_path = safe_join(instance_root, relative_raw)?;
            fs::create_dir_all(&dir_path).map_err(|e| {
                format!("Failed to create override directory {}: {e}", dir_path.display())
            })?;
            continue;
        }
        let out_path = safe_join(instance_root, relative_raw)?;
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("Failed to create override directory {}: {e}", parent.display())
            })?;
        }
        let mut output = fs::File::create(&out_path)
            .map_err(|e| format!("Failed to create override file {}: {e}", out_path.display()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|e| format!("Failed to extract override file {}: {e}", out_path.display()))?;
        output
            .flush()
            .map_err(|e| format!("Failed to flush override file {}: {e}", out_path.display()))?;
        written += 1;
    }
    Ok(written)
}

fn read_archive_text_entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
) -> Result<Option<String>, String> {
    let mut entry = match archive.by_name(entry_name) {
        Ok(value) => value,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(err) => {
            return Err(format!(
                "Failed to open modpack archive entry {entry_name}: {err}"
            ))
        }
    };
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|e| format!("Failed to read modpack archive entry {entry_name}: {e}"))?;
    Ok(Some(text))
}

// ---------------------------------------------------------------------------
// Catalog resolution
// ---------------------------------------------------------------------------

struct ResolvedPackDownload {
    url: String,
    file_name: String,
    pack_version: String,
    sha512: Option<String>,
    sha1: Option<String>,
    size: Option<u64>,
}

fn resolve_modrinth_pack_download(
    client: &reqwest::blocking::Client,
    project_id: &str,
) -> Result<ResolvedPackDownload, String> {
    let url = format!("https://api.modrinth.com/v2/project/{project_id}/version");
    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("Modrinth modpack catalog request failed: {}", crate::describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Modrinth modpack catalog response: {e}"))?;
    if status.as_u16() == 404 {
        return Err(format!(
            "Modrinth modpack project '{project_id}' was not found in the catalog (HTTP 404)"
        ));
    }
    if !status.is_success() {
        return Err(format!(
            "Modrinth modpack catalog lookup failed with HTTP {}: {}",
            status.as_u16(),
            text.trim()
        ));
    }
    let versions = serde_json::from_str::<Vec<crate::ModrinthProjectVersion>>(&text)
        .map_err(|e| format!("Invalid Modrinth modpack catalog JSON: {e}"))?;
    let version = crate::choose_best_modrinth_version(versions)
        .map_err(|_| "This Modrinth project has no downloadable modpack versions".to_string())?;
    let file = version
        .files
        .iter()
        .find(|file| file.primary && file.filename.to_ascii_lowercase().ends_with(".mrpack"))
        .or_else(|| {
            version
                .files
                .iter()
                .find(|file| file.filename.to_ascii_lowercase().ends_with(".mrpack"))
        })
        .cloned()
        .ok_or_else(|| {
            format!(
                "Modrinth modpack version {} does not contain a downloadable .mrpack file",
                version.id
            )
        })?;
    let pack_version = if version.version_number.trim().is_empty() {
        version.name.clone()
    } else {
        version.version_number.clone()
    };
    Ok(ResolvedPackDownload {
        url: file.url.clone(),
        file_name: file.filename.clone(),
        pack_version,
        sha512: file.hashes.get("sha512").cloned(),
        sha1: file.hashes.get("sha1").cloned(),
        size: file.size,
    })
}

#[derive(Debug, Clone, Deserialize)]
struct CurseForgePackFileRow {
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
    #[serde(rename = "isServerPack", default)]
    is_server_pack: bool,
    #[serde(default)]
    hashes: Vec<CurseForgeFileHash>,
    #[serde(rename = "fileLength", default)]
    file_length: Option<u64>,
}

fn resolve_curseforge_pack_download(
    client: &reqwest::blocking::Client,
    api_key: &str,
    project_id: &str,
) -> Result<ResolvedPackDownload, String> {
    let url = format!("https://api.curseforge.com/v1/mods/{project_id}/files?pageSize=50");
    let response = client
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .map_err(|e| format!("CurseForge modpack catalog request failed: {}", crate::describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read CurseForge modpack catalog response: {e}"))?;
    if status.as_u16() == 404 {
        return Err(format!(
            "CurseForge modpack project '{project_id}' was not found in the catalog (HTTP 404)"
        ));
    }
    if !status.is_success() {
        return Err(format!(
            "CurseForge modpack catalog lookup failed with HTTP {}: {}",
            status.as_u16(),
            text.trim()
        ));
    }
    let payload =
        serde_json::from_str::<crate::CurseForgeEnvelope<Vec<CurseForgePackFileRow>>>(&text)
            .map_err(|e| format!("Invalid CurseForge modpack catalog JSON: {e}"))?;
    let mut files: Vec<CurseForgePackFileRow> = payload
        .data
        .into_iter()
        .filter(|row| {
            !row.is_server_pack && row.file_name.to_ascii_lowercase().ends_with(".zip")
        })
        .collect();
    if files.is_empty() {
        return Err(
            "This CurseForge project has no downloadable client modpack ZIP files".to_string(),
        );
    }
    files.sort_by(|left, right| {
        let rank = |row: &CurseForgePackFileRow| {
            let release_rank = match row.release_type.unwrap_or(3) {
                1 => 3,
                2 => 2,
                3 => 1,
                _ => 0,
            };
            (release_rank, row.file_date.clone().unwrap_or_default())
        };
        rank(right).cmp(&rank(left))
    });
    let file = files.remove(0);
    let download_url = match file
        .download_url
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => crate::fetch_curseforge_file_download_url(client, api_key, project_id, file.id)
            .map_err(|err| {
                if is_curseforge_distribution_blocked_error(&err) {
                    format!(
                        "CurseForge modpack archive '{}' cannot be downloaded because \
                         third-party distribution is disabled",
                        file.file_name
                    )
                } else {
                    format!(
                        "Failed to resolve the CurseForge modpack archive download URL: {err}"
                    )
                }
            })?,
    };
    let pack_version = if file.display_name.trim().is_empty() {
        file.file_name.clone()
    } else {
        file.display_name.clone()
    };
    Ok(ResolvedPackDownload {
        url: download_url,
        file_name: file.file_name.clone(),
        pack_version,
        sha512: None,
        sha1: file
            .hashes
            .iter()
            .find(|hash| hash.algo == 1)
            .map(|hash| hash.value.clone()),
        size: file.file_length,
    })
}

fn is_curseforge_distribution_blocked_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("http 403") || normalized.contains("distribution disabled")
}

// ---------------------------------------------------------------------------
// CurseForge file id resolution (manifest -> download URLs)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct CurseForgeBatchFile {
    id: u64,
    #[serde(rename = "modId")]
    mod_id: u64,
    #[serde(rename = "fileName", default)]
    file_name: String,
    #[serde(rename = "downloadUrl", default)]
    download_url: Option<String>,
    #[serde(default)]
    hashes: Vec<CurseForgeFileHash>,
    #[serde(rename = "fileLength", default)]
    file_length: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseForgeFileHash {
    value: String,
    /// 1 = SHA1, 2 = MD5
    algo: u32,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseForgeBatchMod {
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(rename = "classId", default)]
    class_id: Option<u64>,
}

fn curseforge_post_json(
    client: &reqwest::blocking::Client,
    api_key: &str,
    url: &str,
    body: serde_json::Value,
    label: &str,
) -> Result<String, String> {
    let response = client
        .post(url)
        .header("x-api-key", api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .map_err(|e| format!("CurseForge {label} request failed: {}", crate::describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read CurseForge {label} response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "CurseForge {label} lookup failed with HTTP {}: {}",
            status.as_u16(),
            text.trim()
        ));
    }
    Ok(text)
}

fn fetch_curseforge_files_batch(
    client: &reqwest::blocking::Client,
    api_key: &str,
    file_ids: &[u64],
) -> Result<Vec<CurseForgeBatchFile>, String> {
    let mut rows = Vec::with_capacity(file_ids.len());
    for chunk in file_ids.chunks(50) {
        let text = curseforge_post_json(
            client,
            api_key,
            "https://api.curseforge.com/v1/mods/files",
            serde_json::json!({ "fileIds": chunk }),
            "modpack files",
        )?;
        let payload =
            serde_json::from_str::<crate::CurseForgeEnvelope<Vec<CurseForgeBatchFile>>>(&text)
                .map_err(|e| format!("Invalid CurseForge modpack files JSON: {e}"))?;
        rows.extend(payload.data);
    }
    Ok(rows)
}

fn fetch_curseforge_mods_batch(
    client: &reqwest::blocking::Client,
    api_key: &str,
    mod_ids: &[u64],
) -> Result<Vec<CurseForgeBatchMod>, String> {
    let mut rows = Vec::with_capacity(mod_ids.len());
    for chunk in mod_ids.chunks(50) {
        let text = curseforge_post_json(
            client,
            api_key,
            "https://api.curseforge.com/v1/mods",
            serde_json::json!({ "modIds": chunk }),
            "modpack projects",
        )?;
        let payload =
            serde_json::from_str::<crate::CurseForgeEnvelope<Vec<CurseForgeBatchMod>>>(&text)
                .map_err(|e| format!("Invalid CurseForge modpack projects JSON: {e}"))?;
        rows.extend(payload.data);
    }
    Ok(rows)
}

/// Content subdirectory for a CurseForge class id. Everything unknown lands in
/// `mods/`, matching how packs overwhelmingly reference plain mods.
pub(crate) fn curseforge_class_target_dir(class_id: Option<u64>) -> &'static str {
    match class_id {
        Some(12) => "resourcepacks",
        Some(6552) => "shaderpacks",
        _ => "mods",
    }
}

// ---------------------------------------------------------------------------
// Download jobs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ModpackFileJob {
    /// Path relative to the instance root ("mods/foo.jar").
    relative_path: String,
    /// Candidate URLs, tried in order.
    urls: Vec<String>,
    sha512: Option<String>,
    sha1: Option<String>,
    size: Option<u64>,
}

fn download_modpack_files(
    window: Option<&tauri::Window>,
    project_key: &str,
    instance_root: &Path,
    jobs: Vec<ModpackFileJob>,
    download_threads: usize,
) -> Result<u64, String> {
    let total = jobs.len() as u64;
    if total == 0 {
        return Ok(0);
    }
    emit_modpack_progress(
        window,
        project_key,
        STAGE_FILES,
        &format!("Downloading {total} modpack files"),
        0,
        total,
    );

    let queue = Arc::new(Mutex::new(VecDeque::from(jobs)));
    let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let completed = Arc::new(AtomicU64::new(0));
    let worker_count = download_threads.clamp(1, 8).min(total as usize);
    let mut workers = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let queue = Arc::clone(&queue);
        let failure = Arc::clone(&failure);
        let completed = Arc::clone(&completed);
        let window = window.cloned();
        let project_key = project_key.to_string();
        let instance_root = instance_root.to_path_buf();
        workers.push(thread::spawn(move || {
            let client = match crate::build_blocking_http_client() {
                Ok(value) => value,
                Err(err) => {
                    let mut slot = crate::minecraft_core::lock_recover(&failure);
                    if slot.is_none() {
                        *slot = Some(err);
                    }
                    return;
                }
            };
            loop {
                if crate::minecraft_core::lock_recover(&failure).is_some() {
                    return;
                }
                let job = {
                    let mut guard = crate::minecraft_core::lock_recover(&queue);
                    guard.pop_front()
                };
                let Some(job) = job else {
                    return;
                };
                if let Err(err) = download_single_modpack_file(&client, &instance_root, &job) {
                    let mut slot = crate::minecraft_core::lock_recover(&failure);
                    if slot.is_none() {
                        *slot = Some(err);
                    }
                    return;
                }
                let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                emit_modpack_progress(
                    window.as_ref(),
                    &project_key,
                    STAGE_FILES,
                    &format!("Downloaded {done}/{total} modpack files"),
                    done,
                    total,
                );
                crate::emit_content_install_progress(window.as_ref(), &project_key, done, Some(total));
            }
        }));
    }
    for worker in workers {
        if worker.join().is_err() {
            let mut slot = crate::minecraft_core::lock_recover(&failure);
            if slot.is_none() {
                *slot = Some("A modpack download worker stopped unexpectedly".to_string());
            }
        }
    }
    if let Some(err) = crate::minecraft_core::lock_recover(&failure).clone() {
        return Err(err);
    }
    let completed_count = completed.load(Ordering::SeqCst);
    if completed_count != total {
        return Err(format!(
            "Modpack file download ended early: completed {completed_count} of {total} files"
        ));
    }
    Ok(total)
}

fn download_single_modpack_file(
    client: &reqwest::blocking::Client,
    instance_root: &Path,
    job: &ModpackFileJob,
) -> Result<(), String> {
    let target = safe_join(instance_root, &job.relative_path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }

    // Skip files that already exist with a matching checksum (idempotent
    // reinstall). Files without any verifier are always re-downloaded.
    let has_verifier = job.sha512.is_some() || job.sha1.is_some() || job.size.is_some();
    if has_verifier && target.is_file() && verify_job_checksums(&target, job).is_ok() {
        return Ok(());
    }

    let mut last_error = format!(
        "No download URL available for modpack file {}",
        job.relative_path
    );
    for url in &job.urls {
        match crate::download_file_with_progress_callback_blocking(client, url, &target, |_, _| {}) {
            Ok(()) => match verify_job_checksums(&target, job) {
                Ok(()) => return Ok(()),
                Err(err) => {
                    let _ = fs::remove_file(&target);
                    last_error = format!(
                        "Checksum mismatch for modpack file {}: {err}",
                        job.relative_path
                    );
                }
            },
            Err(err) => {
                last_error = format!(
                    "Failed to download modpack file {}: {err}",
                    job.relative_path
                );
            }
        }
    }
    Err(last_error)
}

fn verify_job_checksums(path: &Path, job: &ModpackFileJob) -> Result<(), String> {
    if let Some(expected_size) = job.size {
        let actual = fs::metadata(path)
            .map_err(|e| format!("Failed to inspect file: {e}"))?
            .len();
        if actual != expected_size {
            return Err(format!("size mismatch: expected {expected_size}, got {actual}"));
        }
    }
    if let Some(expected) = job.sha512.as_deref() {
        crate::verify_file_sha512(path, expected)?;
    }
    if let Some(expected) = job.sha1.as_deref() {
        let actual = crate::compute_sha1_hex(path)?;
        if !actual.eq_ignore_ascii_case(expected.trim()) {
            return Err(format!("sha1 mismatch: expected {expected}, got {actual}"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Instance creation
// ---------------------------------------------------------------------------

struct IncompleteInstanceGuard {
    root: PathBuf,
    committed: bool,
}

impl IncompleteInstanceGuard {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for IncompleteInstanceGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

fn allocate_instance_version_id(versions_dir: &Path, desired: &str) -> Result<String, String> {
    let base = crate::normalize_version_identifier(desired)
        .or_else(|_| crate::normalize_version_identifier("modpack"))?;
    let mut candidate = base.clone();
    let mut suffix = 2u32;
    while versions_dir.join(&candidate).exists() {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
        if suffix > 500 {
            return Err(format!(
                "Could not allocate a unique instance id for modpack '{desired}'"
            ));
        }
    }
    Ok(candidate)
}

/// Install vanilla + the required loader. Returns the loader profile version
/// id (the copy source for the instance dir) and the resolved loader version.
fn install_loader_profile(
    window: &tauri::Window,
    game_dir: &Path,
    minecraft_version: &str,
    loader: &ModpackLoaderRequirement,
    download_source: Option<&str>,
    download_threads: usize,
) -> Result<(String, Option<String>), String> {
    minecraft_core::install_vanilla(
        Some(window),
        game_dir,
        minecraft_version,
        download_source,
        download_threads,
        None,
    )?;

    let mut resolved_loader_version = loader.loader_version.clone();
    let source_version_id = match loader.loader.as_str() {
        "fabric" => {
            // An empty requested version makes the core installer resolve the
            // newest loader release for this Minecraft version.
            let fabric = minecraft_core::install_fabric(
                Some(window),
                game_dir,
                minecraft_version,
                resolved_loader_version.as_deref().unwrap_or(""),
                download_source,
                download_threads,
                None,
            )?;
            resolved_loader_version = fabric.loader_version.clone();
            fabric.profile_id
        }
        "forge" => {
            let forge_version = loader
                .loader_version
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    "The modpack manifest does not specify a Forge version".to_string()
                })?;
            // Forge versions are addressed as "<mc>-<forge>" by the installer.
            let full_forge_version = if forge_version
                .strip_prefix(minecraft_version)
                .is_some_and(|suffix| suffix.starts_with('-'))
            {
                forge_version.to_string()
            } else {
                format!("{minecraft_version}-{forge_version}")
            };
            let jdk = crate::ensure_jdk_blocking(
                window.clone(),
                game_dir.to_string_lossy().to_string(),
                minecraft_version.to_string(),
                Some(download_threads as i32),
            )?;
            let forge = crate::install_forge_blocking_core(
                Some(window),
                game_dir,
                &full_forge_version,
                &jdk.java_path,
                download_source,
                Some(download_threads as i32),
            )?;
            resolved_loader_version = Some(forge.forge_version.clone());
            forge.profile_id
        }
        _ => minecraft_version.to_string(),
    };

    let versions_dir = game_dir.join("versions");
    let source_dir = versions_dir.join(&source_version_id);
    let source_json = source_dir.join(format!("{source_version_id}.json"));
    if !source_dir.exists() || !source_json.exists() {
        return Err(format!(
            "Loader profile files are missing after install: {}",
            source_dir.display()
        ));
    }
    Ok((source_version_id, resolved_loader_version))
}

/// Copy the freshly installed loader profile into a dedicated instance
/// directory. Only the version profile artifacts belong to the new instance:
/// copying the whole source directory would also copy an existing instance's
/// mods, saves, config, and other runtime state. The shared loader/vanilla
/// profile stays in place so other instances can still reference it.
fn create_instance_from_profile(
    versions_dir: &Path,
    source_version_id: &str,
    instance_id: &str,
) -> Result<(), String> {
    let source_dir = versions_dir.join(source_version_id);
    let target_dir = versions_dir.join(instance_id);
    fs::create_dir_all(&target_dir).map_err(|e| {
        format!(
            "Failed to create modpack instance directory {}: {e}",
            target_dir.display()
        )
    })?;
    let source_json = source_dir.join(format!("{source_version_id}.json"));
    let staged_json = target_dir.join(format!("{source_version_id}.json"));
    fs::copy(&source_json, &staged_json).map_err(|e| {
        format!(
            "Failed to copy loader profile from {} to {}: {e}",
            source_json.display(),
            staged_json.display()
        )
    })?;
    let source_jar = source_dir.join(format!("{source_version_id}.jar"));
    if source_jar.is_file() {
        let staged_jar = target_dir.join(format!("{source_version_id}.jar"));
        fs::copy(&source_jar, &staged_jar).map_err(|e| {
            format!(
                "Failed to copy loader runtime from {} to {}: {e}",
                source_jar.display(),
                staged_jar.display()
            )
        })?;
    }
    crate::retarget_version_runtime(&target_dir, source_version_id, instance_id)
}

// ---------------------------------------------------------------------------
// Install entry point
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub(crate) fn install_modpack_blocking(
    window: tauri::Window,
    game_dir: String,
    source: String,
    project_id: String,
    project_title: String,
    api_key: Option<String>,
    download_source: Option<String>,
    download_threads: Option<i32>,
) -> Result<ModpackInstallResult, String> {
    let normalized_source = source.trim().to_ascii_lowercase();
    if normalized_source != "modrinth" && normalized_source != "curseforge" {
        return Err(stage_err(
            STAGE_CATALOG,
            format!("Unsupported modpack source '{normalized_source}'. Expected modrinth/curseforge"),
        ));
    }
    let normalized_project_id = project_id.trim().to_string();
    if normalized_project_id.is_empty() {
        return Err(stage_err(STAGE_CATALOG, "Modpack project id cannot be empty"));
    }
    let normalized_title = project_title.trim().to_string();
    let project_key = format!("{normalized_source}:modpack:{normalized_project_id}");
    let normalized_download_threads = crate::normalize_download_threads(download_threads);

    let game_dir_path =
        crate::resolve_game_dir_path(&game_dir).map_err(|err| stage_err(STAGE_FINALIZE, err))?;
    let client =
        crate::build_blocking_http_client().map_err(|err| stage_err(STAGE_CATALOG, err))?;

    // Stage: catalog ---------------------------------------------------------
    emit_modpack_progress(
        Some(&window),
        &project_key,
        STAGE_CATALOG,
        "Resolving modpack version from catalog",
        0,
        0,
    );
    let resolved_api_key = if normalized_source == "curseforge" {
        Some(
            crate::normalize_curseforge_api_key(api_key.as_deref().unwrap_or(""))
                .map_err(|err| stage_err(STAGE_CATALOG, err))?,
        )
    } else {
        None
    };
    let pack_download = match normalized_source.as_str() {
        "modrinth" => resolve_modrinth_pack_download(&client, &normalized_project_id),
        _ => resolve_curseforge_pack_download(
            &client,
            resolved_api_key.as_deref().unwrap_or(""),
            &normalized_project_id,
        ),
    }
    .map_err(|err| stage_err(STAGE_CATALOG, err))?;

    // Stage: download-pack ---------------------------------------------------
    emit_modpack_progress(
        Some(&window),
        &project_key,
        STAGE_DOWNLOAD_PACK,
        &format!("Downloading modpack archive {}", pack_download.file_name),
        0,
        0,
    );
    let archive_path = std::env::temp_dir().join(format!(
        "fpsmaster-modpack-{}-{}-{}",
        std::process::id(),
        crate::now_epoch_millis(),
        crate::sanitize_file_name(&pack_download.file_name)
    ));
    {
        let window_ref = &window;
        let key_ref = project_key.as_str();
        crate::download_file_with_progress_callback_blocking(
            &client,
            &pack_download.url,
            &archive_path,
            |downloaded, total| {
                crate::emit_content_install_progress(Some(window_ref), key_ref, downloaded, total);
                emit_modpack_progress(
                    Some(window_ref),
                    key_ref,
                    STAGE_DOWNLOAD_PACK,
                    "Downloading modpack archive",
                    downloaded,
                    total.unwrap_or(0),
                );
            },
        )
        .map_err(|err| {
            stage_err(
                STAGE_DOWNLOAD_PACK,
                format!(
                    "Failed to download modpack archive {}: {err}",
                    pack_download.file_name
                ),
            )
        })?;
    }
    let cleanup_archive = || {
        let _ = fs::remove_file(&archive_path);
    };
    if let Some(expected) = pack_download.sha512.as_deref() {
        if let Err(err) = crate::verify_file_sha512(&archive_path, expected) {
            cleanup_archive();
            return Err(stage_err(
                STAGE_DOWNLOAD_PACK,
                format!("Modpack archive checksum mismatch: {err}"),
            ));
        }
    }
    if let Some(expected) = pack_download.sha1.as_deref() {
        match crate::compute_sha1_hex(&archive_path) {
            Ok(actual) if actual.eq_ignore_ascii_case(expected.trim()) => {}
            Ok(actual) => {
                cleanup_archive();
                return Err(stage_err(
                    STAGE_DOWNLOAD_PACK,
                    format!("Modpack archive checksum mismatch: expected {expected}, got {actual}"),
                ));
            }
            Err(err) => {
                cleanup_archive();
                return Err(stage_err(STAGE_DOWNLOAD_PACK, err));
            }
        }
    }
    if let Some(expected_size) = pack_download.size {
        let actual = fs::metadata(&archive_path).map(|meta| meta.len()).unwrap_or(0);
        if actual != expected_size {
            cleanup_archive();
            return Err(stage_err(
                STAGE_DOWNLOAD_PACK,
                format!("Modpack archive size mismatch: expected {expected_size}, got {actual}"),
            ));
        }
    }

    // Stage: parse ------------------------------------------------------------
    emit_modpack_progress(
        Some(&window),
        &project_key,
        STAGE_PARSE,
        "Reading modpack manifest",
        0,
        0,
    );
    let archive_file = fs::File::open(&archive_path).map_err(|e| {
        cleanup_archive();
        stage_err(STAGE_PARSE, format!("Failed to open modpack archive: {e}"))
    })?;
    let mut archive = zip::ZipArchive::new(archive_file).map_err(|e| {
        cleanup_archive();
        stage_err(STAGE_PARSE, format!("Modpack archive is not a valid ZIP: {e}"))
    })?;

    enum PackKind {
        Mrpack(MrpackIndex),
        CurseForge(CurseForgeManifest),
    }

    let pack_kind = (|| -> Result<PackKind, String> {
        if normalized_source == "modrinth" {
            let raw = read_archive_text_entry(&mut archive, "modrinth.index.json")?.ok_or_else(
                || {
                    "The Modrinth archive is missing modrinth.index.json; \
                     it is not a supported mrpack"
                        .to_string()
                },
            )?;
            return Ok(PackKind::Mrpack(parse_mrpack_index(&raw)?));
        }
        let raw = read_archive_text_entry(&mut archive, "manifest.json")?.ok_or_else(|| {
            "The CurseForge archive is missing manifest.json; \
             it is not a supported CurseForge modpack"
                .to_string()
        })?;
        Ok(PackKind::CurseForge(parse_curseforge_manifest(&raw)?))
    })()
    .map_err(|err| {
        cleanup_archive();
        stage_err(STAGE_PARSE, err)
    })?;

    let parsed = match &pack_kind {
        PackKind::Mrpack(index) => {
            let loader = resolve_mrpack_loader(&index.dependencies).map_err(|err| {
                cleanup_archive();
                stage_err(STAGE_PARSE, err)
            })?;
            ParsedModpack {
                name: if index.name.trim().is_empty() {
                    normalized_title.clone()
                } else {
                    index.name.trim().to_string()
                },
                pack_version: if index.version_id.trim().is_empty() {
                    pack_download.pack_version.clone()
                } else {
                    index.version_id.trim().to_string()
                },
                minecraft_version: dependency_value(&index.dependencies, "minecraft")
                    .map(|value| value.trim().to_string())
                    .unwrap_or_default(),
                loader,
            }
        }
        PackKind::CurseForge(manifest) => {
            let loader = resolve_curseforge_manifest_loader(&manifest.minecraft.mod_loaders)
                .map_err(|err| {
                    cleanup_archive();
                    stage_err(STAGE_PARSE, err)
                })?;
            ParsedModpack {
                name: if manifest.name.trim().is_empty() {
                    normalized_title.clone()
                } else {
                    manifest.name.trim().to_string()
                },
                pack_version: if manifest.version.trim().is_empty() {
                    pack_download.pack_version.clone()
                } else {
                    manifest.version.trim().to_string()
                },
                minecraft_version: manifest.minecraft.version.trim().to_string(),
                loader,
            }
        }
    };
    if parsed.minecraft_version.is_empty() {
        cleanup_archive();
        return Err(stage_err(
            STAGE_PARSE,
            "Modpack manifest does not declare a Minecraft version",
        ));
    }
    crate::emit_log(
        Some(&window),
        "info",
        &format!(
            "Modpack manifest parsed name={} mc={} loader={} loaderVersion={}",
            parsed.name,
            parsed.minecraft_version,
            parsed.loader.loader,
            parsed.loader.loader_version.as_deref().unwrap_or("auto")
        ),
    );

    // Stage: loader -----------------------------------------------------------
    emit_modpack_progress(
        Some(&window),
        &project_key,
        STAGE_LOADER,
        &format!(
            "Installing Minecraft {} with {} loader",
            parsed.minecraft_version, parsed.loader.loader
        ),
        0,
        0,
    );
    let versions_dir = game_dir_path.join("versions");
    fs::create_dir_all(&versions_dir).map_err(|e| {
        cleanup_archive();
        stage_err(
            STAGE_LOADER,
            format!("Failed to create versions directory {}: {e}", versions_dir.display()),
        )
    })?;
    let (source_version_id, resolved_loader_version) = install_loader_profile(
        &window,
        &game_dir_path,
        &parsed.minecraft_version,
        &parsed.loader,
        download_source.as_deref(),
        normalized_download_threads,
    )
    .map_err(|err| {
        cleanup_archive();
        stage_err(STAGE_LOADER, err)
    })?;
    // Allocate the instance id only after the loader install so a pack whose
    // name collides with a freshly created profile id gets a unique suffix.
    let instance_id = allocate_instance_version_id(&versions_dir, &parsed.name).map_err(|err| {
        cleanup_archive();
        stage_err(STAGE_LOADER, err)
    })?;
    let instance_root = versions_dir.join(&instance_id);
    let mut instance_guard = IncompleteInstanceGuard::new(instance_root.clone());
    create_instance_from_profile(&versions_dir, &source_version_id, &instance_id).map_err(
        |err| {
            cleanup_archive();
            stage_err(STAGE_LOADER, err)
        },
    )?;

    // Stage: files ------------------------------------------------------------
    let jobs = match &pack_kind {
        PackKind::Mrpack(index) => build_mrpack_jobs(index).map_err(|err| {
            cleanup_archive();
            stage_err(STAGE_FILES, err)
        })?,
        PackKind::CurseForge(manifest) => build_curseforge_jobs(
            &client,
            resolved_api_key.as_deref().unwrap_or(""),
            manifest,
        )
        .map_err(|err| {
            cleanup_archive();
            stage_err(STAGE_FILES, err)
        })?,
    };
    let file_count = download_modpack_files(
        Some(&window),
        &project_key,
        &instance_root,
        jobs,
        normalized_download_threads,
    )
    .map_err(|err| {
        cleanup_archive();
        stage_err(STAGE_FILES, err)
    })?;

    // Stage: overrides ----------------------------------------------------------
    emit_modpack_progress(
        Some(&window),
        &project_key,
        STAGE_OVERRIDES,
        "Applying modpack overrides",
        0,
        0,
    );
    let override_count = (|| -> Result<u64, String> {
        match &pack_kind {
            PackKind::Mrpack(_) => {
                // Client overrides take precedence over shared overrides, so
                // they are extracted last.
                let mut count = extract_override_entries(&mut archive, "overrides", &instance_root)?;
                count +=
                    extract_override_entries(&mut archive, "client-overrides", &instance_root)?;
                Ok(count)
            }
            PackKind::CurseForge(manifest) => {
                let prefix = manifest
                    .overrides
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("overrides");
                extract_override_entries(&mut archive, prefix, &instance_root)
            }
        }
    })()
    .map_err(|err| {
        cleanup_archive();
        stage_err(STAGE_OVERRIDES, err)
    })?;
    drop(archive);
    cleanup_archive();

    // Stage: finalize -----------------------------------------------------------
    emit_modpack_progress(
        Some(&window),
        &project_key,
        STAGE_FINALIZE,
        "Recording instance metadata",
        0,
        0,
    );
    let metadata = serde_json::json!({
        "source": normalized_source,
        "projectId": normalized_project_id,
        "projectTitle": if normalized_title.is_empty() { parsed.name.clone() } else { normalized_title.clone() },
        "packVersion": parsed.pack_version,
        "minecraftVersion": parsed.minecraft_version,
        "loader": parsed.loader.loader,
        "loaderVersion": resolved_loader_version,
        "installedAtEpochMillis": crate::now_epoch_millis().to_string(),
    });
    let metadata_path = instance_root.join(".fpsmaster-modpack.json");
    fs::write(
        &metadata_path,
        serde_json::to_string_pretty(&metadata).unwrap_or_else(|_| "{}".to_string()),
    )
    .map_err(|e| {
        stage_err(
            STAGE_FINALIZE,
            format!("Failed to write modpack metadata {}: {e}", metadata_path.display()),
        )
    })?;
    instance_guard.commit();

    emit_modpack_progress(
        Some(&window),
        &project_key,
        STAGE_FINALIZE,
        "Modpack installed",
        1,
        1,
    );
    crate::emit_log(
        Some(&window),
        "info",
        &format!(
            "Modpack installed instance={} files={} overrides={}",
            instance_id, file_count, override_count
        ),
    );

    Ok(ModpackInstallResult {
        source: normalized_source,
        project_id: normalized_project_id,
        project_title: if normalized_title.is_empty() {
            parsed.name.clone()
        } else {
            normalized_title
        },
        name: parsed.name,
        version_id: instance_id,
        base_version: parsed.minecraft_version,
        loader: parsed.loader.loader,
        loader_version: resolved_loader_version,
        pack_version: parsed.pack_version,
        file_count,
        override_count,
    })
}

fn required_mrpack_hash(
    entry: &MrpackFileEntry,
    algorithm: &str,
    expected_length: usize,
) -> Result<String, String> {
    let value = entry
        .hashes
        .iter()
        .find(|(key, _)| key.trim().eq_ignore_ascii_case(algorithm))
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "Modpack index entry {} is missing its required {algorithm} hash",
                entry.path
            )
        })?;
    if value.len() != expected_length || !value.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(format!(
            "Modpack index entry {} has an invalid {algorithm} hash",
            entry.path
        ));
    }
    Ok(value.to_ascii_lowercase())
}

fn build_mrpack_jobs(index: &MrpackIndex) -> Result<Vec<ModpackFileJob>, String> {
    let mut jobs = Vec::new();
    let mut target_paths = HashSet::new();
    for entry in &index.files {
        let client_env = entry
            .env
            .as_ref()
            .and_then(|env| env.client.as_deref())
            .map(|value| value.trim().to_ascii_lowercase());
        if client_env.as_deref() == Some("unsupported") {
            continue;
        }
        // Validate the path up front so a malicious index fails before any download.
        let target_path = safe_relative_path(&entry.path)?;
        if !target_paths.insert(target_path) {
            return Err(format!(
                "Modpack index contains duplicate target path {}",
                entry.path
            ));
        }
        let sha512 = required_mrpack_hash(entry, "sha512", 128)?;
        let sha1 = required_mrpack_hash(entry, "sha1", 40)?;
        let file_size = entry.file_size.ok_or_else(|| {
            format!(
                "Modpack index entry {} is missing its required fileSize",
                entry.path
            )
        })?;
        if entry.downloads.is_empty() {
            return Err(format!(
                "Modpack index entry {} has no download URLs",
                entry.path
            ));
        }
        for url in &entry.downloads {
            let parsed = reqwest::Url::parse(url)
                .map_err(|e| format!("Modpack index entry {} has an invalid URL: {e}", entry.path))?;
            if parsed.scheme() != "https" && parsed.scheme() != "http" {
                return Err(format!(
                    "Modpack index entry {} uses an unsupported URL scheme '{}'",
                    entry.path,
                    parsed.scheme()
                ));
            }
        }
        jobs.push(ModpackFileJob {
            relative_path: entry.path.clone(),
            urls: entry.downloads.clone(),
            sha512: Some(sha512),
            sha1: Some(sha1),
            size: Some(file_size),
        });
    }
    Ok(jobs)
}

fn build_curseforge_jobs(
    client: &reqwest::blocking::Client,
    api_key: &str,
    manifest: &CurseForgeManifest,
) -> Result<Vec<ModpackFileJob>, String> {
    if manifest.files.is_empty() {
        return Ok(Vec::new());
    }
    let file_ids: Vec<u64> = manifest.files.iter().map(|entry| entry.file_id).collect();
    let mod_ids: Vec<u64> = {
        let mut ids: Vec<u64> = manifest.files.iter().map(|entry| entry.project_id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let files = fetch_curseforge_files_batch(client, api_key, &file_ids)?;
    let mods = fetch_curseforge_mods_batch(client, api_key, &mod_ids)?;
    let file_map: HashMap<u64, &CurseForgeBatchFile> =
        files.iter().map(|row| (row.id, row)).collect();
    let mod_map: HashMap<u64, &CurseForgeBatchMod> = mods.iter().map(|row| (row.id, row)).collect();

    let mut jobs = Vec::new();
    let mut target_paths = HashSet::new();
    let mut blocked: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for entry in &manifest.files {
        let describe = |fallback: &str| {
            mod_map
                .get(&entry.project_id)
                .map(|row| row.name.clone())
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| fallback.to_string())
        };
        let Some(file) = file_map.get(&entry.file_id) else {
            if entry.required {
                missing.push(describe(&format!(
                    "project {} file {}",
                    entry.project_id, entry.file_id
                )));
            }
            continue;
        };
        if file.mod_id != entry.project_id {
            if entry.required {
                missing.push(describe(&format!(
                    "project {} file {}",
                    entry.project_id, entry.file_id
                )));
            }
            continue;
        }
        let download_url = match file
            .download_url
            .clone()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            Some(value) => Some(value),
            None => match crate::fetch_curseforge_file_download_url(
                client,
                api_key,
                &entry.project_id.to_string(),
                entry.file_id,
            ) {
                Ok(value) => Some(value),
                Err(err) if is_curseforge_distribution_blocked_error(&err) => None,
                Err(err) => {
                    return Err(format!(
                        "Failed to resolve a download URL for CurseForge project {} file {}: {err}",
                        entry.project_id, entry.file_id
                    ))
                }
            },
        };
        let Some(download_url) = download_url else {
            if entry.required {
                blocked.push(describe(&file.file_name));
            }
            continue;
        };
        let target_dir = curseforge_class_target_dir(
            mod_map.get(&entry.project_id).and_then(|row| row.class_id),
        );
        if file.file_name.trim().is_empty() {
            return Err(format!(
                "CurseForge returned an empty filename for project {} file {}",
                entry.project_id, entry.file_id
            ));
        }
        let file_name = crate::sanitize_file_name(&file.file_name);
        let relative_path = format!("{target_dir}/{file_name}");
        if !target_paths.insert(relative_path.clone()) {
            return Err(format!(
                "CurseForge modpack contains duplicate target filename {relative_path}"
            ));
        }
        jobs.push(ModpackFileJob {
            relative_path,
            urls: vec![download_url],
            sha512: None,
            sha1: file
                .hashes
                .iter()
                .find(|hash| hash.algo == 1)
                .map(|hash| hash.value.clone()),
            size: file.file_length,
        });
    }
    if !missing.is_empty() {
        let mut preview = missing.clone();
        preview.truncate(8);
        return Err(format!(
            "CurseForge did not return metadata for {} required modpack files (e.g. {})",
            missing.len(),
            preview.join(", ")
        ));
    }
    if !blocked.is_empty() {
        let mut preview = blocked.clone();
        preview.truncate(8);
        return Err(format!(
            "{} required mods block API downloads (third-party distribution disabled): {}. \
             Install this pack from a source that bundles these files.",
            blocked.len(),
            preview.join(", ")
        ));
    }
    Ok(jobs)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_relative_path_accepts_normal_paths() {
        assert_eq!(
            safe_relative_path("mods/example.jar").unwrap(),
            PathBuf::from("mods/example.jar")
        );
        assert_eq!(
            safe_relative_path("config/a/b.cfg").unwrap(),
            PathBuf::from("config/a/b.cfg")
        );
        assert_eq!(
            safe_relative_path("./mods/x.jar").unwrap(),
            PathBuf::from("mods/x.jar")
        );
        assert_eq!(
            safe_relative_path("mods\\windows.jar").unwrap(),
            PathBuf::from("mods/windows.jar")
        );
    }

    #[test]
    fn safe_relative_path_rejects_escapes() {
        assert!(safe_relative_path("../evil.jar").is_err());
        assert!(safe_relative_path("mods/../../evil.jar").is_err());
        assert!(safe_relative_path("/etc/passwd").is_err());
        assert!(safe_relative_path("C:\\Windows\\evil.dll").is_err());
        assert!(safe_relative_path("C:/Windows/evil.dll").is_err());
        assert!(safe_relative_path("C:drive-relative.dll").is_err());
        assert!(safe_relative_path("\\\\server\\share\\evil.dll").is_err());
        assert!(safe_relative_path("\\\\?\\C:\\Windows\\evil.dll").is_err());
        assert!(safe_relative_path("").is_err());
        assert!(safe_relative_path("..").is_err());
    }

    #[test]
    fn safe_join_stays_inside_root() {
        let root = Path::new("/tmp/instance");
        let joined = safe_join(root, "mods/a.jar").unwrap();
        assert!(joined.starts_with(root));
        assert!(safe_join(root, "../outside.jar").is_err());
    }

    #[test]
    fn parses_mrpack_index_with_fabric() {
        let raw = r#"{
            "formatVersion": 1,
            "game": "minecraft",
            "versionId": "1.2.0",
            "name": "Example Pack",
            "files": [
                {
                    "path": "mods/example.jar",
                    "hashes": {"sha1": "abc", "sha512": "def"},
                    "env": {"client": "required", "server": "unsupported"},
                    "downloads": ["https://cdn.modrinth.com/data/x/example.jar"],
                    "fileSize": 1024
                }
            ],
            "dependencies": {"minecraft": "1.20.1", "fabric-loader": "0.15.11"}
        }"#;
        let index = parse_mrpack_index(raw).unwrap();
        assert_eq!(index.name, "Example Pack");
        assert_eq!(index.version_id, "1.2.0");
        assert_eq!(index.files.len(), 1);
        let loader = resolve_mrpack_loader(&index.dependencies).unwrap();
        assert_eq!(loader.loader, "fabric");
        assert_eq!(loader.loader_version.as_deref(), Some("0.15.11"));
    }

    #[test]
    fn mrpack_quilt_and_neoforge_are_rejected_with_clear_error() {
        let mut deps = HashMap::new();
        deps.insert("minecraft".to_string(), "1.20.1".to_string());
        deps.insert("quilt-loader".to_string(), "0.21.0".to_string());
        let err = resolve_mrpack_loader(&deps).unwrap_err();
        assert!(err.contains("Quilt"), "unexpected error: {err}");

        let mut deps = HashMap::new();
        deps.insert("minecraft".to_string(), "1.20.1".to_string());
        deps.insert("neoforge".to_string(), "20.4.1".to_string());
        let err = resolve_mrpack_loader(&deps).unwrap_err();
        assert!(err.contains("NeoForge"), "unexpected error: {err}");
    }

    #[test]
    fn mrpack_without_loader_is_vanilla() {
        let mut deps = HashMap::new();
        deps.insert("minecraft".to_string(), "1.20.1".to_string());
        let loader = resolve_mrpack_loader(&deps).unwrap();
        assert_eq!(loader.loader, "vanilla");
        assert!(loader.loader_version.is_none());
    }

    #[test]
    fn mrpack_index_requires_minecraft_dependency() {
        let raw =
            r#"{"formatVersion": 1, "game": "minecraft", "name": "x", "dependencies": {}}"#;
        assert!(parse_mrpack_index(raw).is_err());
    }

    #[test]
    fn mrpack_index_requires_v1_minecraft_format() {
        let raw = r#"{"formatVersion": 0, "game": "minecraft", "dependencies": {"minecraft": "1.20.1"}}"#;
        assert!(parse_mrpack_index(raw).is_err());

        let raw = r#"{"formatVersion": 1, "game": "other", "dependencies": {"minecraft": "1.20.1"}}"#;
        assert!(parse_mrpack_index(raw).is_err());
    }

    #[test]
    fn mrpack_unsupported_client_files_are_skipped() {
        let raw = r#"{
            "formatVersion": 1,
            "game": "minecraft",
            "name": "x",
            "files": [
                {"path": "mods/server-only.jar", "env": {"client": "unsupported"}, "downloads": ["https://example.com/a.jar"]},
                {
                    "path": "mods/client.jar",
                    "hashes": {
                        "sha1": "0000000000000000000000000000000000000000",
                        "sha512": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
                    },
                    "env": {"client": "required"},
                    "downloads": ["https://example.com/b.jar"],
                    "fileSize": 1
                }
            ],
            "dependencies": {"minecraft": "1.20.1"}
        }"#;
        let index = parse_mrpack_index(raw).unwrap();
        let jobs = build_mrpack_jobs(&index).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].relative_path, "mods/client.jar");
    }

    #[test]
    fn mrpack_jobs_reject_traversal_paths() {
        let raw = r#"{
            "formatVersion": 1,
            "game": "minecraft",
            "name": "x",
            "files": [
                {"path": "../outside.jar", "downloads": ["https://example.com/a.jar"]}
            ],
            "dependencies": {"minecraft": "1.20.1"}
        }"#;
        let index = parse_mrpack_index(raw).unwrap();
        assert!(build_mrpack_jobs(&index).is_err());
    }

    #[test]
    fn mrpack_jobs_require_sha512_sha1_and_size() {
        let raw = r#"{
            "formatVersion": 1,
            "game": "minecraft",
            "files": [{
                "path": "mods/incomplete.jar",
                "hashes": {
                    "sha512": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
                },
                "downloads": ["https://example.com/incomplete.jar"],
                "fileSize": 1
            }],
            "dependencies": {"minecraft": "1.20.1"}
        }"#;
        let mut index = parse_mrpack_index(raw).unwrap();
        let err = build_mrpack_jobs(&index).unwrap_err();
        assert!(err.contains("sha1"), "unexpected error: {err}");

        index.files[0].hashes.insert(
            "sha1".to_string(),
            "0000000000000000000000000000000000000000".to_string(),
        );
        index.files[0].file_size = None;
        let err = build_mrpack_jobs(&index).unwrap_err();
        assert!(err.contains("fileSize"), "unexpected error: {err}");
    }

    #[test]
    fn mrpack_verification_checks_both_hashes_and_size() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file");
        fs::write(&path, b"abc").unwrap();
        let mut job = ModpackFileJob {
            relative_path: "mods/file".to_string(),
            urls: vec![],
            sha512: Some(
                "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
                    .to_string(),
            ),
            sha1: Some("0000000000000000000000000000000000000000".to_string()),
            size: Some(3),
        };
        let err = verify_job_checksums(&path, &job).unwrap_err();
        assert!(err.contains("sha1 mismatch"), "unexpected error: {err}");

        job.sha1 = Some("a9993e364706816aba3e25717850c26c9cd0d89d".to_string());
        job.size = Some(4);
        let err = verify_job_checksums(&path, &job).unwrap_err();
        assert!(err.contains("size mismatch"), "unexpected error: {err}");
    }

    #[test]
    fn parses_curseforge_manifest_with_forge() {
        let raw = r#"{
            "minecraft": {
                "version": "1.20.1",
                "modLoaders": [{"id": "forge-47.2.0", "primary": true}]
            },
            "manifestType": "minecraftModpack",
            "manifestVersion": 1,
            "name": "Example CF Pack",
            "version": "3.1",
            "files": [
                {"projectID": 238222, "fileID": 4712345, "required": true},
                {"projectID": 32274, "fileID": 4600000}
            ],
            "overrides": "overrides"
        }"#;
        let manifest = parse_curseforge_manifest(raw).unwrap();
        assert_eq!(manifest.name, "Example CF Pack");
        assert_eq!(manifest.minecraft.version, "1.20.1");
        assert_eq!(manifest.files.len(), 2);
        assert!(manifest.files[1].required, "required defaults to true");
        let loader = resolve_curseforge_manifest_loader(&manifest.minecraft.mod_loaders).unwrap();
        assert_eq!(loader.loader, "forge");
        assert_eq!(loader.loader_version.as_deref(), Some("47.2.0"));
    }

    #[test]
    fn curseforge_manifest_requires_standard_type_and_version() {
        let raw = r#"{
            "manifestType": "other",
            "manifestVersion": 1,
            "minecraft": {"version": "1.20.1", "modLoaders": []}
        }"#;
        assert!(parse_curseforge_manifest(raw).is_err());

        let raw = r#"{
            "manifestType": "minecraftModpack",
            "manifestVersion": 2,
            "minecraft": {"version": "1.20.1", "modLoaders": []}
        }"#;
        assert!(parse_curseforge_manifest(raw).is_err());
    }

    #[test]
    fn curseforge_manifest_fabric_loader_is_parsed() {
        let loaders = vec![CurseForgeManifestModLoader {
            id: "fabric-0.15.11".to_string(),
            primary: true,
        }];
        let loader = resolve_curseforge_manifest_loader(&loaders).unwrap();
        assert_eq!(loader.loader, "fabric");
        assert_eq!(loader.loader_version.as_deref(), Some("0.15.11"));
    }

    #[test]
    fn curseforge_manifest_quilt_is_rejected() {
        let loaders = vec![CurseForgeManifestModLoader {
            id: "quilt-0.21.0".to_string(),
            primary: true,
        }];
        let err = resolve_curseforge_manifest_loader(&loaders).unwrap_err();
        assert!(err.contains("Quilt"), "unexpected error: {err}");
    }

    #[test]
    fn curseforge_manifest_neoforge_is_rejected() {
        let loaders = vec![CurseForgeManifestModLoader {
            id: "neoforge-20.4.237".to_string(),
            primary: true,
        }];
        let err = resolve_curseforge_manifest_loader(&loaders).unwrap_err();
        assert!(err.contains("NeoForge"), "unexpected error: {err}");
    }

    #[test]
    fn curseforge_distribution_blocking_is_not_confused_with_transport_errors() {
        assert!(is_curseforge_distribution_blocked_error(
            "CurseForge download URL lookup failed with HTTP 403"
        ));
        assert!(!is_curseforge_distribution_blocked_error(
            "CurseForge download URL request failed: connection timed out"
        ));
        assert!(!is_curseforge_distribution_blocked_error(
            "CurseForge download URL lookup failed with HTTP 500"
        ));
    }

    #[test]
    fn curseforge_class_ids_map_to_content_dirs() {
        assert_eq!(curseforge_class_target_dir(Some(6)), "mods");
        assert_eq!(curseforge_class_target_dir(Some(12)), "resourcepacks");
        assert_eq!(curseforge_class_target_dir(Some(6552)), "shaderpacks");
        assert_eq!(curseforge_class_target_dir(None), "mods");
    }

    fn build_test_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default();
            for (name, data) in entries {
                writer.start_file(*name, options).unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn override_extraction_writes_expected_files() {
        let zip_bytes = build_test_zip(&[
            ("overrides/config/example.cfg", b"key=value"),
            ("overrides/mods/bundled.jar", b"jar-bytes"),
            ("client-overrides/options.txt", b"fov:90"),
            ("unrelated/skip.txt", b"skip"),
        ]);
        let temp = tempfile::tempdir().unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).unwrap();
        let count = extract_override_entries(&mut archive, "overrides", temp.path()).unwrap();
        assert_eq!(count, 2);
        let count =
            extract_override_entries(&mut archive, "client-overrides", temp.path()).unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            fs::read_to_string(temp.path().join("config/example.cfg")).unwrap(),
            "key=value"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("options.txt")).unwrap(),
            "fov:90"
        );
        assert!(!temp.path().join("skip.txt").exists());
    }

    #[test]
    fn override_extraction_blocks_zip_slip() {
        let zip_bytes = build_test_zip(&[
            ("overrides/../escaped.txt", b"evil"),
            ("overrides/safe.txt", b"ok"),
        ]);
        let temp = tempfile::tempdir().unwrap();
        let instance_root = temp.path().join("instance");
        fs::create_dir_all(&instance_root).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).unwrap();
        let result = extract_override_entries(&mut archive, "overrides", &instance_root);
        assert!(result.is_err(), "zip-slip entry must fail extraction");
        assert!(
            !temp.path().join("escaped.txt").exists(),
            "file must not be written outside the instance dir"
        );
    }

    #[test]
    fn override_extraction_blocks_absolute_paths() {
        let zip_bytes = build_test_zip(&[("overrides//tmp/abs.txt", b"evil")]);
        let temp = tempfile::tempdir().unwrap();
        let instance_root = temp.path().join("instance");
        fs::create_dir_all(&instance_root).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).unwrap();
        let result = extract_override_entries(&mut archive, "overrides", &instance_root);
        assert!(result.is_err(), "absolute override path must fail extraction");
        assert!(
            !instance_root.join("tmp/abs.txt").exists(),
            "file must not be written into the instance dir either"
        );
    }

    #[test]
    fn override_extraction_blocks_windows_drive_prefixes() {
        let zip_bytes = build_test_zip(&[("overrides/C:/Windows/evil.dll", b"evil")]);
        let temp = tempfile::tempdir().unwrap();
        let instance_root = temp.path().join("instance");
        fs::create_dir_all(&instance_root).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).unwrap();
        let result = extract_override_entries(&mut archive, "overrides", &instance_root);
        assert!(result.is_err(), "drive-prefixed override path must fail");
        assert!(!instance_root.join("C:/Windows/evil.dll").exists());
    }

    #[test]
    fn allocate_instance_id_deduplicates() {
        let temp = tempfile::tempdir().unwrap();
        let versions_dir = temp.path();
        assert_eq!(
            allocate_instance_version_id(versions_dir, "My Pack!").unwrap(),
            "My-Pack"
        );
        fs::create_dir_all(versions_dir.join("My-Pack")).unwrap();
        assert_eq!(
            allocate_instance_version_id(versions_dir, "My Pack!").unwrap(),
            "My-Pack-2"
        );
    }

    #[test]
    fn creating_instance_does_not_copy_existing_runtime_content() {
        let temp = tempfile::tempdir().unwrap();
        let versions_dir = temp.path();
        let source_dir = versions_dir.join("fabric-source");
        fs::create_dir_all(source_dir.join("mods")).unwrap();
        fs::write(
            source_dir.join("fabric-source.json"),
            r#"{"id":"fabric-source","mainClass":"example.Main"}"#,
        )
        .unwrap();
        fs::write(source_dir.join("fabric-source.jar"), b"runtime").unwrap();
        fs::write(source_dir.join("mods/unrelated.jar"), b"unrelated").unwrap();
        fs::write(source_dir.join("options.txt"), b"unrelated").unwrap();

        create_instance_from_profile(versions_dir, "fabric-source", "pack-instance").unwrap();

        let target_dir = versions_dir.join("pack-instance");
        assert!(target_dir.join("pack-instance.json").is_file());
        assert!(target_dir.join("pack-instance.jar").is_file());
        assert!(!target_dir.join("mods/unrelated.jar").exists());
        assert!(!target_dir.join("options.txt").exists());
        let profile: serde_json::Value =
            serde_json::from_slice(&fs::read(target_dir.join("pack-instance.json")).unwrap())
                .unwrap();
        assert_eq!(profile.get("id").and_then(|value| value.as_str()), Some("pack-instance"));
    }

    #[test]
    fn stage_error_prefix_is_machine_readable() {
        let err = stage_err("catalog", "not found");
        assert_eq!(err, "[modpack:catalog] not found");
    }
}
