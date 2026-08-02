import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STORAGE_KEYS } from "../constants";
import {
  createOfflineMinecraftAccount,
  loadSelectedMinecraftAccountId,
  normalizeMinecraftAccount
} from "../lib/minecraftAccount";
import { persistSecureJson } from "../utils/secureStorage";
import type { MinecraftAccount } from "../types";

type UseMinecraftAccountsDeps = {
  secureStorageReady: boolean;
  playerName: string;
  setPlayerName: (name: string) => void;
};

export type MinecraftAccountsController = {
  accounts: MinecraftAccount[];
  setAccounts: React.Dispatch<React.SetStateAction<MinecraftAccount[]>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  currentAccount: MinecraftAccount | null;
  addOffline: (username: string) => void;
  save: (account: MinecraftAccount) => void;
  remove: (accountId: string) => void;
};

// Owns the local Minecraft account list, selection, persistence, and keeping
// the player name in sync with the active account. (Launch-time token refresh
// stays in the launch flow.)
export function useMinecraftAccounts(deps: UseMinecraftAccountsDeps): MinecraftAccountsController {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [accounts, setAccounts] = useState<MinecraftAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => loadSelectedMinecraftAccountId());

  const currentAccount = useMemo(() => {
    if (accounts.length === 0) {
      return null;
    }
    return accounts.find((item) => item.id === selectedId) ?? accounts[0];
  }, [accounts, selectedId]);

  const addOffline = useCallback((username: string) => {
    const normalizedName = username.trim();
    if (!normalizedName) {
      return;
    }
    setAccounts((prev) => {
      const existing = prev.find(
        (account) =>
          account.type === "offline" &&
          account.username.localeCompare(normalizedName, undefined, { sensitivity: "accent" }) === 0
      );
      const nextAccount = existing ?? createOfflineMinecraftAccount(normalizedName);
      setSelectedId(nextAccount.id);
      depsRef.current.setPlayerName(normalizedName);
      return existing ? prev : [nextAccount, ...prev];
    });
  }, []);

  const save = useCallback((account: MinecraftAccount) => {
    const normalizedAccount = normalizeMinecraftAccount(account) ?? account;
    setAccounts((prev) => {
      const next = [...prev];
      const existingIndex = next.findIndex(
        (item) =>
          item.id === normalizedAccount.id ||
          (item.type === "microsoft" &&
            normalizedAccount.type === "microsoft" &&
            item.uuid.trim().toLowerCase() === normalizedAccount.uuid.trim().toLowerCase())
      );
      if (existingIndex >= 0) {
        next[existingIndex] = { ...next[existingIndex], ...normalizedAccount };
        return next;
      }
      return [normalizedAccount, ...next];
    });
    setSelectedId(normalizedAccount.id);
    depsRef.current.setPlayerName(normalizedAccount.username);
  }, []);

  const remove = useCallback((accountId: string) => {
    setAccounts((prev) => {
      const next = prev.filter((account) => account.id !== accountId);
      if (next.length > 0) {
        if (selectedIdRef.current === accountId) {
          const fallback = next[0];
          setSelectedId(fallback.id);
          depsRef.current.setPlayerName(fallback.username);
        }
        return next;
      }
      setSelectedId(null);
      depsRef.current.setPlayerName("");
      return next;
    });
  }, []);

  // keep latest selectedId for the remove closure without re-creating it
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // Persist accounts (secure) + selected id (local).
  useEffect(() => {
    if (!deps.secureStorageReady) return;
    void persistSecureJson(STORAGE_KEYS.minecraftAccounts, accounts).catch((error) => {
      console.warn("[secure-storage] failed to persist minecraftAccounts:", error);
    });
  }, [accounts, deps.secureStorageReady]);

  useEffect(() => {
    if (selectedId) {
      localStorage.setItem(STORAGE_KEYS.selectedMinecraftAccount, selectedId);
      return;
    }
    localStorage.removeItem(STORAGE_KEYS.selectedMinecraftAccount);
  }, [selectedId]);

  // Keep the selection valid, but leave an empty list intact so the UI can require
  // the user to create the first Minecraft profile instead of inventing one.
  useEffect(() => {
    if (accounts.length === 0) {
      if (selectedId !== null) {
        setSelectedId(null);
      }
      return;
    }
    if (!selectedId || !accounts.some((item) => item.id === selectedId)) {
      setSelectedId(accounts[0].id);
    }
  }, [accounts, selectedId]);

  // Mirror the active account's name into the player name setting.
  useEffect(() => {
    const nextPlayerName = currentAccount?.username?.trim();
    if (nextPlayerName && nextPlayerName !== depsRef.current.playerName) {
      depsRef.current.setPlayerName(nextPlayerName);
    }
  }, [currentAccount?.username]);

  return { accounts, setAccounts, selectedId, setSelectedId, currentAccount, addOffline, save, remove };
}
