// Error/message normalization helpers. Pure functions (no React, no Tauri).
import type { TranslationKey } from "../i18n";

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

export function formatLaunchError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (raw === "") return "";
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
    for (const [key, nested] of Object.entries(record)) {
      // `code` is an identifier for logic, never display text.
      if (key === "code") continue;
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

/** Prefix the Rust side puts on a failed FPSMaster API call (see `api_failure`). */
const API_ERROR_PREFIX = "FPSMASTER_API_ERROR ";

/** Host of the launcher's own backend; anything else is a download source. */
const FPSMASTER_API_HOST = "api.fpsmaster.top";

/** Backend codes that mean "the bearer token is no longer valid". */
const SESSION_INVALID_CODES = new Set(["UNAUTHORIZED", "AUTHENTICATION_REQUIRED"]);

/** Exact text of `downloader::CANCELLED_MESSAGE`. */
const CANCELLED_MESSAGE = "installation cancelled";

export type TaggedApiError = {
  status: number;
  code: string | null;
  /** Backend text, already localized through Accept-Language. */
  message: string | null;
  context: string | null;
};

/** Decodes the `FPSMASTER_API_ERROR {json}` string produced by the Rust API client. */
export function parseTaggedApiError(raw: string): TaggedApiError | null {
  const index = raw.indexOf(API_ERROR_PREFIX);
  if (index < 0) return null;
  try {
    const value = JSON.parse(raw.slice(index + API_ERROR_PREFIX.length)) as Record<string, unknown>;
    const status = typeof value.status === "number" ? value.status : 0;
    const text = (input: unknown) =>
      typeof input === "string" && input.trim() !== "" ? input.trim() : null;
    return {
      status,
      code: text(value.code),
      message: text(value.message),
      context: text(value.context)
    };
  } catch {
    return null;
  }
}

/**
 * What went wrong, as far as the frontend can tell. Every Tauri command returns
 * `Result<_, String>`; FPSMaster API failures carry a tagged JSON payload with
 * the backend's stable `code`, everything else is classified from the flattened
 * reqwest / io error chain.
 */
export type ApiErrorKind =
  | "offline"
  | "timeout"
  | "dns"
  | "tls"
  | "proxy"
  | "sessionExpired"
  | "forbidden"
  | "notFound"
  | "rateLimited"
  | "server"
  | "integrity"
  | "diskFull"
  | "cancelled"
  | "internal"
  | "business";

export type ClassifiedApiError = {
  kind: ApiErrorKind;
  /** Original backend text, kept for log/detail surfaces. */
  raw: string;
  /** HTTP status, when known. */
  status: number | null;
  /** Backend error code (FPSMaster API only). */
  code: string | null;
  /** Backend message for display (FPSMaster API only). */
  serverMessage: string | null;
  /** Host the failing request went to, when the error names one. */
  host: string | null;
  /** True when the failing request targeted the FPSMaster API. */
  fromApi: boolean;
  /** Which API call failed (Rust `context`), FPSMaster API only. */
  context: string | null;
};

const TRANSPORT_PATTERNS: ReadonlyArray<{ kind: ApiErrorKind; needles: readonly string[] }> = [
  {
    kind: "dns",
    needles: [
      "dns error",
      "failed to lookup address",
      "name or service not known",
      "nodename nor servname",
      "no such host",
      "temporary failure in name resolution",
      "os error 11001"
    ]
  },
  {
    kind: "tls",
    needles: [
      "invalid peer certificate",
      "certificate verify failed",
      "unknownissuer",
      "self-signed",
      "self signed",
      "tls handshake",
      "handshake failure",
      "certificate has expired",
      "certificate not valid"
    ]
  },
  {
    kind: "proxy",
    needles: ["unsuccessful tunnel", "proxy authentication required", "proxyconnect", "proxy error"]
  },
  {
    kind: "timeout",
    needles: ["timed out", "deadline has elapsed", "operation timed out", "os error 10060"]
  },
  {
    kind: "offline",
    needles: [
      "connection refused",
      "network is unreachable",
      "no route to host",
      "connection reset",
      "connection aborted",
      "connection closed before message completed",
      "failed to connect",
      "tcp connect error",
      // ECONNREFUSED on macOS / Linux / Windows, ENETUNREACH on Windows.
      "os error 61",
      "os error 111",
      "os error 10061",
      "os error 10051"
    ]
  }
];

function extractHost(text: string): string | null {
  const match = text.match(/https?:\/\/([^/\s:)"']+)/i);
  return match ? match[1].toLowerCase() : null;
}

function classified(
  kind: ApiErrorKind,
  raw: string,
  extra: Partial<Omit<ClassifiedApiError, "kind" | "raw">> = {}
): ClassifiedApiError {
  const host = extra.host ?? extractHost(raw);
  return {
    kind,
    raw,
    status: extra.status ?? null,
    code: extra.code ?? null,
    serverMessage: extra.serverMessage ?? null,
    host,
    fromApi: extra.fromApi ?? host === FPSMASTER_API_HOST,
    context: extra.context ?? null
  };
}

function classifyTagged(raw: string, tagged: TaggedApiError): ClassifiedApiError {
  const base = {
    status: tagged.status,
    code: tagged.code,
    serverMessage: tagged.message,
    host: FPSMASTER_API_HOST,
    fromApi: true,
    context: tagged.context
  };
  // Only a 401 means the token is dead. A 401 carrying another code (wrong
  // password on login) is an ordinary business failure with its own message.
  if (tagged.status === 401 && (tagged.code === null || SESSION_INVALID_CODES.has(tagged.code))) {
    return classified("sessionExpired", raw, base);
  }
  if (tagged.status === 429 || tagged.code === "RATE_LIMITED") {
    return classified("rateLimited", raw, base);
  }
  if (tagged.status >= 500) {
    return classified("server", raw, base);
  }
  if (tagged.message) {
    return classified("business", raw, base);
  }
  if (tagged.status === 403) return classified("forbidden", raw, base);
  if (tagged.status === 404) return classified("notFound", raw, base);
  return classified("business", raw, base);
}

export function classifyApiError(error: unknown): ClassifiedApiError {
  const raw = formatLaunchError(error);
  const tagged = parseTaggedApiError(raw);
  if (tagged) {
    return classifyTagged(raw, tagged);
  }

  const normalized = raw.toLowerCase();
  if (normalized.includes(CANCELLED_MESSAGE)) {
    return classified("cancelled", raw);
  }
  // A `spawn_blocking` join failure means the backend task died, not a network
  // problem — surfacing it as "check your connection" would send users chasing
  // the wrong thing.
  if (normalized.includes("failed to join") && normalized.includes("task")) {
    return classified("internal", raw);
  }
  // The launcher's own pre-flight check for a missing token.
  if (normalized === "token is required") {
    return classified("sessionExpired", raw, { fromApi: true, host: FPSMASTER_API_HOST });
  }
  if (/\b(sha1|sha256|sha512|checksum|size) mismatch\b/.test(normalized)) {
    return classified("integrity", raw);
  }
  if (/no space left on device|os error 28\b|os error 112\b|disk is full/.test(normalized)) {
    return classified("diskFull", raw);
  }

  // Downloads and metadata fetches report HTTP failures as "HTTP 404 ..." or
  // "... status=404 Not Found". These are mirror / Mojang / Modrinth answers,
  // never a verdict on the launcher session, so 401/403 is "forbidden" here.
  const statusMatch =
    normalized.match(/\bhttp\s*(\d{3})\b/) ?? normalized.match(/\bstatus[=:]\s*(\d{3})\b/);
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1], 10);
    if (status === 401 || status === 403) return classified("forbidden", raw, { status });
    if (status === 404 || status === 410) return classified("notFound", raw, { status });
    if (status === 429) return classified("rateLimited", raw, { status });
    if (status >= 500) return classified("server", raw, { status });
    return classified("business", raw, { status });
  }

  for (const { kind, needles } of TRANSPORT_PATTERNS) {
    if (needles.some((needle) => normalized.includes(needle))) {
      return classified(kind, raw);
    }
  }

  // reqwest's outermost layer without a recognizable cause: still a transport
  // failure, just an unspecific one.
  if (normalized.includes("error sending request")) {
    return classified("offline", raw);
  }

  return classified("business", raw);
}

/** True when the classified error is a transport failure (no usable network path). */
export function isNetworkErrorKind(kind: ApiErrorKind): boolean {
  return kind === "offline" || kind === "timeout" || kind === "dns" || kind === "tls" || kind === "proxy";
}

/** True when `error` was a network failure, whatever endpoint it hit. */
export function isNetworkError(error: unknown): boolean {
  return isNetworkErrorKind(classifyApiError(error).kind);
}

export function isCancelledError(error: unknown): boolean {
  return classifyApiError(error).kind === "cancelled";
}

function transportText(kind: ApiErrorKind, item: ClassifiedApiError, t: Translator): string {
  // FPSMaster API vs a download source matters: the fix for "our server is
  // down" is to wait, the fix for "BMCLAPI is down" is to switch source.
  const host = item.host;
  if (item.fromApi || !host) {
    if (kind === "offline") return t("error.network.offline");
    if (kind === "timeout") return t("error.network.timeout");
    if (kind === "dns") return t("error.network.dns");
    if (kind === "proxy") return t("error.network.proxy");
    return t("error.network.tls");
  }
  if (kind === "offline") return t("error.source.offline", { host });
  if (kind === "timeout") return t("error.source.timeout", { host });
  if (kind === "dns") return t("error.source.dns", { host });
  if (kind === "proxy") return t("error.network.proxy");
  return t("error.source.tls", { host });
}

/**
 * Human-readable, localized description of a failed command. The backend's own
 * message (already localized via Accept-Language) is shown as-is; everything
 * the client detects itself comes from the locale table.
 */
export function describeApiError(error: unknown, t: Translator): string {
  const item = classifyApiError(error);
  switch (item.kind) {
    case "offline":
    case "timeout":
    case "dns":
    case "tls":
    case "proxy":
      return transportText(item.kind, item, t);
    case "sessionExpired":
      return t("error.auth.rejected");
    case "forbidden":
      return item.fromApi
        ? t("error.http.forbidden")
        : item.host
          ? t("error.source.forbidden", { host: item.host })
          : t("error.http.forbidden");
    case "notFound": {
      if (item.fromApi) {
        // A 404 without a backend body on the release catalog means the route
        // itself is missing (backend mid-deploy), not that nothing is released.
        return item.context === "versions list"
          ? t("error.catalog.unavailable")
          : t("error.http.notFound");
      }
      const normalized = item.raw.toLowerCase();
      if (
        normalized.includes("catalog") ||
        normalized.includes("version manifest") ||
        normalized.includes("profile metadata")
      ) {
        return t("error.catalog.notFound");
      }
      return item.host
        ? t("error.source.notFound", { host: item.host })
        : t("error.download.notFound");
    }
    case "rateLimited":
      return item.serverMessage ?? t("error.http.rateLimited");
    case "server":
      return item.fromApi
        ? t("error.http.server", { status: item.status ?? 500 })
        : item.host
          ? t("error.source.server", { host: item.host, status: item.status ?? 500 })
          : t("error.http.server", { status: item.status ?? 500 });
    case "integrity":
      return t("error.download.integrity");
    case "diskFull":
      return t("error.disk.full");
    case "cancelled":
      return t("error.cancelled");
    case "internal":
      return t("error.internal");
    case "business":
    default: {
      if (item.serverMessage) {
        return item.serverMessage;
      }
      const maybeJson = item.raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])$/);
      const business = maybeJson ? tryExtractMessageFromJson(maybeJson[1]) : null;
      if (business) {
        return business;
      }
      return item.raw === "" ? t("error.unknown") : item.raw;
    }
  }
}

export function normalizeLoginError(error: unknown, t: Translator): string {
  const item = classifyApiError(error);
  // Wrong password / banned account: the backend phrased it for the user.
  if (item.fromApi && item.serverMessage && item.kind !== "server") {
    return item.serverMessage;
  }
  if (item.kind !== "business") {
    return describeApiError(error, t);
  }
  const text = item.raw
    .replace(/^login request failed:\s*/i, "")
    .replace(/^login failed:\s*/i, "")
    .trim();
  return text === "" ? t("login.failed") : text;
}

/**
 * True only when the FPSMaster backend confirmed that the bearer token is no
 * longer accepted (HTTP 401 with a session code). Mirror 403s, Mojang 401s and
 * "forbidden" business errors must never log the user out.
 */
export function isAuthExpiredError(error: unknown): boolean {
  return classifyApiError(error).kind === "sessionExpired";
}

/** The backend has no update configured for this platform/channel. */
export function isLauncherAppUpdateMissing(error: unknown): boolean {
  const item = classifyApiError(error);
  if (item.fromApi && item.status === 404) {
    return true;
  }
  const normalized = item.raw.toLowerCase();
  return (
    normalized.includes("launcher app update config not found") ||
    normalized.includes("not configured")
  );
}
