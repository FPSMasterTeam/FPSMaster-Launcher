import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LAUNCHER_API_BASE_URL } from "../constants";
import type { TranslationKey } from "../i18n";
import { formatLaunchError, isAuthExpiredError } from "../lib/launcherError";
import type {
  LauncherDashboard,
  LauncherHomePayload,
  LauncherUser,
  NewsItem,
  ServerItem,
  TelemetryOnlineSummary
} from "../types";

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

type UseLauncherDataDeps = {
  token: string | null;
  t: Translator;
  setStatus: (status: string) => void;
  onAuthExpired: (message: string) => void;
  onMergeUser: (user: Partial<LauncherUser>) => void;
  setOnlineSummary: (summary: TelemetryOnlineSummary | null) => void;
};

export type LauncherDataController = {
  news: NewsItem[];
  servers: ServerItem[];
  dashboard: LauncherDashboard | null;
  refreshHome: (silent?: boolean, tokenOverride?: string) => Promise<void>;
  refreshNews: (silent?: boolean) => Promise<void>;
  refreshServers: (silent?: boolean) => Promise<void>;
  refreshDashboard: (silent?: boolean, tokenOverride?: string) => Promise<void>;
  clearDashboard: () => void;
};

// Owns launcher backend "display data": news, servers, dashboard, and the
// batched home payload. Shared concerns (online summary, the auth user merge,
// session-expiry handling) are injected so this hook stays free of the auth
// domain it would otherwise be circularly tied to.
export function useLauncherData(deps: UseLauncherDataDeps): LauncherDataController {
  // Keep deps in a ref so the returned callbacks have stable identities while
  // always reading the latest values (avoids stale closures + re-render churn).
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [news, setNews] = useState<NewsItem[]>([]);
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [dashboard, setDashboard] = useState<LauncherDashboard | null>(null);

  const refreshHome = useCallback(async (silent = false, tokenOverride?: string) => {
    const { token, t, setStatus, onAuthExpired, onMergeUser, setOnlineSummary } = depsRef.current;
    const activeToken = (tokenOverride ?? token ?? "").trim();
    try {
      const payload = await invoke<LauncherHomePayload>("launcher_get_home", {
        baseUrl: LAUNCHER_API_BASE_URL,
        token: activeToken || null
      });
      setNews(payload.news ?? []);
      setServers(payload.servers ?? []);
      setOnlineSummary(payload.online ?? null);
      if (payload.dashboard) {
        setDashboard(payload.dashboard);
        onMergeUser(payload.dashboard.user ?? {});
      } else if (!activeToken) {
        setDashboard(null);
      }
      if (!silent) {
        setStatus(t("app.status.ready"));
      }
    } catch (error) {
      const errorText = formatLaunchError(error);
      if (activeToken && isAuthExpiredError(error)) {
        onAuthExpired(t("login.sessionExpired"));
        return;
      }
      if (!activeToken) {
        setNews([]);
        setServers([]);
        setOnlineSummary(null);
      }
      if (!silent) {
        setStatus(t("app.status.failed", { error: errorText }));
      }
    }
  }, []);

  const refreshNews = useCallback(async (silent = false) => {
    const { t, setStatus } = depsRef.current;
    try {
      const items = await invoke<NewsItem[]>("launcher_list_news", {
        baseUrl: LAUNCHER_API_BASE_URL,
        limit: 4
      });
      if (items.length > 0) {
        setNews(items);
        if (!silent) {
          setStatus(t("app.status.loadedLauncherNews", { count: items.length }));
        }
      } else {
        setNews([]);
      }
    } catch (error) {
      setNews([]);
      if (!silent) {
        setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
      }
    }
  }, []);

  const refreshServers = useCallback(async (silent = false) => {
    const { token, t, setStatus } = depsRef.current;
    try {
      const activeToken = (token ?? "").trim();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (activeToken) {
        headers["Authorization"] = `Bearer ${activeToken}`;
      }
      const response = await fetch(`${LAUNCHER_API_BASE_URL}/api/v1/launcher/servers`, { headers });
      const raw = await response.json();
      const data = (raw as { success?: boolean; data?: ServerItem[] })?.data ?? [];
      setServers(data);
      if (!silent) {
        setStatus(t("app.status.loadedServers", { count: data.length }));
      }
    } catch (error) {
      if (!silent) {
        setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
      }
    }
  }, []);

  const refreshDashboard = useCallback(async (silent = false, tokenOverride?: string) => {
    const { token, t, setStatus, onAuthExpired, onMergeUser } = depsRef.current;
    const activeToken = (tokenOverride ?? token ?? "").trim();
    if (!activeToken) {
      setDashboard(null);
      return;
    }
    try {
      const item = await invoke<LauncherDashboard>("launcher_get_dashboard", {
        baseUrl: LAUNCHER_API_BASE_URL,
        token: activeToken
      });
      setDashboard(item);
      onMergeUser(item.user ?? {});
      if (!silent) {
        setStatus(t("app.status.ready"));
      }
    } catch (error) {
      const errorText = formatLaunchError(error);
      if (activeToken && isAuthExpiredError(error)) {
        onAuthExpired(t("login.sessionExpired"));
        return;
      }
      setDashboard(null);
      if (!silent) {
        setStatus(t("app.status.failed", { error: errorText }));
      }
    }
  }, []);

  const clearDashboard = useCallback(() => setDashboard(null), []);

  return { news, servers, dashboard, refreshHome, refreshNews, refreshServers, refreshDashboard, clearDashboard };
}
