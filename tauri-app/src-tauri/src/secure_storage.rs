use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

const MAGIC: &[u8; 8] = b"FPSCRD01";
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const TAG_LEN: usize = 16;
const MAX_KEY_LEN: usize = 200;
const MAX_VALUE_LEN: usize = 256 * 1024;
const CREDENTIALS_DIR: &str = "credentials-v1";
const MASTER_KEY_FILE: &str = "master.key";
const KEYRING_SERVICE: &str = "com.fpsmaster.launcher";

fn master_key_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn validate_key(raw: &str) -> Result<&str, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("Secure storage key cannot be empty".into());
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!("Secure storage key exceeds {MAX_KEY_LEN} bytes"));
    }
    Ok(key)
}

fn credentials_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join(CREDENTIALS_DIR))
        .map_err(|e| format!("Failed to resolve credentials directory: {e}"))
}

fn entry_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{:x}.credential", Sha256::digest(key.as_bytes())))
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create credentials directory: {e}"))?;
    set_mode(dir, 0o700)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|e| format!("Failed to set permissions on {}: {e}", path.display()))
}
#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) -> Result<(), String> {
    Ok(())
}

fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Credential path has no parent")?;
    let mut random = [0u8; 8];
    OsRng.fill_bytes(&mut random);
    let tmp = parent.join(format!(
        ".tmp-{}-{:016x}",
        std::process::id(),
        u64::from_le_bytes(random)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|e| format!("Failed to create temporary credential file: {e}"))?;
        file.write_all(data)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Failed to persist credential: {e}"))?;
        set_mode(&tmp, 0o600)?;
        fs::rename(&tmp, path)
            .map_err(|e| format!("Failed to atomically replace credential: {e}"))?;
        set_mode(path, 0o600)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn load_or_create_master_key(dir: &Path) -> Result<[u8; KEY_LEN], String> {
    let _guard = master_key_lock()
        .lock()
        .map_err(|_| "Secure storage master key lock is poisoned".to_string())?;
    ensure_dir(dir)?;
    let legacy_path = dir.join(MASTER_KEY_FILE);
    let keyring_user = format!(
        "secure-storage-master-key-v1-{:x}",
        Sha256::digest(dir.as_os_str().to_string_lossy().as_bytes())
    );
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_user)
        .map_err(|e| format!("Failed to access the system credential store: {e}"))?;

    let stored = match entry.get_secret() {
        Ok(bytes) => bytes,
        Err(keyring::Error::NoEntry) => {
            let bytes = match fs::read(&legacy_path) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let mut bytes = vec![0u8; KEY_LEN];
                    OsRng.fill_bytes(&mut bytes);
                    bytes
                }
                Err(e) => return Err(format!("Failed to read legacy master key: {e}")),
            };
            validate_master_key(&bytes)?;
            entry.set_secret(&bytes).map_err(|e| {
                format!("Failed to save master key in the system credential store: {e}")
            })?;
            let confirmed = entry.get_secret().map_err(|e| {
                format!("Failed to verify the system credential store master key: {e}")
            })?;
            if confirmed != bytes {
                return Err("System credential store returned a different master key".into());
            }
            confirmed
        }
        Err(e) => {
            return Err(format!(
                "Failed to read master key from the system credential store: {e}"
            ))
        }
    };

    let key = validate_master_key(&stored)?;
    match fs::read(&legacy_path) {
        Ok(legacy) => {
            if validate_master_key(&legacy)? != key {
                return Err(
                    "System credential store and legacy master key disagree; legacy data was left untouched"
                        .into(),
                );
            }
            fs::remove_file(&legacy_path).map_err(|e| {
                format!("Master key migrated but the legacy file could not be removed: {e}")
            })?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to inspect the legacy master key: {e}")),
    }
    Ok(key)
}

fn validate_master_key(bytes: &[u8]) -> Result<[u8; KEY_LEN], String> {
    if bytes.len() != KEY_LEN {
        return Err("Secure storage master key is truncated or invalid".into());
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(bytes);
    Ok(key)
}

fn encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid master key")?;
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let nonce_array = Nonce::try_from(nonce.as_slice()).map_err(|_| "Invalid nonce")?;
    let ciphertext = cipher
        .encrypt(&nonce_array, plaintext)
        .map_err(|_| "Failed to encrypt secure storage value")?;
    let mut output = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ciphertext.len());
    output.extend_from_slice(MAGIC);
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

fn decrypt(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < MAGIC.len() + NONCE_LEN + TAG_LEN {
        return Err("Secure storage credential is truncated".into());
    }
    if &blob[..MAGIC.len()] != MAGIC {
        return Err("Secure storage credential has an unsupported format or version".into());
    }
    let nonce_start = MAGIC.len();
    let ciphertext_start = nonce_start + NONCE_LEN;
    let nonce = Nonce::try_from(&blob[nonce_start..ciphertext_start])
        .map_err(|_| "Secure storage credential has an invalid nonce")?;
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| "Invalid master key")?
        .decrypt(&nonce, &blob[ciphertext_start..])
        .map_err(|_| {
            "Secure storage credential authentication failed (data was altered or key is invalid)"
                .into()
        })
}

#[tauri::command]
pub async fn secure_storage_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || secure_storage_get_blocking(app, key))
        .await
        .map_err(|e| format!("Failed to join secure storage read task: {e}"))?
}

fn secure_storage_get_blocking(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let key = validate_key(&key)?;
    let dir = credentials_dir(&app)?;
    let master = load_or_create_master_key(&dir)?;
    let path = entry_path(&dir, key);
    let blob = match fs::read(&path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read secure storage credential: {e}")),
    };
    let plaintext = decrypt(&master, &blob)?;
    String::from_utf8(plaintext)
        .map(Some)
        .map_err(|_| "Secure storage credential is not valid UTF-8".into())
}

#[tauri::command]
pub async fn secure_storage_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || secure_storage_set_blocking(app, key, value))
        .await
        .map_err(|e| format!("Failed to join secure storage write task: {e}"))?
}

fn secure_storage_set_blocking(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let key = validate_key(&key)?;
    if value.len() > MAX_VALUE_LEN {
        return Err(format!(
            "Secure storage value exceeds {MAX_VALUE_LEN} bytes"
        ));
    }
    let dir = credentials_dir(&app)?;
    let master = load_or_create_master_key(&dir)?;
    atomic_write(&entry_path(&dir, key), &encrypt(&master, value.as_bytes())?)
}

#[tauri::command]
pub async fn secure_storage_delete(app: AppHandle, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || secure_storage_delete_blocking(app, key))
        .await
        .map_err(|e| format!("Failed to join secure storage delete task: {e}"))?
}

fn secure_storage_delete_blocking(app: AppHandle, key: String) -> Result<(), String> {
    let key = validate_key(&key)?;
    let path = entry_path(&credentials_dir(&app)?, key);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete secure storage credential: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crypto_roundtrip_and_random_nonce() {
        let key = [7; KEY_LEN];
        let a = encrypt(&key, b"secret").unwrap();
        let b = encrypt(&key, b"secret").unwrap();
        assert_ne!(a, b);
        assert_eq!(decrypt(&key, &a).unwrap(), b"secret");
    }
    #[test]
    fn tampering_fails() {
        let key = [9; KEY_LEN];
        let mut blob = encrypt(&key, b"secret").unwrap();
        *blob.last_mut().unwrap() ^= 1;
        assert!(decrypt(&key, &blob)
            .unwrap_err()
            .contains("authentication failed"));
    }
    #[test]
    fn truncated_and_unknown_versions_fail() {
        let key = [1; KEY_LEN];
        assert!(decrypt(&key, b"short").unwrap_err().contains("truncated"));
        let mut blob = encrypt(&key, b"x").unwrap();
        blob[0] ^= 1;
        assert!(decrypt(&key, &blob).unwrap_err().contains("unsupported"));
    }
    #[test]
    fn hashed_names_cannot_traverse() {
        let dir = Path::new("/tmp/credentials");
        let path = entry_path(dir, "../../escape");
        assert_eq!(path.parent(), Some(dir));
    }
    #[test]
    fn atomic_write_and_delete_are_idempotent_at_core() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("value");
        atomic_write(&path, b"data").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"data");
        fs::remove_file(&path).unwrap();
        let result = match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
        assert!(result.is_ok());
    }

    #[test]
    fn master_key_requires_exact_length() {
        assert!(validate_master_key(&[0; KEY_LEN]).is_ok());
        assert!(validate_master_key(&[0; KEY_LEN - 1]).is_err());
    }
}
