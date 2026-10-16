//! Diagnostics: secret redaction, game crash detection and upload, download
//! source probing, the one-click health check and the support bundle export.
//!
//! Everything here that leaves the machine or lands in a file the user may
//! share goes through [`redact_secrets`] first (CONTRACTS.md sections 2 and 6).

use crate::downloader::{self, ProbeResult};
use crate::minecraft_core::{self, lock_recover, DownloadSource};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

fn redaction_rules() -> &'static [(Regex, &'static str)] {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            // JWTs (FPSMaster platform tokens, Minecraft access tokens).
            (
                r"eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}",
                "<redacted-jwt>",
            ),
            (r#"(?i)(-Dfpsmaster\.auth\.token=)[^\s"']+"#, "${1}<redacted>"),
            (r#"(?i)(FPSMASTER_LAUNCH_TOKEN=)[^\s"']+"#, "${1}<redacted>"),
            (r#"(?i)(--access-?token[\s=]+)[^\s"']+"#, "${1}<redacted>"),
            (
                r#"(?i)(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',;]+"#,
                "${1}<redacted>",
            ),
            (r"(?i)((?:set-)?cookie\s*[:=]\s*)[^\r\n]+", "${1}<redacted>"),
            (
                r#"(?i)(\b(?:access_?token|refresh_?token|id_?token|auth_?token|token|password|passwd|pwd|secret|client_?secret)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+"#,
                "${1}<redacted>",
            ),
        ]
        .into_iter()
        .map(|(pattern, replacement)| {
            (
                Regex::new(pattern).expect("redaction pattern is valid"),
                replacement,
            )
        })
        .collect()
    })
}

/// Removes tokens, passwords and cookies from free text (logs, crash reports,
/// hs_err files) before it is uploaded or exported.
pub(crate) fn redact_secrets(text: &str) -> String {
    let mut output = text.to_string();
    for (regex, replacement) in redaction_rules() {
        output = regex.replace_all(&output, *replacement).into_owned();
    }
    output
}

/// Reads at most the last `max_bytes` of a text file.
fn read_text_tail(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len > max_bytes {
        file.seek(SeekFrom::Start(len - max_bytes)).ok()?;
    }
    let mut bytes = Vec::new();
    file.take(max_bytes).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Reads at most the first `max_bytes` of a text file.
fn read_text_head(path: &Path, max_bytes: u64) -> Option<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(max_bytes)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((index, _)) => text[..index].to_string(),
        None => text.to_string(),
    }
}

pub(crate) fn iso8601_utc(time: SystemTime) -> String {
    let secs = time
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

// ---------------------------------------------------------------------------
// Crash detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashArtifacts {
    pub crash_report_path: Option<String>,
    pub crash_summary: Option<String>,
    pub hs_err_path: Option<String>,
    pub hs_err_summary: Option<String>,
}

fn user_terminated() -> &'static Mutex<HashSet<i64>> {
    static SET: OnceLock<Mutex<HashSet<i64>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Remembers that the user stopped this game, so its non-zero exit code is
/// not reported as a crash.
pub(crate) fn mark_user_terminated(pid: i64) {
    lock_recover(user_terminated()).insert(pid);
}

pub(crate) fn take_user_terminated(pid: i64) -> bool {
    lock_recover(user_terminated()).remove(&pid)
}

fn modified_at(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|meta| meta.modified()).ok()
}

fn is_crash_report_name(name: &str) -> bool {
    name.starts_with("crash-") && name.ends_with(".txt")
}

fn is_hs_err_name(name: &str) -> bool {
    name.starts_with("hs_err_pid") && name.ends_with(".log")
}

/// Files in `dir` matching `predicate` modified at or after `since`, newest first.
fn files_since(dir: &Path, since: SystemTime, predicate: fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| predicate(&entry.file_name().to_string_lossy()))
        .filter_map(|entry| {
            let path = entry.path();
            let modified = modified_at(&path)?;
            (modified >= since && path.is_file()).then_some((modified, path))
        })
        .collect();
    found.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    found.into_iter().map(|(_, path)| path).collect()
}

/// Description line plus the head of the stack trace of a Minecraft crash report.
pub(crate) fn summarize_crash_report(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|line| line.trim_start().starts_with("Description:"))?;
    let summary = lines[start..]
        .iter()
        .map(|line| line.trim_end())
        .filter(|line| !line.trim().is_empty())
        .take(12)
        .collect::<Vec<_>>()
        .join("\n");
    Some(redact_secrets(&summary))
}

/// Header block of a JVM fatal error log (`# A fatal error ...`, problematic frame).
pub(crate) fn summarize_hs_err(text: &str) -> Option<String> {
    let summary = text
        .lines()
        .take_while(|line| line.starts_with('#') || line.trim().is_empty())
        .map(|line| line.trim_start_matches('#').trim())
        .filter(|line| !line.is_empty())
        .take(12)
        .collect::<Vec<_>>()
        .join("\n");
    (!summary.is_empty()).then(|| redact_secrets(&summary))
}

/// Looks for a crash report / hs_err file written by the game that just exited.
pub(crate) fn find_crash_artifacts(work_dir: &Path, pid: i64, since: SystemTime) -> CrashArtifacts {
    // File times can be coarse (FAT, SMB); give a little slack.
    let since = since.checked_sub(Duration::from_secs(2)).unwrap_or(since);
    let mut artifacts = CrashArtifacts::default();
    if let Some(report) = files_since(&work_dir.join("crash-reports"), since, is_crash_report_name)
        .into_iter()
        .next()
    {
        artifacts.crash_summary =
            read_text_head(&report, 256 * 1024).and_then(|text| summarize_crash_report(&text));
        artifacts.crash_report_path = Some(report.to_string_lossy().into_owned());
    }
    let exact = work_dir.join(format!("hs_err_pid{pid}.log"));
    let hs_err = if exact.is_file() {
        Some(exact)
    } else {
        files_since(work_dir, since, is_hs_err_name)
            .into_iter()
            .next()
    };
    if let Some(hs_err) = hs_err {
        artifacts.hs_err_summary =
            read_text_head(&hs_err, 64 * 1024).and_then(|text| summarize_hs_err(&text));
        artifacts.hs_err_path = Some(hs_err.to_string_lossy().into_owned());
    }
    artifacts
}

/// Crash files of all instances below `game_dir` from the last `max_age`.
fn recent_crash_files(game_dir: &Path, max_age: Duration) -> Vec<PathBuf> {
    let since = SystemTime::now().checked_sub(max_age).unwrap_or(UNIX_EPOCH);
    let mut dirs = vec![game_dir.to_path_buf()];
    for parent in ["versions", "apps"] {
        if let Ok(entries) = fs::read_dir(game_dir.join(parent)) {
            dirs.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir()),
            );
        }
    }
    let mut files: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        files.extend(files_since(
            &dir.join("crash-reports"),
            since,
            is_crash_report_name,
        ));
        files.extend(files_since(&dir, since, is_hs_err_name));
    }
    files.sort_by_key(|path| std::cmp::Reverse(modified_at(path)));
    files
}

// ---------------------------------------------------------------------------
// Crash upload
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashUploadRequest {
    base_url: String,
    version_id: String,
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    crash_report_path: Option<String>,
    #[serde(default)]
    hs_err_path: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    /// UI language, sent as Accept-Language ("zh-CN" / "en").
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrashUploadResult {
    /// "sent" or "rate_limited" (HTTP 429: dropped silently, do not retry).
    status: String,
}

/// Only files that are what they claim to be may be uploaded: the frontend
/// passes paths, and this must not become a way to send arbitrary files.
fn validated_crash_file(
    raw: Option<&str>,
    expect_crash_report: bool,
) -> Result<Option<PathBuf>, String> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let valid = if expect_crash_report {
        is_crash_report_name(&name)
            && path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|parent| parent == "crash-reports")
    } else {
        is_hs_err_name(&name)
    };
    if !valid || !path.is_file() {
        return Err(format!("Not a game crash file: {name}"));
    }
    Ok(Some(path))
}

fn client_kind_for(version_id: &str) -> &'static str {
    // Nova installs one directory per game version: FPSMaster-Nova-<gv>.
    if version_id == "FPSMaster-Nova" || version_id.starts_with("FPSMaster-Nova-") {
        return "NOVA";
    }
    match version_id {
        "FPSMaster-Edge" => "EDGE",
        _ => "GENERIC",
    }
}

fn upload_crash_blocking(request: CrashUploadRequest) -> Result<CrashUploadResult, String> {
    const MAX_FIELD: usize = 16_000;
    let crash_report = validated_crash_file(request.crash_report_path.as_deref(), true)?;
    let hs_err = validated_crash_file(request.hs_err_path.as_deref(), false)?;
    if crash_report.is_none() && hs_err.is_none() {
        return Err("No crash report to upload".to_string());
    }
    let report_text = crash_report
        .as_deref()
        .and_then(|path| read_text_head(path, 512 * 1024))
        .map(|text| redact_secrets(&text));
    let hs_err_text = hs_err
        .as_deref()
        .and_then(|path| read_text_head(path, 512 * 1024))
        .map(|text| redact_secrets(&text));
    let summary = report_text
        .as_deref()
        .and_then(summarize_crash_report)
        .or_else(|| hs_err_text.as_deref().and_then(summarize_hs_err))
        .unwrap_or_else(|| "Game crashed".to_string());
    let message = summary
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Game crashed")
        .to_string();
    let stack_trace = report_text
        .as_deref()
        .or(hs_err_text.as_deref())
        .unwrap_or("");
    let payload = json!({
        "exitCode": request.exit_code,
        "durationMs": request.duration_ms,
        "versionId": request.version_id,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "launcherVersion": env!("CARGO_PKG_VERSION"),
        "summary": summary,
        "hsErrSummary": hs_err_text.as_deref().and_then(summarize_hs_err),
    });
    let body = json!({
        "clientName": truncate_chars(request.version_id.trim(), 80),
        "clientKind": client_kind_for(request.version_id.trim()),
        "sessionId": request.session_id,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "severity": "fatal",
        "errorType": if report_text.is_some() { "GAME_CRASH" } else { "JVM_FATAL_ERROR" },
        "message": truncate_chars(&message, 500),
        "stackTrace": truncate_chars(stack_trace, MAX_FIELD),
        "payloadJson": truncate_chars(&payload.to_string(), MAX_FIELD),
        "occurredAt": iso8601_utc(SystemTime::now()),
    });

    let base = crate::normalize_api_base_url(&request.base_url)?;
    let client = crate::build_api_http_client()?;
    let mut builder = client
        .post(format!("{base}/api/v1/telemetry/client-errors"))
        .json(&body);
    if let Some(language) = request
        .language
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        builder = builder.header(reqwest::header::ACCEPT_LANGUAGE, language);
    }
    let response = builder.send().map_err(|e| {
        format!(
            "Crash report upload failed: {}",
            crate::describe_http_error(&e)
        )
    })?;
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Ok(CrashUploadResult {
            status: "rate_limited".to_string(),
        });
    }
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(format!("Crash report upload failed: {message}"));
    }
    Ok(CrashUploadResult {
        status: "sent".to_string(),
    })
}

/// Uploads a crash report / hs_err file to /telemetry/client-errors. The UI
/// decides whether the user agreed; this only performs the redacted upload.
#[tauri::command]
pub(crate) async fn upload_game_crash_report(
    request: CrashUploadRequest,
) -> Result<CrashUploadResult, String> {
    tauri::async_runtime::spawn_blocking(move || upload_crash_blocking(request))
        .await
        .map_err(|e| format!("Failed to join crash upload task: {e}"))?
}

// ---------------------------------------------------------------------------
// Download source probing
// ---------------------------------------------------------------------------

const OFFICIAL_PROBE_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const MIRROR_PROBE_URL: &str = "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json";
const PROBE_BYTES: u64 = 512 * 1024;
const PROBE_BUDGET: Duration = Duration::from_secs(5);
const AUTO_SOURCE_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceProbeEntry {
    /// "official" | "bmclapi" | "fpsmaster-api"
    id: String,
    #[serde(flatten)]
    result: ProbeResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceProbeReport {
    sources: Vec<SourceProbeEntry>,
    /// Download source id to use: "official-first" or "mirror-first".
    recommended: String,
}

fn probe_targets(api_base_url: Option<&str>) -> Vec<(String, String)> {
    let mut targets = vec![
        ("official".to_string(), OFFICIAL_PROBE_URL.to_string()),
        ("bmclapi".to_string(), MIRROR_PROBE_URL.to_string()),
    ];
    if let Some(base) = api_base_url.and_then(|raw| crate::normalize_api_base_url(raw).ok()) {
        targets.push((
            "fpsmaster-api".to_string(),
            format!("{base}/api/v1/telemetry/online"),
        ));
    }
    targets
}

fn probe_all(targets: Vec<(String, String)>) -> Vec<SourceProbeEntry> {
    let handles: Vec<_> = targets
        .into_iter()
        .map(|(id, url)| {
            thread::spawn(move || SourceProbeEntry {
                id,
                result: downloader::probe_url(&url, PROBE_BYTES, PROBE_BUDGET),
            })
        })
        .collect();
    handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .collect()
}

fn source_score(entry: Option<&SourceProbeEntry>) -> Option<u64> {
    let entry = entry?;
    entry
        .result
        .ok
        .then(|| entry.result.bytes_per_second.unwrap_or(0))
}

fn recommend(sources: &[SourceProbeEntry]) -> DownloadSource {
    let find = |id: &str| sources.iter().find(|entry| entry.id == id);
    match (
        source_score(find("official")),
        source_score(find("bmclapi")),
    ) {
        (Some(official), Some(mirror)) if official > mirror => DownloadSource::OfficialFirst,
        (Some(_), None) => DownloadSource::OfficialFirst,
        _ => DownloadSource::MirrorFirst,
    }
}

fn source_id(source: DownloadSource) -> &'static str {
    match source {
        DownloadSource::OfficialFirst => "official-first",
        DownloadSource::OfficialOnly => "official",
        DownloadSource::MirrorOnly => "mirror-only",
        DownloadSource::MirrorFirst => "mirror-first",
    }
}

fn auto_source_cache() -> &'static Mutex<Option<(Instant, DownloadSource)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, DownloadSource)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn remember_recommendation(source: DownloadSource) {
    *lock_recover(auto_source_cache()) = Some((Instant::now(), source));
}

/// Resolution of the "auto" download source id: the fastest of official and
/// BMCLAPI, measured at most every 30 minutes.
///
/// Never blocks on the network: `from_id("auto")` runs at the start of every
/// launch, and an offline or already-installed launch must not wait for the
/// probes. A missing or stale measurement is refreshed in the background and
/// the last known answer (or mirror-first, which still falls back to the
/// official source) is used meanwhile.
pub(crate) fn auto_download_source() -> DownloadSource {
    static REFRESHING: AtomicBool = AtomicBool::new(false);
    let cached = *lock_recover(auto_source_cache());
    if let Some((at, source)) = cached {
        if at.elapsed() < AUTO_SOURCE_TTL {
            return source;
        }
    }
    if !REFRESHING.swap(true, Ordering::SeqCst) {
        thread::spawn(|| {
            remember_recommendation(recommend(&probe_all(probe_targets(None))));
            REFRESHING.store(false, Ordering::SeqCst);
        });
    }
    cached.map_or(DownloadSource::MirrorFirst, |(_, source)| source)
}

/// Measures latency/throughput of the Minecraft download sources (and the
/// FPSMaster API when a base URL is given) and recommends the faster one.
/// The recommendation is also what the "auto" download source resolves to.
#[tauri::command]
pub(crate) async fn probe_download_sources(
    api_base_url: Option<String>,
) -> Result<SourceProbeReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sources = probe_all(probe_targets(api_base_url.as_deref()));
        let recommended = recommend(&sources);
        remember_recommendation(recommended);
        SourceProbeReport {
            sources,
            recommended: source_id(recommended).to_string(),
        }
    })
    .await
    .map_err(|e| format!("Failed to join source probe task: {e}"))
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FixAction {
    /// Tauri command that performs the repair.
    command: String,
    /// Arguments for that command (camelCase keys, ready for `invoke`).
    args: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthCheckItem {
    id: String,
    /// "java" | "instance" | "disk" | "network" | "credentials" | "crashes"
    category: String,
    /// "ok" | "warning" | "error" | "skipped"
    status: String,
    /// Stable code for the UI's i18n table (e.g. JAVA_RUNTIME_INCOMPLETE).
    code: String,
    /// Values for the localized text.
    params: Map<String, Value>,
    /// Technical detail in English (not for direct display as a sentence).
    detail: String,
    fix: Option<FixAction>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthReport {
    generated_at: String,
    items: Vec<HealthCheckItem>,
}

fn item(
    id: impl Into<String>,
    category: &str,
    status: &str,
    code: &str,
    params: Value,
    detail: impl Into<String>,
    fix: Option<FixAction>,
) -> HealthCheckItem {
    HealthCheckItem {
        id: id.into(),
        category: category.to_string(),
        status: status.to_string(),
        code: code.to_string(),
        params: params.as_object().cloned().unwrap_or_default(),
        detail: detail.into(),
        fix,
    }
}

fn fix(command: &str, args: Value) -> Option<FixAction> {
    Some(FixAction {
        command: command.to_string(),
        args,
    })
}

fn check_java_runtimes(game_dir: &Path, deep: bool, items: &mut Vec<HealthCheckItem>) {
    let runtime_dir = game_dir.join("runtime");
    let mut names: Vec<String> = fs::read_dir(&runtime_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .map(|name| {
                    // An interrupted install leaves `.jdk-N.staging`.
                    name.strip_prefix('.')
                        .and_then(|rest| rest.strip_suffix(".staging"))
                        .map(str::to_string)
                        .unwrap_or(name)
                })
                .filter(|name| crate::parse_managed_runtime_name(name).is_some())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.dedup();
    for name in names {
        let root = runtime_dir.join(&name);
        let args = json!({ "gameDir": game_dir.to_string_lossy(), "runtimeName": name });
        match crate::verify_runtime_install(&root, deep) {
            Ok(java) => items.push(item(
                format!("java:{name}"),
                "java",
                "ok",
                "JAVA_RUNTIME_OK",
                json!({ "runtime": name }),
                java.to_string_lossy(),
                None,
            )),
            Err(reason) => items.push(item(
                format!("java:{name}"),
                "java",
                "error",
                "JAVA_RUNTIME_INCOMPLETE",
                json!({ "runtime": name, "reason": reason }),
                reason.clone(),
                fix("repair_java_runtime", args),
            )),
        }
    }
}

fn check_instance(game_dir: &Path, version_id: &str, deep: bool, items: &mut Vec<HealthCheckItem>) {
    let id = format!("instance:{version_id}");
    if crate::is_native_app_version_id(version_id) {
        let install_dir = crate::native_app_install_dir(game_dir, version_id);
        let binary = install_dir.join(crate::native_app_binary_name());
        let marker = crate::native_app_marker_path(&install_dir);
        let (status, code) = if binary.is_file() && marker.is_file() {
            ("ok", "INSTANCE_FILES_OK")
        } else {
            ("error", "NATIVE_APP_INCOMPLETE")
        };
        items.push(item(
            id,
            "instance",
            status,
            code,
            json!({ "versionId": version_id }),
            install_dir.to_string_lossy(),
            None,
        ));
        return;
    }
    match minecraft_core::inspect_instance_files(game_dir, version_id, deep) {
        Ok(report) if report.missing.is_empty() && report.corrupted.is_empty() => {
            items.push(item(
                id,
                "instance",
                "ok",
                "INSTANCE_FILES_OK",
                json!({ "versionId": version_id, "checked": report.checked }),
                format!("{} files checked", report.checked),
                None,
            ));
            check_instance_java(game_dir, version_id, report.java_major, items);
        }
        Ok(report) => {
            let code = if report.corrupted.is_empty() {
                "INSTANCE_FILES_MISSING"
            } else {
                "INSTANCE_FILES_CORRUPTED"
            };
            items.push(item(
                id,
                "instance",
                "error",
                code,
                json!({
                    "versionId": version_id,
                    "missing": report.missing.len(),
                    "corrupted": report.corrupted.len(),
                    "samples": report.missing.iter().chain(report.corrupted.iter()).take(5).collect::<Vec<_>>(),
                }),
                format!("missing={:?} corrupted={:?}", report.missing, report.corrupted),
                fix(
                    "verify_installed_files",
                    json!({ "gameDir": game_dir.to_string_lossy(), "versionId": version_id }),
                ),
            ));
            check_instance_java(game_dir, version_id, report.java_major, items);
        }
        Err(error) => items.push(item(
            id,
            "instance",
            "error",
            "INSTANCE_PROFILE_UNREADABLE",
            json!({ "versionId": version_id }),
            error,
            None,
        )),
    }
}

fn check_instance_java(
    game_dir: &Path,
    version_id: &str,
    java_major: i32,
    items: &mut Vec<HealthCheckItem>,
) {
    let major = java_major.max(8);
    let x64 = minecraft_core::macos_requires_x64_runtime(game_dir, version_id);
    let root = crate::managed_jdk_runtime_root(game_dir, major, x64);
    if root.exists() || crate::runtime_staging_dir(&root).exists() {
        // Covered by the per-runtime check.
        return;
    }
    items.push(item(
        format!("java-required:{version_id}"),
        "java",
        "warning",
        "JAVA_RUNTIME_MISSING",
        json!({ "versionId": version_id, "major": major }),
        root.to_string_lossy(),
        fix(
            "ensure_jdk",
            json!({ "gameDir": game_dir.to_string_lossy(), "versionId": version_id }),
        ),
    ));
}

fn check_disk_space(game_dir: &Path, items: &mut Vec<HealthCheckItem>) {
    const GIB: u64 = 1024 * 1024 * 1024;
    let target = game_dir
        .canonicalize()
        .unwrap_or_else(|_| game_dir.to_path_buf());
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let disk = disks
        .list()
        .iter()
        .filter(|disk| target.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len());
    let Some(disk) = disk else {
        items.push(item(
            "disk",
            "disk",
            "skipped",
            "DISK_UNKNOWN",
            json!({}),
            "No disk found for the game directory",
            None,
        ));
        return;
    };
    let free = disk.available_space();
    let (status, code) = if free < GIB {
        ("error", "DISK_SPACE_CRITICAL")
    } else if free < 5 * GIB {
        ("warning", "DISK_SPACE_LOW")
    } else {
        ("ok", "DISK_SPACE_OK")
    };
    items.push(item(
        "disk",
        "disk",
        status,
        code,
        json!({ "freeBytes": free, "totalBytes": disk.total_space() }),
        disk.mount_point().to_string_lossy(),
        None,
    ));
}

fn check_network(api_base_url: Option<&str>, items: &mut Vec<HealthCheckItem>) {
    const SLOW_BYTES_PER_SECOND: u64 = 100 * 1024;
    let sources = probe_all(probe_targets(api_base_url));
    remember_recommendation(recommend(&sources));
    for source in sources {
        let result = &source.result;
        let (status, code) = if !result.ok {
            ("error", "SOURCE_UNREACHABLE")
        } else if source.id != "fpsmaster-api"
            && result.bytes_per_second.unwrap_or(0) < SLOW_BYTES_PER_SECOND
        {
            ("warning", "SOURCE_SLOW")
        } else {
            ("ok", "SOURCE_OK")
        };
        items.push(item(
            format!("network:{}", source.id),
            "network",
            status,
            code,
            json!({
                "source": source.id,
                "latencyMs": result.latency_ms,
                "bytesPerSecond": result.bytes_per_second,
            }),
            result.error.clone().unwrap_or_else(|| result.url.clone()),
            None,
        ));
    }
}

fn check_credentials(app: &AppHandle, items: &mut Vec<HealthCheckItem>) {
    match crate::secure_storage::secure_storage_status_blocking(app) {
        Ok(status) if status.backend != "unavailable" => items.push(item(
            "credentials",
            "credentials",
            "ok",
            "CREDENTIAL_STORE_OK",
            json!({ "backend": status.backend }),
            "",
            None,
        )),
        Ok(status) => {
            let code = status
                .error_code
                .clone()
                .unwrap_or_else(|| crate::secure_storage::CODE_STORE_UNAVAILABLE.to_string());
            let offer_fallback = !status.file_fallback_enabled
                && code == crate::secure_storage::CODE_STORE_UNAVAILABLE;
            items.push(item(
                "credentials",
                "credentials",
                "error",
                &code,
                json!({ "fileFallbackEnabled": status.file_fallback_enabled }),
                status.error.unwrap_or_default(),
                // Needs the user's explicit consent in the UI before invoking.
                offer_fallback.then(|| FixAction {
                    command: "secure_storage_set_file_fallback".to_string(),
                    args: json!({ "enabled": true }),
                }),
            ));
        }
        Err(error) => items.push(item(
            "credentials",
            "credentials",
            "error",
            crate::secure_storage::CODE_STORE_UNAVAILABLE,
            json!({}),
            error,
            None,
        )),
    }
}

fn check_recent_crashes(game_dir: &Path, items: &mut Vec<HealthCheckItem>) {
    let files = recent_crash_files(game_dir, Duration::from_secs(7 * 86_400));
    let Some(latest) = files.first() else {
        items.push(item(
            "crashes",
            "crashes",
            "ok",
            "NO_RECENT_CRASHES",
            json!({}),
            "",
            None,
        ));
        return;
    };
    let name = latest
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let summary = if is_hs_err_name(&name) {
        read_text_head(latest, 64 * 1024).and_then(|text| summarize_hs_err(&text))
    } else {
        read_text_head(latest, 256 * 1024).and_then(|text| summarize_crash_report(&text))
    };
    items.push(item(
        "crashes",
        "crashes",
        "warning",
        "RECENT_CRASHES",
        json!({
            "count": files.len(),
            "latestPath": latest.to_string_lossy(),
            "latestSummary": summary,
        }),
        latest.to_string_lossy(),
        fix(
            "export_support_bundle",
            json!({ "gameDir": game_dir.to_string_lossy() }),
        ),
    ));
}

pub(crate) fn run_health_check_blocking(
    app: &AppHandle,
    game_dir: &Path,
    version_id: Option<&str>,
    api_base_url: Option<&str>,
    deep: bool,
) -> HealthReport {
    let mut items = Vec::new();
    check_java_runtimes(game_dir, deep, &mut items);
    if let Some(version_id) = version_id.map(str::trim).filter(|value| !value.is_empty()) {
        if crate::ensure_safe_child_name(version_id, "Version id").is_ok() {
            check_instance(game_dir, version_id, deep, &mut items);
        }
    }
    check_disk_space(game_dir, &mut items);
    check_network(api_base_url, &mut items);
    check_credentials(app, &mut items);
    check_recent_crashes(game_dir, &mut items);
    HealthReport {
        generated_at: iso8601_utc(SystemTime::now()),
        items,
    }
}

/// One-click health check. Every item carries a status, a stable code for the
/// UI text and, where possible, the command (with arguments) that repairs it.
/// `deep` re-hashes runtime and instance files (slow).
#[tauri::command]
pub(crate) async fn run_health_check(
    app: AppHandle,
    game_dir: String,
    version_id: Option<String>,
    api_base_url: Option<String>,
    deep: Option<bool>,
) -> Result<HealthReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let game_dir = crate::resolve_game_dir_path(&game_dir)?;
        Ok(run_health_check_blocking(
            &app,
            &game_dir,
            version_id.as_deref(),
            api_base_url.as_deref(),
            deep.unwrap_or(false),
        ))
    })
    .await
    .map_err(|e| format!("Failed to join health check task: {e}"))?
}

// ---------------------------------------------------------------------------
// Support bundle
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SupportBundleResult {
    path: String,
    entries: Vec<String>,
    size_bytes: u64,
}

fn system_info(app: &AppHandle, game_dir: &Path) -> Value {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    let runtimes: Vec<Value> = fs::read_dir(game_dir.join("runtime"))
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| {
                    let path = entry.path();
                    json!({
                        "name": entry.file_name().to_string_lossy(),
                        "complete": crate::verify_runtime_install(&path, false).is_ok(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "launcherVersion": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "osVersion": sysinfo::System::long_os_version(),
        "kernelVersion": sysinfo::System::kernel_version(),
        "cpu": system.cpus().first().map(|cpu| cpu.brand().to_string()),
        "cpuCount": system.cpus().len(),
        "totalMemoryBytes": system.total_memory(),
        "availableMemoryBytes": system.available_memory(),
        "gameDir": game_dir.to_string_lossy(),
        "appDataDir": app.path().app_data_dir().ok().map(|path| path.to_string_lossy().into_owned()),
        "javaRuntimes": runtimes,
        "generatedAt": iso8601_utc(SystemTime::now()),
    })
}

fn launcher_log_text() -> String {
    let store = lock_recover(crate::ui_log_store());
    let mut text = String::new();
    for entry in &store.entries {
        text.push_str(&format!(
            "[{}][{}][{}] {}\n",
            entry.seq, entry.source, entry.level, entry.message
        ));
    }
    text
}

/// Most recently written `logs/latest.log` among the instance directories.
fn latest_game_log(game_dir: &Path, version_id: Option<&str>) -> Option<PathBuf> {
    if let Some(version_id) =
        version_id.filter(|id| crate::ensure_safe_child_name(id, "id").is_ok())
    {
        for base in ["versions", "apps"] {
            let path = game_dir
                .join(base)
                .join(version_id)
                .join("logs")
                .join("latest.log");
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let mut candidates = Vec::new();
    for base in ["versions", "apps"] {
        if let Ok(entries) = fs::read_dir(game_dir.join(base)) {
            candidates.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path().join("logs").join("latest.log"))
                    .filter(|path| path.is_file()),
            );
        }
    }
    candidates.into_iter().max_by_key(|path| modified_at(path))
}

fn export_support_bundle_blocking(
    app: &AppHandle,
    game_dir: &Path,
    version_id: Option<&str>,
    health_report: Option<Value>,
    target_path: Option<&Path>,
) -> Result<SupportBundleResult, String> {
    const LOG_TAIL: u64 = 2 * 1024 * 1024;
    let mut files: Vec<(String, String)> = vec![
        (
            "launcher-log.txt".to_string(),
            redact_secrets(&launcher_log_text()),
        ),
        (
            "system-info.json".to_string(),
            serde_json::to_string_pretty(&system_info(app, game_dir)).unwrap_or_default(),
        ),
    ];
    let health = match health_report {
        Some(report) => report,
        None => serde_json::to_value(run_health_check_blocking(
            app, game_dir, version_id, None, false,
        ))
        .unwrap_or(Value::Null),
    };
    files.push((
        "health-check.json".to_string(),
        redact_secrets(&serde_json::to_string_pretty(&health).unwrap_or_default()),
    ));
    if let Some(log) = latest_game_log(game_dir, version_id) {
        if let Some(text) = read_text_tail(&log, LOG_TAIL) {
            files.push(("game-logs/latest.log".to_string(), redact_secrets(&text)));
        }
    }
    let mut seen_names = HashSet::new();
    let (mut reports, mut hs_errs) = (0, 0);
    for path in recent_crash_files(game_dir, Duration::from_secs(14 * 86_400)) {
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (folder, budget) = if is_hs_err_name(&name) {
            hs_errs += 1;
            ("hs_err", hs_errs <= 3)
        } else {
            reports += 1;
            ("crash-reports", reports <= 5)
        };
        if !budget || !seen_names.insert(name.clone()) {
            continue;
        }
        if let Some(text) = read_text_tail(&path, 1024 * 1024) {
            files.push((format!("{folder}/{name}"), redact_secrets(&text)));
        }
    }

    let path = match target_path {
        // A location the user picked in the save dialog.
        Some(target) if target.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip")) => {
            target.to_path_buf()
        }
        Some(target) => target.with_extension("zip"),
        None => {
            let exports_dir = game_dir.join("exports");
            fs::create_dir_all(&exports_dir)
                .map_err(|e| format!("Failed to create {}: {e}", exports_dir.display()))?;
            let stamp = iso8601_utc(SystemTime::now()).replace([':', '-'], "");
            exports_dir.join(format!("fpsmaster-support-{stamp}.zip"))
        }
    };
    let file =
        fs::File::create(&path).map_err(|e| format!("Failed to create {}: {e}", path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, content) in &files {
        zip.start_file(name.as_str(), options)
            .and_then(|_| zip.write_all(content.as_bytes()).map_err(Into::into))
            .map_err(|e| format!("Failed to write {name} into the support bundle: {e}"))?;
    }
    zip.finish()
        .map_err(|e| format!("Failed to finish the support bundle: {e}"))?;
    Ok(SupportBundleResult {
        size_bytes: fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
        path: path.to_string_lossy().into_owned(),
        entries: files.into_iter().map(|(name, _)| name).collect(),
    })
}

/// Writes a redacted zip (launcher log, latest game log, crash reports,
/// hs_err files, health check, system info) to `target_path` (picked by the
/// user in a save dialog) or, without one, to `<gameDir>/exports/`.
#[tauri::command]
pub(crate) async fn export_support_bundle(
    app: AppHandle,
    game_dir: String,
    version_id: Option<String>,
    health_report: Option<Value>,
    target_path: Option<String>,
) -> Result<SupportBundleResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let game_dir = crate::resolve_game_dir_path(&game_dir)?;
        let target = target_path
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        export_support_bundle_blocking(
            &app,
            &game_dir,
            version_id.as_deref(),
            health_report,
            target.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Failed to join support bundle task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_tokens_passwords_and_cookies() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl";
        let text = format!(
            "jvm_args: -Dfpsmaster.auth.token={jwt} -Xmx2G\n\
             --accessToken abc.def --username Steve\n\
             Authorization: Bearer secretvalue\n\
             Cookie: SESSION=1; other=2\n\
             {{\"password\":\"hunter2\",\"refresh_token\":\"rt-1\"}}\n\
             url?token=q123&x=1\n\
             FPSMASTER_LAUNCH_TOKEN=plain\n\
             path C:\\Users\\Steve\\AppData"
        );
        let redacted = redact_secrets(&text);
        for secret in [
            jwt,
            "abc.def",
            "secretvalue",
            "SESSION=1",
            "hunter2",
            "rt-1",
            "q123",
            "=plain",
        ] {
            assert!(!redacted.contains(secret), "{secret} leaked: {redacted}");
        }
        assert!(redacted.contains("--username Steve"));
        assert!(redacted.contains("C:\\Users\\Steve"));
        assert!(redacted.contains("-Xmx2G"));
    }

    #[test]
    fn summarizes_crash_report_and_hs_err() {
        let report = "---- Minecraft Crash Report ----\n// Oops\n\nTime: today\nDescription: Rendering screen\n\njava.lang.NullPointerException: boom\n\tat a.b.C.d(C.java:1)\n";
        let summary = summarize_crash_report(report).unwrap();
        assert!(summary.starts_with("Description: Rendering screen"));
        assert!(summary.contains("NullPointerException"));

        let hs_err = "#\n# A fatal error has been detected by the Java Runtime Environment:\n#\n#  EXCEPTION_ACCESS_VIOLATION (0xc0000005)\n# Problematic frame:\n# C  [lwjgl.dll+0x1234]\n#\n\n---------------  S U M M A R Y ------------\n\nCommand Line: -Dfpsmaster.auth.token=secret\n";
        let summary = summarize_hs_err(hs_err).unwrap();
        assert!(summary.contains("EXCEPTION_ACCESS_VIOLATION"));
        assert!(summary.contains("lwjgl.dll"));
        assert!(!summary.contains("secret"));
    }

    #[test]
    fn finds_crash_files_written_after_launch() {
        let temp = tempfile::tempdir().unwrap();
        let launched = SystemTime::now() - Duration::from_secs(1);
        fs::create_dir_all(temp.path().join("crash-reports")).unwrap();
        fs::write(
            temp.path()
                .join("crash-reports/crash-2026-10-15_10.00.00-client.txt"),
            "Description: Ticking entity\n\njava.lang.IllegalStateException\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("hs_err_pid42.log"),
            "# A fatal error has been detected\n# Problematic frame: x\n",
        )
        .unwrap();
        let found = find_crash_artifacts(temp.path(), 42, launched);
        assert!(found.crash_report_path.is_some());
        assert!(found.crash_summary.unwrap().contains("Ticking entity"));
        assert!(found.hs_err_path.unwrap().ends_with("hs_err_pid42.log"));

        let later =
            find_crash_artifacts(temp.path(), 7, SystemTime::now() + Duration::from_secs(60));
        assert!(later.crash_report_path.is_none() && later.hs_err_path.is_none());
    }

    #[test]
    fn crash_upload_only_accepts_crash_files() {
        let temp = tempfile::tempdir().unwrap();
        let other = temp.path().join("secrets.txt");
        fs::write(&other, "x").unwrap();
        assert!(validated_crash_file(Some(&other.to_string_lossy()), true).is_err());
        assert!(validated_crash_file(Some(&other.to_string_lossy()), false).is_err());
        fs::create_dir_all(temp.path().join("crash-reports")).unwrap();
        let report = temp.path().join("crash-reports/crash-1-client.txt");
        fs::write(&report, "x").unwrap();
        assert!(validated_crash_file(Some(&report.to_string_lossy()), true)
            .unwrap()
            .is_some());
        assert!(validated_crash_file(None, true).unwrap().is_none());
    }

    #[test]
    fn iso8601_formats_epoch_dates() {
        assert_eq!(iso8601_utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            iso8601_utc(UNIX_EPOCH + Duration::from_secs(1_760_000_000)),
            "2025-10-09T08:53:20Z"
        );
    }

    #[test]
    fn recommends_faster_reachable_source() {
        let entry = |id: &str, ok: bool, speed: u64| SourceProbeEntry {
            id: id.to_string(),
            result: ProbeResult {
                url: String::new(),
                ok,
                latency_ms: Some(10),
                bytes_per_second: Some(speed),
                bytes_read: 1,
                error: None,
            },
        };
        assert!(matches!(
            recommend(&[entry("official", true, 900), entry("bmclapi", true, 100)]),
            DownloadSource::OfficialFirst
        ));
        assert!(matches!(
            recommend(&[entry("official", false, 0), entry("bmclapi", true, 100)]),
            DownloadSource::MirrorFirst
        ));
        assert!(matches!(
            recommend(&[entry("official", true, 10), entry("bmclapi", false, 0)]),
            DownloadSource::OfficialFirst
        ));
    }
}
