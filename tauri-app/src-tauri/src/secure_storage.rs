use keyring::Entry;

const SECURE_STORAGE_SERVICE: &str = "fpsmaster.launcher";
const MAX_KEY_LEN: usize = 200;
const MAX_VALUE_LEN: usize = 256 * 1024;

fn open_entry(key: &str) -> Result<Entry, String> {
    Entry::new(SECURE_STORAGE_SERVICE, key)
        .map_err(|error| format!("Failed to open secure storage entry '{key}': {error}"))
}

fn validate_key(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Secure storage key cannot be empty".to_string());
    }
    if trimmed.len() > MAX_KEY_LEN {
        return Err(format!("Secure storage key exceeds {MAX_KEY_LEN} chars"));
    }
    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':'))
    {
        return Err("Secure storage key contains invalid characters".to_string());
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
pub fn secure_storage_get(key: String) -> Result<Option<String>, String> {
    let key = validate_key(&key)?;
    let entry = open_entry(&key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Failed to read secure storage entry '{key}': {error}")),
    }
}

#[tauri::command]
pub fn secure_storage_set(key: String, value: String) -> Result<(), String> {
    let key = validate_key(&key)?;
    if value.len() > MAX_VALUE_LEN {
        return Err(format!(
            "Secure storage value for '{key}' exceeds {MAX_VALUE_LEN} bytes"
        ));
    }
    let entry = open_entry(&key)?;
    entry
        .set_password(&value)
        .map_err(|error| format!("Failed to write secure storage entry '{key}': {error}"))
}

#[tauri::command]
pub fn secure_storage_delete(key: String) -> Result<(), String> {
    let key = validate_key(&key)?;
    let entry = open_entry(&key)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Failed to delete secure storage entry '{key}': {error}"
        )),
    }
}
