// Minecraft account parsing / identity helpers. Extracted from App.tsx.
import { invoke } from "@tauri-apps/api/core";
import { STORAGE_KEYS } from "../constants";
import type { MinecraftAccount, MinecraftAccountType } from "../types";
import { createSessionId } from "../utils/launcher";
import { createOfflineMinecraftUuid } from "./offlineUuid";

export const NIL_MINECRAFT_UUID = "00000000-0000-0000-0000-000000000000";

// How far before the actual expiry a Microsoft session is refreshed. Applied both
// by the background scheduler and at launch, so a token never enters the game with
// only seconds of validity left.
export const MICROSOFT_REFRESH_MARGIN_MS = 7 * 60_000;

export function createMicrosoftAccountId(uuid: string): string {
  return `microsoft-${uuid.trim().toLowerCase()}`;
}

function normalizeMinecraftSkinUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === "http:" && parsed.hostname.toLowerCase() === "textures.minecraft.net") {
      parsed.protocol = "https:";
    }
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeMinecraftAccount(raw: unknown): MinecraftAccount | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Partial<MinecraftAccount>;
  const type = value.type === "microsoft" ? "microsoft" : "offline";
  const username = typeof value.username === "string" ? value.username.trim() : "";
  if (!username) {
    return null;
  }
  const uuid =
    typeof value.uuid === "string" && value.uuid.trim() ? value.uuid : NIL_MINECRAFT_UUID;
  return {
    id:
      typeof value.id === "string" && value.id.trim()
        ? value.id
        : type === "microsoft"
          ? createMicrosoftAccountId(uuid)
          : createSessionId(),
    type,
    username,
    uuid,
    accessToken:
      typeof value.accessToken === "string" && value.accessToken.trim()
        ? value.accessToken
        : type === "offline"
          ? "offline"
          : "",
    refreshToken:
      typeof value.refreshToken === "string" && value.refreshToken.trim()
        ? value.refreshToken
        : null,
    xuid: typeof value.xuid === "string" && value.xuid.trim() ? value.xuid : null,
    skinUrl: normalizeMinecraftSkinUrl(value.skinUrl),
    expiresAt:
      typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
        ? value.expiresAt
        : null,
    addedAt: typeof value.addedAt === "number" ? value.addedAt : Date.now(),
    needsRelogin: type === "microsoft" && value.needsRelogin === true
  };
}

export function parseMinecraftAccounts(raw: string): MinecraftAccount[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizeMinecraftAccount)
      .filter((value): value is MinecraftAccount => value !== null);
  } catch {
    return [];
  }
}

export function loadSelectedMinecraftAccountId(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.selectedMinecraftAccount)?.trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function createOfflineMinecraftAccount(username: string): MinecraftAccount {
  const normalizedName = username.trim();
  if (!normalizedName) {
    throw new Error("Offline Minecraft username is required");
  }
  return {
    id: createSessionId(),
    type: "offline",
    // New offline profiles use the Java OfflinePlayer name-based UUID instead of the
    // nil UUID, matching what offline-mode servers derive from the name. Accounts
    // already saved with the nil UUID keep it (see normalizeMinecraftAccount): their
    // singleplayer playerdata is keyed by the old UUID and must not be orphaned.
    uuid: createOfflineMinecraftUuid(normalizedName),
    username: normalizedName,
    accessToken: "offline",
    refreshToken: null,
    xuid: null,
    skinUrl: null,
    expiresAt: null,
    addedAt: Date.now(),
    needsRelogin: false
  };
}

/**
 * True when a Microsoft account's token cannot be trusted for the next
 * `marginMs` and a refresh must run first. A token without a known expiry is
 * treated as expired: it may have been dead for weeks, and refreshing is the
 * only way to find out.
 */
export function shouldRefreshMicrosoftAccount(
  account: MinecraftAccount,
  marginMs: number = MICROSOFT_REFRESH_MARGIN_MS,
  now: number = Date.now()
): boolean {
  if (account.type !== "microsoft") {
    return false;
  }
  if (!account.accessToken.trim()) {
    return true;
  }
  const expiresAt = typeof account.expiresAt === "number" ? account.expiresAt : null;
  if (expiresAt === null) {
    return true;
  }
  return expiresAt <= now + marginMs;
}

export function resolveMinecraftLaunchIdentity(account: MinecraftAccount): {
  playerName: string;
  uuid: string;
  accessToken: string;
} {
  if (account.type === "microsoft") {
    if (!account.uuid.trim() || !account.accessToken.trim() || account.needsRelogin) {
      throw new Error("Minecraft premium account is not logged in yet");
    }
    return {
      playerName: account.username,
      uuid: account.uuid,
      accessToken: account.accessToken
    };
  }
  return {
    playerName: account.username,
    uuid: account.uuid || NIL_MINECRAFT_UUID,
    accessToken: account.accessToken || "offline"
  };
}

export async function refreshMinecraftAccount(
  refreshToken: string,
  ipcSession?: string
): Promise<MinecraftAccount> {
  return invoke<MinecraftAccount>("refresh_minecraft_account", { refreshToken, ipcSession });
}

// --- avatar/skin resolution -------------------------------------------------
// Accounts whose stored skinUrl is empty still get an avatar: premium profiles are
// resolved by UUID, offline names by a Mojang username lookup (a name matching a
// real profile shows that profile's skin). Results are cached so rendering account
// rows never hammers the Mojang APIs; misses are cached shorter than hits so a new
// skin shows up reasonably fast after being uploaded.

export type MinecraftSkinIdentity = {
  type: MinecraftAccountType;
  uuid: string;
  username: string;
};

type SkinLookupCacheEntry = { url: string | null; expiresAt: number };

const SKIN_LOOKUP_HIT_TTL_MS = 60 * 60_000;
const SKIN_LOOKUP_MISS_TTL_MS = 10 * 60_000;
const SKIN_LOOKUP_ERROR_TTL_MS = 60_000;

const skinLookupCache = new Map<string, SkinLookupCacheEntry>();
const skinLookupInFlight = new Map<string, Promise<string | null>>();

function skinLookupParams(
  identity: MinecraftSkinIdentity
): { key: string; uuid: string | null; username: string | null } | null {
  const uuid = identity.uuid.trim();
  const username = identity.username.trim();
  // Offline UUIDs (nil or name-derived) do not exist on Mojang's servers; the
  // username is the only identity that can map to a real profile skin there.
  const lookupUuid =
    identity.type === "microsoft" && uuid && uuid !== NIL_MINECRAFT_UUID ? uuid : null;
  if (lookupUuid) {
    const normalizedUuid = lookupUuid.replace(/-/g, "").toLowerCase();
    return { key: `uuid:${normalizedUuid}`, uuid: normalizedUuid, username: null };
  }
  if (username) {
    return { key: `name:${username.toLowerCase()}`, uuid: null, username };
  }
  return null;
}

export async function lookupMinecraftSkinUrl(
  identity: MinecraftSkinIdentity
): Promise<string | null> {
  const params = skinLookupParams(identity);
  if (!params) {
    return null;
  }
  const cached = skinLookupCache.get(params.key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }
  const inFlight = skinLookupInFlight.get(params.key);
  if (inFlight) {
    return inFlight;
  }
  const request = invoke<string | null>("lookup_minecraft_skin_url", {
    uuid: params.uuid,
    username: params.username
  })
    .then((url) => {
      const normalized = normalizeMinecraftSkinUrl(url);
      skinLookupCache.set(params.key, {
        url: normalized,
        expiresAt: Date.now() + (normalized ? SKIN_LOOKUP_HIT_TTL_MS : SKIN_LOOKUP_MISS_TTL_MS)
      });
      return normalized;
    })
    .catch(() => {
      // Transient failure: remember briefly so the UI retries soon without spamming.
      skinLookupCache.set(params.key, {
        url: null,
        expiresAt: Date.now() + SKIN_LOOKUP_ERROR_TTL_MS
      });
      return null;
    })
    .finally(() => {
      skinLookupInFlight.delete(params.key);
    });
  skinLookupInFlight.set(params.key, request);
  return request;
}
