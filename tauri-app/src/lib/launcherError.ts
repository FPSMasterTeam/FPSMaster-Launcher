// Error/message normalization helpers. Pure functions extracted from App.tsx.
import type { TranslationKey } from "../i18n";

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

export function formatLaunchError(error: unknown): string {
  const raw = String(error ?? "");
  if (raw === "") return "Unknown launch error";
  if (raw.startsWith("Error: ")) {
    return raw.slice("Error: ".length).trim();
  }
  return raw.trim();
}

export function findMessageInUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMessageInUnknown(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "msg", "reason"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim() !== "") {
        return candidate.trim();
      }
    }
    for (const nested of Object.values(record)) {
      const found = findMessageInUnknown(nested);
      if (found) return found;
    }
  }
  return null;
}

export function tryExtractMessageFromJson(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return findMessageInUnknown(value);
  } catch {
    return null;
  }
}

export function normalizeLoginError(error: unknown, t: Translator): string {
  let text = formatLaunchError(error);
  text = text.replace(/^login request failed:\s*/i, "").trim();
  text = text.replace(/^login failed with http \d+:\s*/i, "").trim();
  text = text.replace(/^login failed:\s*/i, "").trim();

  const maybeJson = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])$/);
  if (maybeJson) {
    const parsed = tryExtractMessageFromJson(maybeJson[1]);
    if (parsed) {
      return parsed;
    }
  }

  if (text === "") {
    return t("login.failed");
  }
  return text;
}

export function isAuthExpiredError(error: unknown): boolean {
  const normalized = formatLaunchError(error).trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "token is required" || normalized === "authentication required") {
    return true;
  }
  if (/\bhttp\s*401\b/i.test(normalized)) {
    return true;
  }
  if (/\bhttp\s*403\b/i.test(normalized)) {
    return true;
  }
  if (/\b(jwt|token)\b.*\b(expired|invalid|revoked)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(invalid|expired|missing)\b.*\b(jwt|token|authorization)\b/i.test(normalized)) {
    return true;
  }
  if (normalized.includes("bearer") && normalized.includes("invalid")) {
    return true;
  }
  const authErrorPatterns = [
    "unauthorized",
    "forbidden",
    "access denied",
    "not authenticated",
    "authentication failed",
    "session expired",
    "session invalid",
    "login required",
    "please login",
    "请先登录",
    "未授权",
    "登录已过期",
    "登录失效",
    "认证失败",
    "token无效",
    "token过期"
  ];
  return authErrorPatterns.some((pattern) => normalized.includes(pattern));
}

export function isLauncherAppUpdateMissing(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("launcher app update config not found") ||
    normalized.includes("http 404") ||
    normalized.includes("not configured")
  );
}
