//! Static release catalog.
//!
//! The FPSMaster backend is being shut down, so the launcher can no longer ask
//! `/api/v1/launcher/releases/available` (which also required an FPSMaster
//! account) what to install, nor `/api/v1/launcher/app-update` whether it is
//! outdated. Both answers now come from one static JSON document:
//!
//! 1. a copy compiled into the binary (`catalog/catalog.json` at the repo root),
//!    so a fresh install works with no network at all;
//! 2. the same file fetched from GitHub (raw + jsDelivr mirror), so the catalog
//!    can still be corrected after release without shipping a new launcher;
//! 3. the last remote copy that parsed, cached in the app data dir, so a
//!    correction survives later offline starts.
//!
//! Whichever valid copy has the highest `revision` wins. A remote copy can
//! never make things worse than the bundled one: entries that fail validation
//! are dropped, and an empty or unparsable document is ignored.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::launcher_api::{current_launcher_app_update_target, LauncherAppUpdateInfo, LauncherVersion};

const BUNDLED_CATALOG: &str = include_str!("../../../catalog/catalog.json");

/// Tried in order; the first one that yields a valid document is used.
const REMOTE_CATALOG_URLS: &[&str] = &[
    "https://raw.githubusercontent.com/FPSMasterTeam/FPSMaster-Launcher/master/catalog/catalog.json",
    "https://cdn.jsdelivr.net/gh/FPSMasterTeam/FPSMaster-Launcher@master/catalog/catalog.json",
];

/// Short on purpose: the catalog is an optional refinement of the bundled copy,
/// so a slow or blocked GitHub must not hold up the home screen.
const REMOTE_TIMEOUT: Duration = Duration::from_secs(6);
const CACHE_FILE_NAME: &str = "catalog-cache.json";
/// Present (fresh) when the last remote fetch failed, so a blocked GitHub does
/// not get retried on every catalog resolve.
const FAILURE_MARKER_NAME: &str = "catalog-fetch.failed";
/// How long a fresh cache or failure marker suppresses another remote fetch.
/// Also dedupes the several resolves a single launcher run performs.
const REMOTE_RETRY_TTL: Duration = Duration::from_secs(30 * 60);
const SUPPORTED_SCHEMA: u32 = 1;
/// Client products the launcher still installs. EXTREME was dropped with the
/// final release; any leftover entry for it is filtered out.
const CLIENT_PRODUCTS: &[&str] = &["EDGE", "NOVA"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Catalog {
    pub schema: u32,
    /// Monotonic; bump on every edit so caches and mirrors can be compared.
    pub revision: u64,
    #[serde(rename = "generatedAt", default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub clients: Vec<LauncherVersion>,
    #[serde(default)]
    pub launcher: Vec<LauncherAppUpdateInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    Bundled,
    Cache,
    Remote,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogInfo {
    pub source: CatalogSource,
    pub revision: u64,
    #[serde(rename = "generatedAt")]
    pub generated_at: Option<String>,
}

/// Parses and sanitises a catalog document. Returns `None` when the document is
/// unusable as a whole (bad JSON, unknown schema, or nothing installable left).
pub fn parse_catalog(text: &str) -> Option<Catalog> {
    let mut catalog: Catalog = serde_json::from_str(text).ok()?;
    if catalog.schema != SUPPORTED_SCHEMA {
        return None;
    }
    catalog.clients.retain(|entry| {
        let product = entry.version_type.trim().to_ascii_uppercase();
        CLIENT_PRODUCTS.contains(&product.as_str())
            && entry.enabled != Some(false)
            && is_https_url(&entry.download_url)
            && entry.checksum.as_deref().is_some_and(is_sha256_hex)
            && (product != "NOVA" || entry.game_version.as_deref().is_some_and(|v| !v.trim().is_empty()))
    });
    for entry in &mut catalog.clients {
        entry.version_type = entry.version_type.trim().to_ascii_uppercase();
    }
    catalog.launcher.retain(|entry| {
        is_https_url(&entry.download_url)
            && entry.checksum.as_deref().is_some_and(is_sha256_hex)
            && !entry.version.trim().is_empty()
            && !entry.target.trim().is_empty()
    });
    for entry in &mut catalog.launcher {
        // There is nobody left to force an update on users; never block the UI.
        entry.mandatory = false;
    }
    if catalog.clients.is_empty() {
        return None;
    }
    Some(catalog)
}

fn is_https_url(value: &str) -> bool {
    value.trim().starts_with("https://")
}

fn is_sha256_hex(value: &str) -> bool {
    let value = value.trim();
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn bundled_catalog() -> Catalog {
    // Guarded by `bundled_catalog_is_valid` in tests: shipping a broken bundled
    // catalog would leave a fresh offline install with nothing to install.
    parse_catalog(BUNDLED_CATALOG).expect("bundled catalog/catalog.json must be valid")
}

fn cache_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(CACHE_FILE_NAME))
}

fn read_cached_catalog(app: &tauri::AppHandle) -> Option<Catalog> {
    let text = fs::read_to_string(cache_path(app)?).ok()?;
    parse_catalog(&text)
}

fn write_cached_catalog(app: &tauri::AppHandle, raw: &str) {
    let Some(path) = cache_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // Write-then-rename so a crash mid-write cannot leave a truncated cache
    // (which would just be ignored, but would also discard the previous one).
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, raw).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

fn fetch_one_remote_catalog(url: &str) -> Option<(Catalog, String)> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::LAUNCHER_HTTP_USER_AGENT)
        .connect_timeout(REMOTE_TIMEOUT)
        .timeout(REMOTE_TIMEOUT)
        .build()
        .ok()?;
    let response = client.get(url).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let text = response.text().ok()?;
    let catalog = parse_catalog(&text)?;
    Some((catalog, text))
}

fn fetch_remote_catalog() -> Option<(Catalog, String)> {
    // The mirrors serve the same document, so ask them in parallel and take
    // the first valid answer instead of waiting out a slow or blocked source
    // one after another (up to 2x REMOTE_TIMEOUT serially).
    let (tx, rx) = std::sync::mpsc::channel();
    let mut pending = 0usize;
    for url in REMOTE_CATALOG_URLS {
        pending += 1;
        let sender = tx.clone();
        std::thread::spawn(move || {
            let _ = sender.send(fetch_one_remote_catalog(url));
        });
    }
    drop(tx);
    let deadline = std::time::Instant::now() + REMOTE_TIMEOUT + Duration::from_secs(2);
    while pending > 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok(Some(result)) => return Some(result),
            Ok(None) => pending -= 1,
            Err(_) => break,
        }
    }
    None
}

fn is_fresh(path: &std::path::Path) -> bool {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < REMOTE_RETRY_TTL)
}

/// Skip the network when a fetch (success writes the cache, failure writes the
/// marker) happened recently; otherwise every resolve in a run would re-fetch.
fn should_attempt_remote_fetch(app: &tauri::AppHandle) -> bool {
    let Ok(dir) = app.path().app_data_dir() else { return true };
    !is_fresh(&dir.join(CACHE_FILE_NAME)) && !is_fresh(&dir.join(FAILURE_MARKER_NAME))
}

fn mark_fetch_failure(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join(FAILURE_MARKER_NAME), b"");
    }
}

fn clear_fetch_failure(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::remove_file(dir.join(FAILURE_MARKER_NAME));
    }
}

/// Picks the best catalog available right now. Never fails: the bundled copy
/// is always there as the floor.
pub fn resolve_catalog(app: &tauri::AppHandle, allow_network: bool) -> (Catalog, CatalogSource) {
    let mut best = (bundled_catalog(), CatalogSource::Bundled);
    if let Some(cached) = read_cached_catalog(app) {
        if cached.revision > best.0.revision {
            best = (cached, CatalogSource::Cache);
        }
    }
    if allow_network && should_attempt_remote_fetch(app) {
        match fetch_remote_catalog() {
            Some((remote, raw)) => {
                // Refresh the cache on any successful fetch, even when the
                // remote turned out older than what we already had: the fresh
                // cache is what dedupes further resolves in the TTL window.
                write_cached_catalog(app, &raw);
                clear_fetch_failure(app);
                if remote.revision >= best.0.revision {
                    best = (remote, CatalogSource::Remote);
                }
            }
            None => mark_fetch_failure(app),
        }
    }
    best
}

pub fn pick_app_update(catalog: &Catalog, target: &str) -> Option<LauncherAppUpdateInfo> {
    catalog
        .launcher
        .iter()
        .filter(|entry| entry.target.eq_ignore_ascii_case(target))
        .max_by(|a, b| compare_versions(&a.version, &b.version))
        .cloned()
}

/// Numeric dotted-version comparison ("0.10.0" > "0.9.3"); any pre-release
/// suffix sorts before the same release ("1.0.0-rc.1" < "1.0.0").
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn split(v: &str) -> (Vec<u64>, bool) {
        let v = v.trim().trim_start_matches('v');
        let (core, pre) = match v.split_once('-') {
            Some((core, _)) => (core, true),
            None => (v, false),
        };
        (core.split('.').map(|p| p.parse().unwrap_or(0)).collect(), pre)
    }
    let (ac, apre) = split(a);
    let (bc, bpre) = split(b);
    let len = ac.len().max(bc.len());
    for i in 0..len {
        let ord = ac.get(i).unwrap_or(&0).cmp(bc.get(i).unwrap_or(&0));
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    bpre.cmp(&apre)
}

#[tauri::command]
pub async fn catalog_list_versions(
    app: tauri::AppHandle,
    offline: Option<bool>,
) -> Result<Vec<LauncherVersion>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_catalog(&app, !offline.unwrap_or(false)).0.clients
    })
    .await
    .map_err(|e| format!("Failed to join catalog task: {e}"))
}

#[tauri::command]
pub async fn catalog_info(app: tauri::AppHandle) -> Result<CatalogInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (catalog, source) = resolve_catalog(&app, false);
        CatalogInfo {
            source,
            revision: catalog.revision,
            generated_at: catalog.generated_at,
        }
    })
    .await
    .map_err(|e| format!("Failed to join catalog task: {e}"))
}

/// Replaces the backend `app-update` endpoint. Returns `None` when the catalog
/// lists no build for this platform; whether that build is newer than the
/// running launcher is decided by the frontend, as before.
#[tauri::command]
pub async fn catalog_get_app_update(app: tauri::AppHandle) -> Result<Option<LauncherAppUpdateInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (catalog, _) = resolve_catalog(&app, true);
        pick_app_update(&catalog, &current_launcher_app_update_target())
    })
    .await
    .map_err(|e| format!("Failed to join catalog task: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn doc(clients: &str, launcher: &str) -> String {
        format!(r#"{{"schema":1,"revision":3,"clients":[{clients}],"launcher":[{launcher}]}}"#)
    }

    fn client(product: &str, url: &str, checksum: &str, game: Option<&str>) -> String {
        let game = game.map(|g| format!(r#","gameVersion":"{g}""#)).unwrap_or_default();
        format!(
            r#"{{"channel":"release","versionType":"{product}","versionName":"1.0.0","downloadUrl":"{url}","checksum":"{checksum}"{game}}}"#
        )
    }

    #[test]
    fn bundled_catalog_is_valid() {
        let catalog = parse_catalog(BUNDLED_CATALOG).expect("bundled catalog must parse");
        assert!(catalog.clients.iter().any(|c| c.version_type == "EDGE"));
        assert!(catalog.clients.iter().any(|c| c.version_type == "NOVA"));
    }

    #[test]
    fn drops_invalid_and_retired_entries() {
        let text = doc(
            &[
                client("edge", "https://example.com/a.jar", SHA, None),
                client("EXTREME", "https://example.com/b.tar.gz", SHA, None),
                client("EDGE", "http://example.com/plain.jar", SHA, None),
                client("EDGE", "https://example.com/c.jar", "deadbeef", None),
                client("NOVA", "https://example.com/n.jar", SHA, None),
                client("NOVA", "https://example.com/n2.jar", SHA, Some("1.21.11")),
            ]
            .join(","),
            "",
        );
        let catalog = parse_catalog(&text).unwrap();
        let kept: Vec<_> = catalog.clients.iter().map(|c| c.download_url.as_str()).collect();
        assert_eq!(kept, ["https://example.com/a.jar", "https://example.com/n2.jar"]);
        assert_eq!(catalog.clients[0].version_type, "EDGE");
    }

    #[test]
    fn rejects_empty_or_unknown_schema() {
        assert!(parse_catalog(&doc("", "")).is_none());
        assert!(parse_catalog("not json").is_none());
        let future = doc(&client("EDGE", "https://e/a.jar", SHA, None), "").replace(r#""schema":1"#, r#""schema":2"#);
        assert!(parse_catalog(&future).is_none());
    }

    #[test]
    fn app_update_is_never_mandatory_and_picks_newest_for_target() {
        let launcher = [
            format!(r#"{{"version":"0.9.3","downloadUrl":"https://e/a","checksum":"{SHA}","mandatory":true,"target":"macos-aarch64"}}"#),
            format!(r#"{{"version":"0.10.0","downloadUrl":"https://e/b","checksum":"{SHA}","mandatory":true,"target":"macos-aarch64"}}"#),
            format!(r#"{{"version":"9.0.0","downloadUrl":"https://e/c","checksum":"{SHA}","mandatory":false,"target":"windows-x86_64"}}"#),
        ]
        .join(",");
        let catalog = parse_catalog(&doc(&client("EDGE", "https://e/a.jar", SHA, None), &launcher)).unwrap();
        let update = pick_app_update(&catalog, "macos-aarch64").unwrap();
        assert_eq!(update.version, "0.10.0");
        assert!(!update.mandatory);
        assert!(pick_app_update(&catalog, "linux-x86_64").is_none());
    }

    #[test]
    fn fresh_marker_suppresses_retry_and_missing_allows_it() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join(FAILURE_MARKER_NAME);
        assert!(!is_fresh(&marker));
        fs::write(&marker, b"").unwrap();
        assert!(is_fresh(&marker));
    }

    #[test]
    fn version_ordering() {
        use std::cmp::Ordering::*;
        assert_eq!(compare_versions("0.10.0", "0.9.9"), Greater);
        assert_eq!(compare_versions("v1.0.0", "1.0"), Equal);
        assert_eq!(compare_versions("1.0.0-rc.1", "1.0.0"), Less);
    }
}
