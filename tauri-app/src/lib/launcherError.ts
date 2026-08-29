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

/**
 * Cause of a failed backend call, derived from the error string the Rust side
 * produced. The backend returns `Result<_, String>` everywhere, so this is the
 * only classification signal available on the frontend — `describe_http_error`
 * deliberately flattens the whole reqwest/hyper/rustls source chain into that
 * string so the distinguishing text is present.
 */
export type ApiErrorKind =
  | "offline"
  | "timeout"
  | "dns"
  | "tls"
  | "auth"
  | "notFound"
  | "rateLimited"
  | "server"
  | "internal"
  | "business";

export type ClassifiedApiError = {
  kind: ApiErrorKind;
  /** Original backend text, kept for log/detail surfaces. */
  raw: string;
  /** HTTP status parsed out of the message, when present. */
  status: number | null;
};

const NETWORK_PATTERNS: ReadonlyArray<{ kind: ApiErrorKind; needles: readonly string[] }> = [
  {
    kind: "dns",
    needles: [
      "dns error",
      "failed to lookup address",
      "name or service not known",
      "nodename nor servname",
      "no such host"
    ]
  },
  {
    kind: "tls",
    needles: [
      "certificate",
      "invalid peer certificate",
      "self-signed",
      "tls handshake",
      "handshake failure",
      "unknownissuer",
      "certificate verify failed"
    ]
  },
  {
    kind: "timeout",
    needles: ["timed out", "timeout", "operation timed out", "deadline has elapsed"]
  },
  {
    kind: "offline",
    needles: [
      "connection refused",
      "network is unreachable",
      "no route to host",
      "connection reset",
      "connection closed",
      "failed to connect",
      "tcp connect error",
      "proxy",
      // ECONNREFUSED on macOS / Linux / Windows respectively.
      "os error 61",
      "os error 111",
      "os error 10061"
    ]
  }
];

/** Extracts the JSON/plain business message the server sent, if any. */
function extractBusinessMessage(text: string): string | null {
  const maybeJson = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])$/);
  if (maybeJson) {
    const parsed = tryExtractMessageFromJson(maybeJson[1]);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

export function classifyApiError(error: unknown): ClassifiedApiError {
  const raw = formatLaunchError(error);
  const normalized = raw.toLowerCase();

  // The backend reports HTTP failures in two shapes: "... HTTP 404" (downloads,
  // API calls) and "Request failed url=... status=404 Not Found" (metadata /
  // catalog fetches). Recognize both so 404s classify as notFound instead of
  // falling through as opaque business errors.
  const statusMatch =
    normalized.match(/http\s*(\d{3})\b/) ?? normalized.match(/\bstatus[=:]\s*(\d{3})\b/);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : null;

  // A `spawn_blocking` join failure means the backend task died, not a network
  // problem — surfacing it as "check your connection" would send users chasing
  // the wrong thing.
  if (normalized.includes("failed to join") && normalized.includes("task")) {
    return { kind: "internal", raw, status };
  }

  if (status !== null) {
    if (status === 401 || status === 403) return { kind: "auth", raw, status };
    if (status === 404) return { kind: "notFound", raw, status };
    if (status === 429) return { kind: "rateLimited", raw, status };
    if (status >= 500) return { kind: "server", raw, status };
    return { kind: "business", raw, status };
  }

  if (isAuthExpiredError(error)) {
    return { kind: "auth", raw, status };
  }

  for (const { kind, needles } of NETWORK_PATTERNS) {
    if (needles.some((needle) => normalized.includes(needle))) {
      return { kind, raw, status };
    }
  }

  // reqwest's outermost layer without a recognizable cause: still a transport
  // failure, just an unspecific one.
  if (normalized.includes("error sending request")) {
    return { kind: "offline", raw, status };
  }

  return { kind: "business", raw, status };
}

/**
 * Human-readable, localized description of a failed backend call. Technical
 * transport failures get an actionable localized sentence; genuine business
 * errors (which the server already phrases for humans) are passed through.
 */
export function describeApiError(error: unknown, t: Translator): string {
  const classified = classifyApiError(error);
  switch (classified.kind) {
    case "offline":
      return t("error.network.offline");
    case "timeout":
      return t("error.network.timeout");
    case "dns":
      return t("error.network.dns");
    case "tls":
      return t("error.network.tls");
    case "auth":
      return t("error.auth.rejected");
    case "notFound": {
      const normalized = classified.raw.toLowerCase();
      if (
        normalized.includes("catalog") ||
        normalized.includes("version manifest") ||
        normalized.includes("profile metadata")
      ) {
        return t("error.catalog.notFound");
      }
      if (
        normalized.includes("download") ||
        normalized.includes("artifact") ||
        normalized.includes("installer")
      ) {
        return t("error.download.notFound");
      }
      return t("error.http.notFound");
    }
    case "rateLimited":
      return t("error.http.rateLimited");
    case "server":
      return t("error.http.server", { status: classified.status ?? 500 });
    case "internal":
      return t("error.internal");
    case "business":
    default: {
      const business = extractBusinessMessage(classified.raw);
      if (business) {
        return business;
      }
      return classified.raw === "" ? t("error.unknown") : classified.raw;
    }
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

  // Transport-level failures reach here as raw reqwest chains ("error sending
  // request for url ...: connection timed out"), which told the user nothing.
  // Classify against the original error so HTTP status and cause are intact.
  const classified = classifyApiError(error);
  if (classified.kind !== "business") {
    return describeApiError(error, t);
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
