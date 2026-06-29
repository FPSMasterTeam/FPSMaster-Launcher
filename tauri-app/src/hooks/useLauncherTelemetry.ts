import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LAUNCHER_API_BASE_URL } from "../constants";
import type { TranslationKey } from "../i18n";
import { isAuthExpiredError } from "../lib/launcherError";
import { loadOrCreateLauncherSessionId } from "../lib/launcherAuth";
import { nextRecurringDelay } from "../lib/system";
import type { TelemetryOnlineSummary } from "../types";

const ONLINE_REFRESH_INTERVAL_MS = 90_000;
const ONLINE_REFRESH_JITTER_MS = 8_000;

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;
type SessionUser = { id?: string | null; username?: string | null };

type UseLauncherTelemetryDeps = {
  token: string | null;
  user: SessionUser | null;
  playerName: string;
  backgroundMode: boolean;
  t: Translator;
  onAuthExpired: (message: string) => void;
};

export type LauncherTelemetryController = {
  onlineSummary: TelemetryOnlineSummary | null;
  setOnlineSummary: (summary: TelemetryOnlineSummary | null) => void;
  cacheSession: (sessionUser?: SessionUser) => Promise<void>;
  flushSession: () => Promise<void>;
};

// Owns telemetry: launcher session caching, online-presence heartbeat, and the
// polled online-summary used on the home page.
export function useLauncherTelemetry(deps: UseLauncherTelemetryDeps): LauncherTelemetryController {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [onlineSummary, setOnlineSummary] = useState<TelemetryOnlineSummary | null>(null);
  const sessionIdRef = useRef(loadOrCreateLauncherSessionId());
  const authTokenRef = useRef<string | null>(deps.token?.trim() ?? null);

  const buildSession = useCallback((sessionUser?: SessionUser) => {
    const { user, playerName } = depsRef.current;
    const effectiveUser = sessionUser ?? user ?? null;
    return {
      baseUrl: LAUNCHER_API_BASE_URL,
      clientName: "fpsmaster-launcher",
      clientKind: "LAUNCHER",
      sessionId: sessionIdRef.current,
      username: effectiveUser?.username ?? playerName,
      playerUuid: effectiveUser?.id ?? null
    };
  }, []);

  const cacheSession = useCallback(
    async (sessionUser?: SessionUser) => {
      try {
        await invoke("launcher_cache_telemetry_session", { session: buildSession(sessionUser) });
      } catch {
        // best-effort
      }
    },
    [buildSession]
  );

  const flushSession = useCallback(async () => {
    try {
      await invoke("launcher_offline_telemetry_session");
    } catch {
      // best-effort
    }
  }, []);

  const fetchOnlineSummary = useCallback(async (): Promise<TelemetryOnlineSummary> => {
    const response = await fetch(`${LAUNCHER_API_BASE_URL}/api/v1/telemetry/online?clientKind=LAUNCHER`);
    const raw = (await response.json()) as {
      success?: boolean;
      message?: string;
      data?: TelemetryOnlineSummary;
    };
    if (!response.ok || raw.success === false || !raw.data) {
      throw new Error(raw.message || `online summary failed with HTTP ${response.status}`);
    }
    return raw.data;
  }, []);

  // Cache the session when signing in; flush it when signing out.
  const { token, user, playerName, backgroundMode, t, onAuthExpired } = deps;
  useEffect(() => {
    const currentToken = token?.trim() ?? null;
    const previousToken = authTokenRef.current;
    if (!currentToken) {
      if (previousToken) {
        void flushSession();
      }
      authTokenRef.current = null;
      return;
    }
    void cacheSession();
    authTokenRef.current = currentToken;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user?.id, user?.username, playerName]);

  // Heartbeat + polled online summary while authenticated and visible.
  useEffect(() => {
    const activeToken = token?.trim();
    if (!activeToken) {
      setOnlineSummary(null);
      return;
    }
    let active = true;

    const startHeartbeat = async () => {
      try {
        await invoke("start_launcher_heartbeat");
      } catch (error) {
        if (active && isAuthExpiredError(error)) {
          onAuthExpired(t("login.sessionExpired"));
        }
      }
    };

    const loadOnline = async () => {
      if (backgroundMode) return;
      try {
        const summary = await fetchOnlineSummary();
        if (active) setOnlineSummary(summary);
      } catch (error) {
        if (active && isAuthExpiredError(error)) {
          onAuthExpired(t("login.sessionExpired"));
          return;
        }
        if (active) setOnlineSummary(null);
      }
    };

    let onlineTimer: number | null = null;
    const scheduleOnlineRefresh = () => {
      onlineTimer = window.setTimeout(async () => {
        await loadOnline();
        if (active && !backgroundMode) {
          scheduleOnlineRefresh();
        }
      }, nextRecurringDelay(ONLINE_REFRESH_INTERVAL_MS, ONLINE_REFRESH_JITTER_MS));
    };

    void startHeartbeat();
    if (!backgroundMode) {
      void loadOnline();
      scheduleOnlineRefresh();
    }

    return () => {
      active = false;
      invoke("stop_launcher_heartbeat").catch(() => {});
      if (onlineTimer !== null) {
        window.clearTimeout(onlineTimer);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user?.username, backgroundMode]);

  return { onlineSummary, setOnlineSummary, cacheSession, flushSession };
}
