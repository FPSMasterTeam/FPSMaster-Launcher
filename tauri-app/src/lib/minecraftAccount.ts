// Minecraft account parsing / identity helpers. Extracted from App.tsx.
import { invoke } from "@tauri-apps/api/core";
import { STORAGE_KEYS } from "../constants";
import type { MinecraftAccount } from "../types";
import { createSessionId } from "../utils/launcher";

export function createMicrosoftAccountId(uuid: string): string {
  return `microsoft-${uuid.trim().toLowerCase()}`;
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
    typeof value.uuid === "string" && value.uuid.trim()
      ? value.uuid
      : "00000000-0000-0000-0000-000000000000";
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
    skinUrl: typeof value.skinUrl === "string" && value.skinUrl.trim() ? value.skinUrl : null,
    expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : null,
    addedAt: typeof value.addedAt === "number" ? value.addedAt : Date.now()
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
  return {
    id: createSessionId(),
    type: "offline",
    username: username.trim() || "Player",
    uuid: "00000000-0000-0000-0000-000000000000",
    accessToken: "offline",
    refreshToken: null,
    xuid: null,
    skinUrl: null,
    expiresAt: null,
    addedAt: Date.now()
  };
}

export function resolveMinecraftLaunchIdentity(
  account: MinecraftAccount | null,
  fallbackPlayerName: string
): { playerName: string; uuid: string; accessToken: string } {
  const fallbackName = fallbackPlayerName.trim() || "Player";
  if (!account) {
    return {
      playerName: fallbackName,
      uuid: "00000000-0000-0000-0000-000000000000",
      accessToken: "offline"
    };
  }
  if (account.type === "microsoft") {
    if (!account.uuid.trim() || !account.accessToken.trim()) {
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
    uuid: account.uuid || "00000000-0000-0000-0000-000000000000",
    accessToken: account.accessToken || "offline"
  };
}

export async function refreshMinecraftAccount(
  refreshToken: string,
  ipcSession?: string
): Promise<MinecraftAccount> {
  return invoke<MinecraftAccount>("refresh_minecraft_account", { refreshToken, ipcSession });
}
