import { invoke } from "@tauri-apps/api/core";

export async function secureStorageGet(key: string): Promise<string | null> {
  const result = await invoke<string | null>("secure_storage_get", { key });
  return result ?? null;
}

export async function secureStorageSet(key: string, value: string): Promise<void> {
  await invoke("secure_storage_set", { key, value });
}

export async function secureStorageDelete(key: string): Promise<void> {
  await invoke("secure_storage_delete", { key });
}

export async function loadSecureRaw(key: string): Promise<string | null> {
  const raw = await secureStorageGet(key);
  if (raw !== null) {
    return raw;
  }
  const legacy = readLegacyLocalStorage(key);
  if (legacy === null) {
    return null;
  }
  await secureStorageSet(key, legacy);
  window.localStorage.removeItem(key);
  console.info(`[secure-storage] migrated ${key} from localStorage`);
  return legacy;
}

export async function persistSecureJson(key: string, value: unknown): Promise<void> {
  if (value === null || value === undefined) {
    await secureStorageDelete(key);
    return;
  }
  await secureStorageSet(key, JSON.stringify(value));
}

function readLegacyLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
