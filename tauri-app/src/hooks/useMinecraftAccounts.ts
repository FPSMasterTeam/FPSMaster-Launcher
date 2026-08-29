import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STORAGE_KEYS } from "../constants";
import type { TranslationKey } from "../i18n";
import {
  createOfflineMinecraftAccount,
  loadSelectedMinecraftAccountId,
  MICROSOFT_REFRESH_MARGIN_MS,
  normalizeMinecraftAccount,
  refreshMinecraftAccount,
  shouldRefreshMicrosoftAccount
} from "../lib/minecraftAccount";
import { notifyWarning } from "../lib/toast";
import { persistSecureJson } from "../utils/secureStorage";
import type { MinecraftAccount } from "../types";

type UseMinecraftAccountsDeps = {
  secureStorageReady: boolean;
  playerName: string;
  setPlayerName: (name: string) => void;
  t: (key: TranslationKey, values?: Record<string, string | number>) => string;
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
  /**
   * Refreshes a Microsoft account's tokens through the backend. Concurrent calls
   * for the same account share one request. On success the stored account is
   * updated in place (tokens, expiry, username, uuid, skin) without stealing the
   * selection; on failure the account is kept and flagged `needsRelogin`, and the
   * error is rethrown for the caller to surface.
   */
  refreshMicrosoftAccount: (accountId: string, ipcSession?: string) => Promise<MinecraftAccount>;
};

// How often the background scheduler re-checks upcoming expirations. Tokens are
// refreshed MICROSOFT_REFRESH_MARGIN_MS before expiry, so a one-minute cadence
// keeps the refresh inside the 5-10 minute pre-expiry window.
const AUTO_REFRESH_CHECK_INTERVAL_MS = 60_000;
// After a failed background refresh, leave the account alone for a while instead
// of hammering the token endpoint (the launch flow may still retry explicitly).
const AUTO_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60_000;

// Owns the local Minecraft account list, selection, persistence, keeping the
// player name in sync with the active account, and keeping Microsoft sessions
// alive (startup validation, pre-expiry refresh, refresh on account selection).
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

  // keep latest accounts/selection for stable callbacks without re-creating them
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const inFlightRefreshRef = useRef(new Map<string, Promise<MinecraftAccount>>());
  const lastRefreshFailureAtRef = useRef(new Map<string, number>());

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
        next[existingIndex] = {
          ...next[existingIndex],
          ...normalizedAccount,
          // A login/refresh may come back without a skin (Mojang hiccup); keep the
          // last known one rather than dropping the avatar.
          skinUrl: normalizedAccount.skinUrl ?? next[existingIndex].skinUrl ?? null
        };
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

  // Merges a refreshed backend payload into the stored account. Unlike `save`,
  // this never changes the selection or player name: background refreshes of
  // non-selected accounts must be invisible.
  const applyRefreshedAccount = useCallback((refreshed: MinecraftAccount) => {
    const normalized = normalizeMinecraftAccount(refreshed) ?? refreshed;
    setAccounts((prev) =>
      prev.map((item) => {
        const matches =
          item.id === normalized.id ||
          (item.type === "microsoft" &&
            normalized.type === "microsoft" &&
            item.uuid.trim().toLowerCase() === normalized.uuid.trim().toLowerCase());
        if (!matches) {
          return item;
        }
        return {
          ...item,
          ...normalized,
          // Keep the stored id and creation time stable so selection and ordering
          // survive refreshes even for accounts saved with legacy id shapes.
          id: item.id,
          addedAt: item.addedAt,
          skinUrl: normalized.skinUrl ?? item.skinUrl ?? null,
          needsRelogin: false
        };
      })
    );
  }, []);

  const markNeedsRelogin = useCallback((accountId: string) => {
    setAccounts((prev) =>
      prev.map((item) =>
        item.id === accountId && item.type === "microsoft" && !item.needsRelogin
          ? { ...item, needsRelogin: true }
          : item
      )
    );
  }, []);

  const refreshMicrosoftAccount = useCallback(
    (accountId: string, ipcSession?: string): Promise<MinecraftAccount> => {
      const inFlight = inFlightRefreshRef.current.get(accountId);
      if (inFlight) {
        return inFlight;
      }
      const account = accountsRef.current.find((item) => item.id === accountId);
      if (!account || account.type !== "microsoft") {
        return Promise.reject(new Error(depsRef.current.t("minecraftAccount.requiredError")));
      }
      const refreshToken = account.refreshToken?.trim();
      if (!refreshToken) {
        markNeedsRelogin(accountId);
        return Promise.reject(
          new Error(depsRef.current.t("minecraftAccount.microsoftRefreshRequired"))
        );
      }
      const task = refreshMinecraftAccount(refreshToken, ipcSession)
        .then((refreshed) => {
          lastRefreshFailureAtRef.current.delete(accountId);
          applyRefreshedAccount(refreshed);
          return refreshed;
        })
        .catch((error: unknown) => {
          lastRefreshFailureAtRef.current.set(accountId, Date.now());
          markNeedsRelogin(accountId);
          throw error;
        })
        .finally(() => {
          inFlightRefreshRef.current.delete(accountId);
        });
      inFlightRefreshRef.current.set(accountId, task);
      return task;
    },
    [applyRefreshedAccount, markNeedsRelogin]
  );

  // One refresh sweep. `includeFlagged` re-tries accounts already marked
  // needs-relogin; `onlyAccountId` scopes account-switch checks to the account
  // the user actually selected.
  const runAutoRefreshSweep = useCallback(
    (includeFlagged: boolean, onlyAccountId?: string) => {
      if (!depsRef.current.secureStorageReady) {
        return;
      }
      const now = Date.now();
      for (const account of accountsRef.current) {
        if (account.type !== "microsoft") continue;
        if (onlyAccountId && account.id !== onlyAccountId) continue;
        if (
          !account.needsRelogin &&
          !shouldRefreshMicrosoftAccount(account, MICROSOFT_REFRESH_MARGIN_MS, now)
        ) {
          continue;
        }
        if (!account.refreshToken?.trim()) {
          markNeedsRelogin(account.id);
          continue;
        }
        if (!includeFlagged && account.needsRelogin) continue;
        const failedAt = lastRefreshFailureAtRef.current.get(account.id);
        if (
          !includeFlagged &&
          failedAt !== undefined &&
          now - failedAt < AUTO_REFRESH_FAILURE_COOLDOWN_MS
        ) {
          continue;
        }
        void refreshMicrosoftAccount(account.id).catch(() => {
          notifyWarning(
            depsRef.current.t("minecraftAccount.refreshFailed", { name: account.username })
          );
        });
      }
    },
    [markNeedsRelogin, refreshMicrosoftAccount]
  );

  // Validate + refresh Microsoft sessions once accounts land from secure storage.
  const startupSweepDoneRef = useRef(false);
  useEffect(() => {
    if (!deps.secureStorageReady || startupSweepDoneRef.current) {
      return;
    }
    startupSweepDoneRef.current = true;
    runAutoRefreshSweep(true);
  }, [deps.secureStorageReady, runAutoRefreshSweep]);

  // Pre-expiry refresh: periodically look for sessions entering the refresh margin.
  useEffect(() => {
    if (!deps.secureStorageReady) {
      return;
    }
    const timer = window.setInterval(
      () => runAutoRefreshSweep(false),
      AUTO_REFRESH_CHECK_INTERVAL_MS
    );
    return () => window.clearInterval(timer);
  }, [deps.secureStorageReady, runAutoRefreshSweep]);

  // Refresh when the user switches to a Microsoft account that needs it, so the
  // picked account is ready before launch instead of failing at launch time.
  const currentAccountId = currentAccount?.id ?? null;
  const accountSwitchReadyRef = useRef(false);
  useEffect(() => {
    if (!deps.secureStorageReady || !currentAccountId) {
      return;
    }
    // The startup sweep already covers the initially restored selection. Waiting
    // for the next id change also avoids attaching duplicate failure toasts to the
    // same shared refresh promise during initialization.
    if (!accountSwitchReadyRef.current) {
      accountSwitchReadyRef.current = true;
      return;
    }
    runAutoRefreshSweep(true, currentAccountId);
  }, [deps.secureStorageReady, currentAccountId, runAutoRefreshSweep]);

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

  return {
    accounts,
    setAccounts,
    selectedId,
    setSelectedId,
    currentAccount,
    addOffline,
    save,
    remove,
    refreshMicrosoftAccount
  };
}
