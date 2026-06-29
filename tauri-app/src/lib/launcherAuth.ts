// Launcher auth / session / stored-prefs parsing. Extracted from App.tsx.
import { DEFAULT_LOGIN_PREFS, STORAGE_KEYS } from "../constants";
import type { LauncherAuthState, LauncherLoginPrefs, LauncherUser, Locale, Settings } from "../types";
import { createSessionId } from "../utils/launcher";

export function normalizeStoredToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let token = raw.trim().replace(/^"+|"+$/g, "").trim();
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  return token || null;
}

export function parseLauncherAuthState(raw: string): LauncherAuthState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LauncherAuthState>;
    const token = normalizeStoredToken(parsed?.token);
    if (!parsed || !token) {
      return null;
    }
    return {
      token,
      user: (parsed.user as LauncherUser | undefined) ?? {}
    };
  } catch {
    return null;
  }
}

export function parseLauncherLoginPrefs(raw: string): LauncherLoginPrefs {
  try {
    const parsed = JSON.parse(raw) as Partial<LauncherLoginPrefs>;
    const rememberPassword = Boolean(parsed?.rememberPassword);
    return {
      usernameOrEmail: typeof parsed?.usernameOrEmail === "string" ? parsed.usernameOrEmail : "",
      password: rememberPassword && typeof parsed?.password === "string" ? parsed.password : "",
      rememberPassword,
      autoLogin: rememberPassword && Boolean(parsed?.autoLogin)
    };
  } catch {
    return DEFAULT_LOGIN_PREFS;
  }
}

export function loadOrCreateLauncherSessionId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEYS.launcherSessionId)?.trim();
    if (existing) {
      return existing;
    }
    const created = createSessionId();
    localStorage.setItem(STORAGE_KEYS.launcherSessionId, created);
    return created;
  } catch {
    return createSessionId();
  }
}

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
