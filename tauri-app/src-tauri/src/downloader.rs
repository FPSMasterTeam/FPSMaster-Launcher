//! Unified resumable downloader.
//!
//! Every file the launcher fetches (JDK archives and Mojang runtime files,
//! launcher mod packages, Edge AOT / Extreme packages, modpacks, content,
//! launcher updates, vanilla libraries/assets) goes through [`download`]. It
//! owns the policy that used to be re-implemented four times with different
//! bugs:
//!
//! - temp files are `<file name>.part` (appended, never `with_extension`, so
//!   `java.exe` and `java.dll` cannot share a temp file);
//! - an interrupted `.part` is resumed with a `Range` request (guarded by
//!   `If-Range` when the server gave a validator);
//! - large files can be split into Range segments, each of which retries and
//!   resumes on its own instead of failing the whole transfer;
//! - retries use exponential backoff, failing over to the next candidate URL
//!   first, and feed `mirror_health`;
//! - the HTTP client has a per-read idle timeout instead of a 30-minute one;
//! - every read checks a [`CancelToken`] (per install session and global);
//! - progress callbacks are throttled.

use crate::minecraft_core::{lock_recover, mirror_health};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const CANCELLED_MESSAGE: &str = "Installation cancelled";
pub(crate) const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Per-read idle timeout. reqwest's blocking `Response::read` wraps each read in
/// the client timeout, so on a streamed body this is "seconds of silence before
/// we give up on this connection", not a whole-transfer deadline.
const IDLE_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Attempts against the last remaining candidate URL. Earlier candidates get a
/// single attempt each: failing over is faster than re-waiting on a bad host.
const LAST_CANDIDATE_ATTEMPTS: usize = 4;
const BACKOFF_BASE: Duration = Duration::from_millis(800);
const BACKOFF_CAP: Duration = Duration::from_secs(15);
const SEGMENT_ATTEMPTS: usize = 5;
const MIN_PARALLEL_SIZE: u64 = 8 * 1024 * 1024;
const MIN_SEGMENT_SIZE: u64 = 4 * 1024 * 1024;
const BUFFER_SIZE: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

struct TokenInner {
    session: Option<String>,
    cancelled: AtomicBool,
}

fn live_tokens() -> &'static Mutex<Vec<Weak<TokenInner>>> {
    static TOKENS: OnceLock<Mutex<Vec<Weak<TokenInner>>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Cancellation handle for one task. Cancelled either through its install
/// session (`cancel_install(session)`) or by [`cancel_all`].
#[derive(Clone)]
pub(crate) struct CancelToken(Arc<TokenInner>);

impl CancelToken {
    pub(crate) fn new(session: Option<&str>) -> Self {
        let inner = Arc::new(TokenInner {
            session: session
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
            cancelled: AtomicBool::new(false),
        });
        let mut tokens = lock_recover(live_tokens());
        tokens.retain(|token| token.strong_count() > 0);
        tokens.push(Arc::downgrade(&inner));
        Self(inner)
    }

    pub(crate) fn session(&self) -> Option<&str> {
        self.0.session.as_deref()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Relaxed) || crate::is_install_cancelled(self.session())
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(CANCELLED_MESSAGE.to_string())
        } else {
            Ok(())
        }
    }

    /// Sleeps for `duration`, waking early (with an error) if cancelled.
    pub(crate) fn sleep(&self, duration: Duration) -> Result<(), String> {
        let deadline = Instant::now() + duration;
        loop {
            self.check()?;
            let now = Instant::now();
            if now >= deadline {
                return Ok(());
            }
            thread::sleep((deadline - now).min(Duration::from_millis(100)));
        }
    }
}

/// Cancels every download task that is currently running. Session-scoped work
/// that only checks `is_install_cancelled(session)` is stopped too, by marking
/// those sessions cancelled.
pub(crate) fn cancel_all() -> usize {
    let tokens = {
        let mut tokens = lock_recover(live_tokens());
        tokens.retain(|token| token.strong_count() > 0);
        tokens.iter().filter_map(Weak::upgrade).collect::<Vec<_>>()
    };
    for token in &tokens {
        token.cancelled.store(true, Ordering::Relaxed);
        if let Some(session) = token.session.as_deref() {
            let _ = crate::request_install_cancel(session);
        }
    }
    tokens.len()
}

// ---------------------------------------------------------------------------
// HTTP client and paths
// ---------------------------------------------------------------------------

pub(crate) fn http_client() -> Result<&'static reqwest::blocking::Client, String> {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::JDK_DOWNLOAD_USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(IDLE_READ_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to build download client: {e}"))?;
    Ok(CLIENT.get_or_init(|| client))
}

/// `target` with `suffix` appended to its full file name (extension kept).
pub(crate) fn with_suffix(target: &Path, suffix: &str) -> PathBuf {
    let mut name = target
        .file_name()
        .map(|value| value.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    target.with_file_name(name)
}

/// Temp file used while `target` is being downloaded: the full file name with
/// `.part` appended, so siblings that only differ by extension never collide.
pub(crate) fn part_path(target: &Path) -> PathBuf {
    with_suffix(target, ".part")
}

fn meta_path(target: &Path) -> PathBuf {
    with_suffix(target, ".part.json")
}

fn segment_path(target: &Path, index: usize, count: usize) -> PathBuf {
    with_suffix(target, &format!(".part{index}of{count}"))
}

/// Removes every temp artifact a download of `target` can leave behind.
pub(crate) fn discard_partial(target: &Path) {
    let _ = fs::remove_file(part_path(target));
    if let Some(meta) = read_meta(target) {
        if let Some(count) = meta.segments {
            for index in 0..count {
                let _ = fs::remove_file(segment_path(target, index, count));
            }
        }
    }
    let _ = fs::remove_file(meta_path(target));
}

/// Validator recorded next to a `.part` so a resume only continues bytes that
/// came from the same remote object.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
struct PartMeta {
    url: String,
    #[serde(default)]
    etag: Option<String>,
    #[serde(default)]
    last_modified: Option<String>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    segments: Option<usize>,
}

impl PartMeta {
    fn validator(&self) -> Option<&str> {
        self.etag
            .as_deref()
            .filter(|value| !value.starts_with("W/"))
            .or(self.last_modified.as_deref())
    }
}

fn read_meta(target: &Path) -> Option<PartMeta> {
    let raw = fs::read(meta_path(target)).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn write_meta(target: &Path, meta: &PartMeta) -> Result<(), String> {
    let raw = serde_json::to_vec(meta).map_err(|e| e.to_string())?;
    fs::write(meta_path(target), raw).map_err(|e| {
        format!(
            "Failed to write download state {}: {e}",
            meta_path(target).display()
        )
    })
}

fn header_string(response: &reqwest::blocking::Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string)
}

/// Parses the start offset of a `Content-Range: bytes start-end/total` header.
fn content_range_start(response: &reqwest::blocking::Response) -> Option<u64> {
    let raw = header_string(response, reqwest::header::CONTENT_RANGE)?;
    let range = raw.trim().strip_prefix("bytes")?.trim();
    range.split('-').next()?.trim().parse().ok()
}

pub(crate) fn backoff_delay(retry: usize) -> Duration {
    let factor = 1_u32 << retry.saturating_sub(1).min(5);
    (BACKOFF_BASE * factor).min(BACKOFF_CAP)
}

// ---------------------------------------------------------------------------
// Progress throttling
// ---------------------------------------------------------------------------

/// Rate limiter for progress callbacks shared between segment threads.
pub(crate) struct Throttle {
    last: Mutex<Option<Instant>>,
    interval: Duration,
}

impl Throttle {
    pub(crate) fn new(interval: Duration) -> Self {
        Self {
            last: Mutex::new(None),
            interval,
        }
    }

    pub(crate) fn ready(&self) -> bool {
        let mut last = lock_recover(&self.last);
        let now = Instant::now();
        match *last {
            Some(previous) if now.duration_since(previous) < self.interval => false,
            _ => {
                *last = Some(now);
                true
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

pub(crate) type ProgressFn<'a> = &'a (dyn Fn(u64, Option<u64>) + Sync);
pub(crate) type RetryFn<'a> = &'a (dyn Fn(&str) + Sync);

pub(crate) struct Request<'a> {
    urls: Vec<String>,
    target: &'a Path,
    cancel: &'a CancelToken,
    expected_size: Option<u64>,
    sha1: Option<String>,
    sha256: Option<String>,
    sha512: Option<String>,
    max_parts: usize,
    on_progress: Option<ProgressFn<'a>>,
    on_retry: Option<RetryFn<'a>>,
}

impl<'a> Request<'a> {
    pub(crate) fn new(urls: &[String], target: &'a Path, cancel: &'a CancelToken) -> Self {
        Self {
            urls: urls
                .iter()
                .map(|url| url.trim().to_string())
                .filter(|url| !url.is_empty())
                .collect(),
            target,
            cancel,
            expected_size: None,
            sha1: None,
            sha256: None,
            sha512: None,
            max_parts: 1,
            on_progress: None,
            on_retry: None,
        }
    }

    pub(crate) fn single(url: &str, target: &'a Path, cancel: &'a CancelToken) -> Self {
        Self::new(&[url.to_string()], target, cancel)
    }

    pub(crate) fn size(mut self, size: Option<u64>) -> Self {
        self.expected_size = size;
        self
    }

    pub(crate) fn sha1(mut self, value: Option<&str>) -> Self {
        self.sha1 = value.map(|v| v.trim().to_ascii_lowercase()).filter(|v| !v.is_empty());
        self
    }

    pub(crate) fn sha256(mut self, value: Option<&str>) -> Self {
        self.sha256 = value.and_then(crate::normalize_sha256_value);
        self
    }

    pub(crate) fn sha512(mut self, value: Option<&str>) -> Self {
        self.sha512 = value.and_then(crate::normalize_sha512_value);
        self
    }

    /// Upper bound of Range segments for this one file. Callers that already
    /// run many downloads concurrently must leave this at 1.
    pub(crate) fn max_parts(mut self, parts: usize) -> Self {
        self.max_parts = parts.max(1);
        self
    }

    pub(crate) fn on_progress(mut self, callback: ProgressFn<'a>) -> Self {
        self.on_progress = Some(callback);
        self
    }

    pub(crate) fn on_retry(mut self, callback: RetryFn<'a>) -> Self {
        self.on_retry = Some(callback);
        self
    }

    fn has_checksum(&self) -> bool {
        self.sha1.is_some() || self.sha256.is_some() || self.sha512.is_some()
    }

    fn report(&self, downloaded: u64, total: Option<u64>) {
        if let Some(callback) = self.on_progress {
            callback(downloaded, total);
        }
    }

    fn verify(&self, path: &Path) -> Result<(), String> {
        if let Some(expected) = self.expected_size {
            let actual = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
            if actual != expected {
                return Err(format!("size mismatch: expected {expected} bytes, got {actual}"));
            }
        }
        if let Some(expected) = self.sha1.as_deref() {
            let actual = crate::compute_sha1_hex(path)?;
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(format!("SHA1 mismatch: expected={expected} actual={actual}"));
            }
        }
        if let Some(expected) = self.sha256.as_deref() {
            let actual = crate::compute_file_sha256_hex(path)?;
            if actual != expected {
                return Err(format!("SHA256 mismatch: expected={expected} actual={actual}"));
            }
        }
        if let Some(expected) = self.sha512.as_deref() {
            let actual = crate::compute_file_sha512_hex(path)?;
            if actual != expected {
                return Err(format!("SHA512 mismatch: expected={expected} actual={actual}"));
            }
        }
        Ok(())
    }
}

enum AttemptError {
    /// Cancelled or a local I/O failure: retrying cannot help.
    Fatal(String),
    /// This URL will never serve the file (4xx); try the next candidate.
    Permanent(String),
    /// Network trouble; retry (resuming) after a backoff.
    Retryable(String),
}

/// Downloads `request` into its target, verifying size/checksums when given.
pub(crate) fn download(request: &Request) -> Result<(), String> {
    let target = request.target;
    if request.urls.is_empty() {
        return Err(format!("No download URL for {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }
    let client = http_client()?;
    let candidates = mirror_health::prioritize(&request.urls);
    let mut last_error = String::new();

    for (index, url) in candidates.iter().enumerate() {
        let attempts = if index + 1 == candidates.len() {
            LAST_CANDIDATE_ATTEMPTS
        } else {
            1
        };
        if request.max_parts > 1 {
            match try_segmented(client, url, request) {
                Ok(true) => {
                    mirror_health::record_success(url);
                    return Ok(());
                }
                Ok(false) => {}
                Err(AttemptError::Fatal(error)) => return Err(error),
                Err(AttemptError::Permanent(error)) | Err(AttemptError::Retryable(error)) => {
                    // Segments exhausted their own retries; fall back to one stream.
                    mirror_health::record_failure(url);
                    discard_partial(target);
                    last_error = error;
                    if let Some(callback) = request.on_retry {
                        callback(&last_error);
                    }
                }
            }
        }
        for attempt in 1..=attempts {
            request.cancel.check()?;
            if attempt > 1 {
                if let Some(callback) = request.on_retry {
                    callback(&format!("Retrying ({}/{}): {last_error}", attempt - 1, attempts - 1));
                }
                request.cancel.sleep(backoff_delay(attempt - 1))?;
            }
            match attempt_stream(client, url, request) {
                Ok(()) => {
                    mirror_health::record_success(url);
                    return finalize(request);
                }
                Err(AttemptError::Fatal(error)) => return Err(error),
                Err(AttemptError::Permanent(error)) => {
                    last_error = error;
                    break;
                }
                Err(AttemptError::Retryable(error)) => {
                    mirror_health::record_failure(url);
                    last_error = error;
                }
            }
        }
    }
    Err(if last_error.is_empty() {
        format!("Failed to download {}", target.display())
    } else {
        last_error
    })
}

fn finalize(request: &Request) -> Result<(), String> {
    let target = request.target;
    let part = part_path(target);
    if target.exists() {
        fs::remove_file(target)
            .map_err(|e| format!("Failed to replace existing file {}: {e}", target.display()))?;
    }
    fs::rename(&part, target)
        .or_else(|_| fs::copy(&part, target).map(|_| ()).and_then(|_| fs::remove_file(&part)))
        .map_err(|e| {
            format!(
                "Failed to move downloaded file from {} to {}: {e}",
                part.display(),
                target.display()
            )
        })?;
    let _ = fs::remove_file(meta_path(target));
    Ok(())
}

fn classify_status(url: &str, status: reqwest::StatusCode) -> AttemptError {
    let message = format!("HTTP {status} from {url}");
    if status.is_client_error()
        && status != reqwest::StatusCode::REQUEST_TIMEOUT
        && status != reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        AttemptError::Permanent(message)
    } else {
        AttemptError::Retryable(message)
    }
}

/// Copies the response body into `file`, checking cancellation on every chunk.
/// `on_chunk` receives the number of bytes just written.
fn pump_body(
    response: &mut reqwest::blocking::Response,
    file: &mut fs::File,
    cancel: &CancelToken,
    url: &str,
    mut on_chunk: impl FnMut(u64),
) -> Result<(), AttemptError> {
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    loop {
        if cancel.is_cancelled() {
            return Err(AttemptError::Fatal(CANCELLED_MESSAGE.to_string()));
        }
        let read = match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                return Err(AttemptError::Retryable(format!(
                    "Read from {url} failed: {error}"
                )))
            }
        };
        file.write_all(&buffer[..read])
            .map_err(|e| AttemptError::Fatal(format!("Failed to write download data: {e}")))?;
        on_chunk(read as u64);
    }
    file.flush()
        .map_err(|e| AttemptError::Fatal(format!("Failed to flush download data: {e}")))
}

/// One streaming attempt into `<target>.part`, resuming an existing partial
/// file when it is safe to do so.
fn attempt_stream(
    client: &reqwest::blocking::Client,
    url: &str,
    request: &Request,
) -> Result<(), AttemptError> {
    let target = request.target;
    let part = part_path(target);
    let existing = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
    let meta = read_meta(target).filter(|meta| meta.segments.is_none());
    // Resuming is only safe when we can prove the remote object is the same:
    // either the server gave a validator (sent back as If-Range) or the final
    // checksum will catch a mismatch.
    let resumable = existing > 0
        && meta.as_ref().is_some_and(|meta| {
            meta.url == url && (meta.validator().is_some() || request.has_checksum())
        });
    if existing > 0 && !resumable {
        let _ = fs::remove_file(&part);
    }
    if resumable && request.expected_size == Some(existing) {
        // A previous run finished the body but died before verification.
        return verify_part(request, &part);
    }

    let mut builder = client
        .get(url)
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if resumable {
        builder = builder.header(reqwest::header::RANGE, format!("bytes={existing}-"));
        if let Some(validator) = meta.as_ref().and_then(PartMeta::validator) {
            builder = builder.header(reqwest::header::IF_RANGE, validator);
        }
    }
    let mut response = builder.send().map_err(|e| {
        AttemptError::Retryable(format!(
            "Request to {url} failed: {}",
            crate::describe_http_error(&e)
        ))
    })?;
    let status = response.status();

    let (mut file, mut downloaded, total) = if resumable
        && status == reqwest::StatusCode::PARTIAL_CONTENT
        && content_range_start(&response) == Some(existing)
    {
        let file = fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .map_err(|e| AttemptError::Fatal(format!("Failed to open {}: {e}", part.display())))?;
        let total = response.content_length().map(|len| len + existing);
        (file, existing, total)
    } else if resumable && status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = fs::remove_file(&part);
        let _ = fs::remove_file(meta_path(target));
        return Err(AttemptError::Retryable(format!(
            "Server rejected resume of {url}; restarting"
        )));
    } else if status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
        let meta = PartMeta {
            url: url.to_string(),
            etag: header_string(&response, reqwest::header::ETAG),
            last_modified: header_string(&response, reqwest::header::LAST_MODIFIED),
            total: response.content_length(),
            segments: None,
        };
        write_meta(target, &meta).map_err(AttemptError::Fatal)?;
        let file = fs::File::create(&part)
            .map_err(|e| AttemptError::Fatal(format!("Failed to create {}: {e}", part.display())))?;
        (file, 0, response.content_length())
    } else if status == reqwest::StatusCode::PARTIAL_CONTENT {
        // 206 that does not continue where we stopped: start over.
        let _ = fs::remove_file(&part);
        return Err(AttemptError::Retryable(format!(
            "Unexpected partial response from {url}; restarting"
        )));
    } else {
        return Err(classify_status(url, status));
    };

    let total = total.or(request.expected_size);
    request.report(downloaded, total);
    let throttle = Throttle::new(PROGRESS_INTERVAL);
    let result = pump_body(&mut response, &mut file, request.cancel, url, |delta| {
        downloaded += delta;
        if throttle.ready() {
            request.report(downloaded, total);
        }
    });
    drop(file);
    result?;
    if let Some(total) = total {
        if downloaded < total {
            return Err(AttemptError::Retryable(format!(
                "Connection to {url} closed early ({downloaded}/{total} bytes)"
            )));
        }
    }
    request.report(downloaded, total.or(Some(downloaded)));
    verify_part(request, &part)
}

fn verify_part(request: &Request, part: &Path) -> Result<(), AttemptError> {
    if let Err(error) = request.verify(part) {
        discard_partial(request.target);
        return Err(AttemptError::Retryable(format!(
            "Downloaded file {} failed verification: {error}",
            request.target.display()
        )));
    }
    Ok(())
}

struct ProbeInfo {
    total: u64,
    etag: Option<String>,
    last_modified: Option<String>,
}

fn probe_range_support(client: &reqwest::blocking::Client, url: &str) -> Option<ProbeInfo> {
    let response = client
        .head(url)
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let accepts = header_string(&response, reqwest::header::ACCEPT_RANGES)
        .is_some_and(|value| value.to_ascii_lowercase().contains("bytes"));
    if !accepts {
        return None;
    }
    Some(ProbeInfo {
        total: response.content_length()?,
        etag: header_string(&response, reqwest::header::ETAG),
        last_modified: header_string(&response, reqwest::header::LAST_MODIFIED),
    })
}

fn segment_bounds(total: u64, count: usize) -> Vec<(u64, u64)> {
    let chunk = total.div_ceil(count as u64);
    (0..count as u64)
        .map(|index| index * chunk)
        .take_while(|start| *start < total)
        .map(|start| (start, (start + chunk).min(total) - 1))
        .collect()
}

/// Parallel Range download. `Ok(false)` means the server or file size does not
/// qualify and the caller should stream normally.
fn try_segmented(
    client: &reqwest::blocking::Client,
    url: &str,
    request: &Request,
) -> Result<bool, AttemptError> {
    let target = request.target;
    let Some(probe) = probe_range_support(client, url) else {
        return Ok(false);
    };
    if probe.total < MIN_PARALLEL_SIZE {
        return Ok(false);
    }
    let count = request
        .max_parts
        .min(probe.total.div_ceil(MIN_SEGMENT_SIZE) as usize)
        .max(1);
    if count < 2 {
        return Ok(false);
    }
    let meta = PartMeta {
        url: url.to_string(),
        etag: probe.etag.clone(),
        last_modified: probe.last_modified.clone(),
        total: Some(probe.total),
        segments: Some(count),
    };
    // Existing segments are only reused when they were written for exactly the
    // same remote object and geometry.
    let same_object = read_meta(target).is_some_and(|previous| {
        previous == meta && (meta.validator().is_some() || request.has_checksum())
    });
    if !same_object {
        discard_partial(target);
    }
    write_meta(target, &meta).map_err(AttemptError::Fatal)?;

    let bounds = segment_bounds(probe.total, count);
    let paths: Vec<PathBuf> = (0..bounds.len())
        .map(|index| segment_path(target, index, count))
        .collect();
    let downloaded = AtomicU64::new(
        paths
            .iter()
            .map(|path| fs::metadata(path).map(|meta| meta.len()).unwrap_or(0))
            .sum(),
    );
    let throttle = Throttle::new(PROGRESS_INTERVAL);
    let total = probe.total;
    let validator = meta.validator().map(ToString::to_string);
    request.report(downloaded.load(Ordering::Relaxed), Some(total));

    let results: Vec<Result<(), AttemptError>> = thread::scope(|scope| {
        let handles: Vec<_> = bounds
            .iter()
            .zip(paths.iter())
            .map(|(&(start, end), path)| {
                let downloaded = &downloaded;
                let throttle = &throttle;
                let validator = validator.as_deref();
                scope.spawn(move || {
                    download_segment(client, url, path, start, end, validator, request, |delta| {
                        let now = downloaded.fetch_add(delta, Ordering::Relaxed) + delta;
                        if throttle.ready() {
                            request.report(now, Some(total));
                        }
                    })
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle.join().unwrap_or_else(|_| {
                    Err(AttemptError::Fatal("Download segment worker panicked".to_string()))
                })
            })
            .collect()
    });
    // A fatal error (cancel, disk) wins over a network error.
    let mut network_error = None;
    for result in results {
        match result {
            Ok(()) => {}
            Err(AttemptError::Fatal(error)) => return Err(AttemptError::Fatal(error)),
            Err(other) => network_error = network_error.or(Some(other)),
        }
    }
    if let Some(error) = network_error {
        return Err(error);
    }

    let part = part_path(target);
    let mut output = fs::File::create(&part)
        .map_err(|e| AttemptError::Fatal(format!("Failed to create {}: {e}", part.display())))?;
    for (path, &(start, end)) in paths.iter().zip(bounds.iter()) {
        let expected = end - start + 1;
        let actual = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        if actual != expected {
            drop(output);
            discard_partial(target);
            return Err(AttemptError::Retryable(format!(
                "Segment {} has {actual} bytes, expected {expected}",
                path.display()
            )));
        }
        let mut input = fs::File::open(path)
            .map_err(|e| AttemptError::Fatal(format!("Failed to open {}: {e}", path.display())))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|e| AttemptError::Fatal(format!("Failed to join download segments: {e}")))?;
    }
    output
        .flush()
        .map_err(|e| AttemptError::Fatal(format!("Failed to flush {}: {e}", part.display())))?;
    drop(output);
    for path in &paths {
        let _ = fs::remove_file(path);
    }
    // Segments are merged; the remaining state is a plain `.part`.
    let mut merged = meta;
    merged.segments = None;
    write_meta(target, &merged).map_err(AttemptError::Fatal)?;
    request.report(total, Some(total));
    verify_part(request, &part)?;
    finalize(request).map_err(AttemptError::Fatal)?;
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn download_segment(
    client: &reqwest::blocking::Client,
    url: &str,
    path: &Path,
    start: u64,
    end: u64,
    validator: Option<&str>,
    request: &Request,
    mut on_chunk: impl FnMut(u64),
) -> Result<(), AttemptError> {
    let expected = end - start + 1;
    let mut last_error = String::new();
    for attempt in 1..=SEGMENT_ATTEMPTS {
        if attempt > 1 {
            request
                .cancel
                .sleep(backoff_delay(attempt - 1))
                .map_err(AttemptError::Fatal)?;
        }
        let mut have = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        if have > expected {
            let _ = fs::remove_file(path);
            have = 0;
        }
        if have == expected {
            return Ok(());
        }
        let mut builder = client
            .get(url)
            .header(reqwest::header::ACCEPT, "*/*")
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .header(reqwest::header::RANGE, format!("bytes={}-{end}", start + have));
        if let Some(validator) = validator {
            builder = builder.header(reqwest::header::IF_RANGE, validator);
        }
        let mut response = match builder.send() {
            Ok(response) => response,
            Err(error) => {
                last_error = format!("Segment request failed: {}", crate::describe_http_error(&error));
                continue;
            }
        };
        if response.status() != reqwest::StatusCode::PARTIAL_CONTENT
            || content_range_start(&response) != Some(start + have)
        {
            // A 200 here means the object changed (If-Range) or Range is not
            // honoured after all; segment results would be garbage.
            return Err(classify_status(url, response.status()));
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| AttemptError::Fatal(format!("Failed to open {}: {e}", path.display())))?;
        let _ = file.seek(SeekFrom::End(0));
        match pump_body(&mut response, &mut file, request.cancel, url, &mut on_chunk) {
            Ok(()) => {
                let now = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
                if now == expected {
                    return Ok(());
                }
                last_error = format!("Segment ended early ({now}/{expected} bytes)");
            }
            Err(AttemptError::Retryable(error)) => last_error = error,
            Err(other) => return Err(other),
        }
    }
    Err(AttemptError::Retryable(last_error))
}

// ---------------------------------------------------------------------------
// Source probing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResult {
    pub url: String,
    pub ok: bool,
    /// Time to response headers.
    pub latency_ms: Option<u64>,
    pub bytes_per_second: Option<u64>,
    pub bytes_read: u64,
    pub error: Option<String>,
}

/// Measures latency and throughput against `url` by reading at most
/// `max_bytes` (or for at most `budget`).
pub(crate) fn probe_url(url: &str, max_bytes: u64, budget: Duration) -> ProbeResult {
    let mut result = ProbeResult {
        url: url.to_string(),
        ok: false,
        latency_ms: None,
        bytes_per_second: None,
        bytes_read: 0,
        error: None,
    };
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => {
            result.error = Some(error);
            return result;
        }
    };
    let started = Instant::now();
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(reqwest::header::RANGE, format!("bytes=0-{}", max_bytes.saturating_sub(1)))
        .timeout(budget)
        .send();
    let mut response = match response {
        Ok(response) => response,
        Err(error) => {
            result.error = Some(crate::describe_http_error(&error));
            return result;
        }
    };
    result.latency_ms = Some(started.elapsed().as_millis() as u64);
    if !response.status().is_success() {
        result.error = Some(format!("HTTP {}", response.status()));
        return result;
    }
    let body_started = Instant::now();
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    while result.bytes_read < max_bytes && body_started.elapsed() < budget {
        match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => result.bytes_read += read as u64,
            Err(error) => {
                result.error = Some(error.to_string());
                break;
            }
        }
    }
    let elapsed = body_started.elapsed().as_secs_f64().max(0.001);
    result.ok = result.bytes_read > 0;
    if result.ok {
        result.bytes_per_second = Some((result.bytes_read as f64 / elapsed) as u64);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_path_keeps_original_extension() {
        let exe = part_path(Path::new("/rt/bin/java.exe"));
        let dll = part_path(Path::new("/rt/bin/java.dll"));
        assert_eq!(exe, Path::new("/rt/bin/java.exe.part"));
        assert_ne!(exe, dll);
        assert_ne!(
            segment_path(Path::new("/a/java.policy"), 0, 2),
            segment_path(Path::new("/a/java.security"), 0, 2)
        );
    }

    #[test]
    fn segment_bounds_cover_whole_file() {
        let bounds = segment_bounds(10, 3);
        assert_eq!(bounds, vec![(0, 3), (4, 7), (8, 9)]);
        let bounds = segment_bounds(9 * 1024 * 1024, 16);
        let covered: u64 = bounds.iter().map(|(s, e)| e - s + 1).sum();
        assert_eq!(covered, 9 * 1024 * 1024);
    }

    #[test]
    fn backoff_is_exponential_and_capped() {
        assert_eq!(backoff_delay(1), BACKOFF_BASE);
        assert_eq!(backoff_delay(2), BACKOFF_BASE * 2);
        assert_eq!(backoff_delay(3), BACKOFF_BASE * 4);
        assert_eq!(backoff_delay(30), BACKOFF_CAP);
    }

    /// `cancel_all` is process-wide, so tests that download must not overlap it.
    static GLOBAL_CANCEL_GUARD: Mutex<()> = Mutex::new(());

    #[test]
    fn cancel_all_reaches_live_tokens() {
        let _guard = lock_recover(&GLOBAL_CANCEL_GUARD);
        let session = CancelToken::new(Some("downloader-test-session"));
        crate::request_install_cancel("downloader-test-session").unwrap();
        assert!(session.is_cancelled());
        crate::clear_install_cancel(Some("downloader-test-session"));
        let token = CancelToken::new(None);
        assert!(!token.is_cancelled());
        cancel_all();
        assert!(token.is_cancelled());
        assert!(token.check().is_err());
        let fresh = CancelToken::new(None);
        assert!(!fresh.is_cancelled());
    }

    #[test]
    fn throttle_limits_rate() {
        let throttle = Throttle::new(Duration::from_secs(60));
        assert!(throttle.ready());
        assert!(!throttle.ready());
    }

    /// Minimal HTTP/1.1 server: `handler(request_index, request_head)` returns
    /// the raw response bytes and whether to cut the body after that many bytes.
    fn serve<F>(handler: F) -> (String, Arc<Mutex<Vec<String>>>)
    where
        F: Fn(usize, &str) -> Vec<u8> + Send + 'static,
    {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        thread::spawn(move || {
            for (index, stream) in listener.incoming().enumerate() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    head.push_str(&line);
                }
                seen.lock().unwrap().push(head.clone());
                let _ = stream.write_all(&handler(index, &head));
                let _ = stream.flush();
            }
        });
        (address, requests)
    }

    fn body() -> Vec<u8> {
        (0..200_000u32).map(|value| (value % 251) as u8).collect()
    }

    fn sha1_hex(bytes: &[u8]) -> String {
        use sha1::{Digest, Sha1};
        format!("{:x}", Sha1::digest(bytes))
    }

    fn range_start(head: &str) -> Option<usize> {
        head.lines()
            .find_map(|line| line.to_ascii_lowercase().strip_prefix("range: bytes=").map(str::to_string))
            .and_then(|value| value.trim().trim_end_matches('-').parse().ok())
    }

    #[test]
    fn resumes_interrupted_body_with_range() {
        let _guard = lock_recover(&GLOBAL_CANCEL_GUARD);
        let data = body();
        let served = data.clone();
        let file_hits = AtomicU64::new(0);
        let (base, requests) = serve(move |_, head| {
            // Only count our own requests: other local processes may probe the port.
            if !head.starts_with("GET /file ") {
                return b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec();
            }
            let index = file_hits.fetch_add(1, Ordering::Relaxed);
            let start = range_start(head).unwrap_or(0);
            let slice = &served[start..];
            let mut response = if start > 0 {
                format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{}\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n",
                    slice.len(),
                    served.len() - 1,
                    served.len()
                )
            } else {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"v1\"\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                    slice.len()
                )
            }
            .into_bytes();
            // The first response dies after 70 000 body bytes.
            let cut = if index == 0 { 70_000 } else { slice.len() };
            response.extend_from_slice(&slice[..cut]);
            response
        });
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("java.exe");
        let cancel = CancelToken::new(None);
        let url = format!("{base}/file");
        download(
            &Request::single(&url, &target, &cancel)
                .size(Some(data.len() as u64))
                .sha1(Some(&sha1_hex(&data))),
        )
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), data);
        assert!(!part_path(&target).exists());
        assert!(!meta_path(&target).exists());
        let requests: Vec<String> = requests
            .lock()
            .unwrap()
            .iter()
            .filter(|head| head.starts_with("GET /file "))
            .cloned()
            .collect();
        assert_eq!(requests.len(), 2);
        assert_eq!(range_start(&requests[1]), Some(70_000), "{requests:?}");
    }

    #[test]
    fn fails_over_from_missing_mirror_and_rejects_bad_checksum() {
        let _guard = lock_recover(&GLOBAL_CANCEL_GUARD);
        let data = body();
        let served = data.clone();
        let (base, _requests) = serve(move |_, head| {
            if head.starts_with("GET /missing") {
                return b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_vec();
            }
            let mut response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                served.len()
            )
            .into_bytes();
            response.extend_from_slice(&served);
            response
        });
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("lib.jar");
        let cancel = CancelToken::new(None);
        let urls = vec![format!("{base}/missing"), format!("{base}/ok")];
        download(&Request::new(&urls, &target, &cancel).sha1(Some(&sha1_hex(&data)))).unwrap();
        assert_eq!(fs::read(&target).unwrap(), data);

        let bad = dir.path().join("bad.jar");
        let error = download(
            &Request::new(&[format!("{base}/ok")], &bad, &cancel)
                .sha1(Some("0000000000000000000000000000000000000000")),
        )
        .unwrap_err();
        assert!(error.contains("verification"), "{error}");
        assert!(!bad.exists());
        assert!(!part_path(&bad).exists());
    }
}
