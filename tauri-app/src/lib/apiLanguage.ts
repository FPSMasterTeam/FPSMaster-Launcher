import { invoke } from "@tauri-apps/api/core";
import type { Locale } from "../types";

/** Accept-Language value the backend expects for a launcher locale (contract §1). */
export function acceptLanguageFor(locale: Locale): string {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

/**
 * Tells the Rust API client which language to request. Every backend call is
 * made from Rust, so the header has to be set there, not on a fetch().
 */
export async function syncApiLanguage(locale: Locale): Promise<void> {
  try {
    await invoke("set_ui_language", { language: locale });
  } catch (error) {
    // Outside Tauri (vite dev in a browser) there is no backend to tell.
    console.warn("[i18n] failed to sync API language:", error);
  }
}
