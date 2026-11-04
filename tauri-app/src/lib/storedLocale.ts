import { STORAGE_KEYS } from "../constants";
import type { Locale, Settings } from "../types";

/** The UI language saved in settings, read before React state exists (monitor window, boot). */
export function readStoredLocale(): Locale | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (parsed.language === "en-US" || parsed.language === "zh-CN") {
      return parsed.language;
    }
  } catch {
    // ignore malformed settings
  }
  return null;
}
