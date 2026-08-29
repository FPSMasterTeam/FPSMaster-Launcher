import { getVersion as getAppVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import packageInfo from "../package.json";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppBackground, { BACKGROUND_VIDEO_STATE_EVENT } from "./components/AppBackground";
import Button from "./components/Button";
import InstallDialog from "./components/InstallDialog";
import LaunchErrorDialog from "./components/LaunchErrorDialog";
import LaunchPrepareDialog from "./components/LaunchPrepareDialog";
import Sidebar from "./components/Sidebar";
import ToastViewport from "./components/ToastViewport";
import WindowTitleBar from "./components/WindowTitleBar";
import {
  DEFAULT_LOGIN_PREFS,
  DEFAULT_SETTINGS,
  LAUNCHER_API_BASE_URL,
  NEWS_ITEMS,
  NOVA_DEFAULT_GAME_VERSION,
  PRESET_INSTANCES,
  STORAGE_KEYS,
  resolvePresetVersionId
} from "./constants";
import {
  createTranslator,
  I18nProvider,
  resolveLocale
} from "./i18n";
import {
  mapLaunchPreparePhaseKey,
  mergePhaseByteProgress,
  parseLaunchPrepareJdkLog,
  parseLaunchProgressLog,
  reduceLaunchPrepareItems,
  translateLaunchPrepareMessage,
  upsertLaunchPrepareLogItem
} from "./lib/launchPrepare";
import { isLauncherVersionCompatible } from "./lib/version";
import {
  describeApiError,
  isAuthExpiredError,
  normalizeLoginError
} from "./lib/launcherError";
import { notifyError, notifyWarning } from "./lib/toast";
import {
  parseMinecraftAccounts,
  resolveMinecraftLaunchIdentity,
  shouldRefreshMicrosoftAccount
} from "./lib/minecraftAccount";
import {
  normalizeStoredToken,
  parseLauncherAuthState,
  parseLauncherLoginPrefs,
  readStoredLocale
} from "./lib/launcherAuth";
import {
  createDuplicatedInstanceName,
  createDuplicatedVersionId,
  isLegacyDefaultGameDir,
  loaderLabelKey
} from "./lib/instance";
import { ensureJdk, openMonitor, syncAutostart, syncTrayBehavior } from "./lib/system";
import { createPresetPackageStatus, resolvePresetAccessState } from "./lib/presetPackage";
import { buildNovaEffectiveInstance, NOVA_VERSION_ID_PREFIX } from "./lib/novaTargets";
import { useLauncherUpdate } from "./hooks/useLauncherUpdate";
import { useLauncherData } from "./hooks/useLauncherData";
import { useLauncherTelemetry } from "./hooks/useLauncherTelemetry";
import { useMinecraftAccounts } from "./hooks/useMinecraftAccounts";
import { useInstallController } from "./hooks/useInstallController";
import PageRouter, { type PageRouterContext } from "./components/PageRouter";
// Login is the unauthenticated screen and Monitor is its own window route, so
// they live in App directly. Every routed page is owned by PageRouter (each in
// its own lazily-loaded chunk).
import LoginPage from "./pages/Login";
const MonitorPage = lazy(() => import("./pages/Monitor"));
import type {
  EdgeAotInstallResult,
  FabricInstallResult,
  ForgeInstallResult,
  GameRuntimeStats,
  InstalledContentItem,
  InstalledContentUpdate,
  InstallDialogState,
  InstallIpcEvent,
  InstallResult,
  InstallPhaseState,
  Instance,
  InstanceExportResult,
  InstanceRepairResult,
  LaunchPrepareDialogState,
  LaunchPreparePhaseKey,
  LaunchPreparePhaseState,
  LauncherAuthState,
  LauncherVersionMap,
  LauncherLoginResult,
  LauncherModsInstallResult,
  LauncherPackageState,
  LauncherVersion,
    LauncherLoginPrefs,
    Locale,
    LaunchExecutionResult,
  Loader,
  MinecraftAccount,
  ModpackInstallResult,
  OptiFineInstallResult,
  OptiFineVersion,
    Page,
  PresetPackageStatus,
  Settings,
  UiLogPollResult
} from "./types";
import {
  clamp,
  createPhaseState,
  createLaunchPrepareDialogState,
  createSessionId,
  applyTheme,
  applyVisualSettings,
  loadInstances,
  loadSettings,
  parseInstallIpc,
  resolveBackgroundAssetUrl,
  resolveBackgroundVideoUrl,
  resolveInstallVersion
} from "./utils/launcher";
import { loadSecureRaw, persistSecureJson } from "./utils/secureStorage";

const FALLBACK_LAUNCHER_VERSION = packageInfo.version;
const LAUNCHER_LOG_POLL_INTERVAL_MS = 500;
const LAUNCHER_RUNTIME_POLL_INTERVAL_MS = 1000;
const LAUNCH_PREPARE_STEPS = 5;

// EDGE re-resolves the latest Forge/OptiFine online on every launch. Cache those
// lookups for the app session so repeat launches don't pay the network round-trip
// each time, while still re-checking periodically to keep the "always latest" intent.
const EDGE_LOADER_CACHE_TTL_MS = 30 * 60 * 1000;
const edgeLoaderListCache = new Map<string, { at: number; value: unknown }>();

async function cachedLoaderLookup<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = edgeLoaderListCache.get(key);
  if (hit && Date.now() - hit.at < EDGE_LOADER_CACHE_TTL_MS) {
    return hit.value as T;
  }
  const value = await run();
  edgeLoaderListCache.set(key, { at: Date.now(), value });
  return value;
}

const EMPTY_LAUNCHER_VERSIONS: LauncherVersionMap = {
  EDGE: null,
  NOVA: null,
  EXTREME: null
};

// Nova exposes several Minecraft game versions under one product. We keep the catalog's latest
// entry per game version keyed by the MC version string (e.g. "1.21.11" -> LauncherVersion).
type NovaVersionMap = Record<string, LauncherVersion>;

// Prefer the recommended game version, else the default (1.21.11) if present, else the newest key.
function preferredNovaGameVersion(novaMap: NovaVersionMap): string | null {
  const keys = Object.keys(novaMap);
  if (keys.length === 0) return null;
  const recommended = keys.find((gv) => novaMap[gv]?.recommended);
  if (recommended) return recommended;
  if (novaMap[NOVA_DEFAULT_GAME_VERSION]) return NOVA_DEFAULT_GAME_VERSION;
  return keys[0];
}

// Returns a referentially-stable function that always calls the latest `fn`.
// Lets us hand stable callback props to React.memo children without worrying
// about dependency arrays or stale closures.
function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  return useRef(((...args: Parameters<T>) => ref.current(...args)) as T).current;
}

export function App() {
  useEffect(() => {
    const settings = loadSettings();
    applyTheme(settings.themeMode, settings.themeAccent, settings.customAccentHex);
    applyVisualSettings(
      settings.blurMode,
      settings.cornerRadiusScale,
      settings.glowAmount,
      resolveBackgroundVideoUrl(settings) !== ""
    );
  }, []);

  // The runtime monitor opens as its own webview window pointed at
  // `/?view=monitor&...` (see openMonitor in lib/system.ts).
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "monitor") {
    const locale = resolveLocale(params.get("lang") ?? readStoredLocale());
    return (
      <I18nProvider locale={locale} onLocaleChange={() => {}}>
        <Suspense fallback={<PageFallback />}>
          <MonitorPage params={params} />
        </Suspense>
      </I18nProvider>
    );
  }
  return <Launcher />;
}

function Launcher() {
  const [page, setPage] = useState<Page>("home");
  const [instances, setInstances] = useState<Instance[]>(loadInstances);
  const [selected, setSelected] = useState<string>(
    localStorage.getItem(STORAGE_KEYS.selected) ?? PRESET_INSTANCES[0].id
  );
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [launcherAuth, setLauncherAuth] = useState<LauncherAuthState | null>(null);
  const [launcherLoginPrefs, setLauncherLoginPrefs] = useState<LauncherLoginPrefs>(DEFAULT_LOGIN_PREFS);
  const [secureStorageReady, setSecureStorageReady] = useState(false);
  const [secureStorageError, setSecureStorageError] = useState<string | null>(null);
  const [launcherVersions, setLauncherVersions] = useState<LauncherVersionMap>(EMPTY_LAUNCHER_VERSIONS);
  const [novaGameVersions, setNovaGameVersions] = useState<NovaVersionMap>({});
  const [selectedNovaGameVersion, setSelectedNovaGameVersion] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.selectedNovaGameVersion) ?? NOVA_DEFAULT_GAME_VERSION
  );
  const [currentLauncherVersion, setCurrentLauncherVersion] = useState(FALLBACK_LAUNCHER_VERSION);
  const [presetPackageStatuses, setPresetPackageStatuses] = useState<Record<string, PresetPackageStatus>>({});
  const [launcherAuthLoading, setLauncherAuthLoading] = useState(false);
  const [launcherVersionLoading, setLauncherVersionLoading] = useState(false);
  const [defaultGameDir, setDefaultGameDir] = useState(() => DEFAULT_SETTINGS.gameDir);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(() =>
    createTranslator(loadSettings().language)("app.status.ready")
  );
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [activeGamePid, setActiveGamePid] = useState<number | null>(null);
  const [launchingInstanceId, setLaunchingInstanceId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchProgressPercent, setLaunchProgressPercent] = useState<number | null>(null);
  const [launchProgressText, setLaunchProgressText] = useState("");
  const [monitorWindowOpen, setMonitorWindowOpen] = useState(false);

  const [installDialog, setInstallDialog] = useState<InstallDialogState | null>(null);
  const [launchPrepareDialog, setLaunchPrepareDialog] = useState<LaunchPrepareDialogState | null>(null);
  const [windowVisible, setWindowVisible] = useState(false);
  const autoLoginAttemptedRef = useRef(false);
  const [minecraftAccountPromptOpen, setMinecraftAccountPromptOpen] = useState(false);

  const logCursorRef = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const launchingInstanceRef = useRef<string | null>(null);
  const installDialogRef = useRef<InstallDialogState | null>(null);
  const launchPrepareDialogRef = useRef<LaunchPrepareDialogState | null>(null);

  const t = useMemo(() => createTranslator(settings.language), [settings.language]);

  // `status` is not rendered anywhere in the shell, so on its own it swallows
  // every failure. Anything the user explicitly triggered goes through here so
  // it also reaches a toast.
  const reportFailure = useCallback(
    (error: unknown) => {
      const errorText = describeApiError(error, t);
      setStatus(t("app.status.failed", { error: errorText }));
      notifyError(errorText, t("toast.title.requestFailed"));
    },
    [t]
  );

  const backgroundMode = settings.minimizeToTray && !windowVisible;
  const telemetry = useLauncherTelemetry({
    token: launcherAuth?.token ?? null,
    user: launcherAuth?.user ?? null,
    playerName: settings.playerName,
    backgroundMode,
    t,
    onAuthExpired: handleAuthExpired
  });
  const launcherUpdate = useLauncherUpdate({
    token: launcherAuth?.token ?? null,
    channel: settings.launcherUpdateChannel,
    currentLauncherVersion,
    t,
    setStatus,
    flushTelemetry: telemetry.flushSession
  });
  const launcherData = useLauncherData({
    token: launcherAuth?.token ?? null,
    t,
    setStatus,
    onAuthExpired: handleAuthExpired,
    onMergeUser: (user) =>
      setLauncherAuth((prev) => (prev ? { ...prev, user: { ...prev.user, ...user } } : prev)),
    setOnlineSummary: telemetry.setOnlineSummary
  });
  const launcherMandatoryUpdateRequired = launcherUpdate.mandatoryRequired;
  const mcAccounts = useMinecraftAccounts({
    secureStorageReady,
    playerName: settings.playerName,
    setPlayerName: (name) => setSettings((prev) => ({ ...prev, playerName: name })),
    t
  });

  // For Nova, expose the version-specialised profile so Settings/Content hit FPSMaster-Nova-<gv>.
  const current = useMemo(() => {
    const base = instances.find((item) => item.id === selected) ?? instances[0] ?? null;
    if (!base) return null;
    return buildNovaEffectiveInstance(base, selectedNovaGameVersion || base.baseVersion);
  }, [instances, selected, selectedNovaGameVersion]);
  const activeBackgroundUrl =
    resolveBackgroundAssetUrl(settings);
  const activeBackgroundVideoUrl = resolveBackgroundVideoUrl(settings);
  const authenticated = Boolean(launcherAuth?.token?.trim());
  const launching = busy && launchingInstanceId !== null;
  const loaderDisplayName = (value: Loader) => t(loaderLabelKey(value));
  const installCtl = useInstallController({ page, busy, settings, t, setStatus });

  function ensureMandatoryLauncherUpdate(): boolean {
    if (!launcherMandatoryUpdateRequired) {
      return false;
    }
    setPage("mandatory-update");
    setStatus(t("settings.launcherUpdateMandatory"));
    return true;
  }

  function navigatePage(nextPage: Page) {
    if (launcherMandatoryUpdateRequired && nextPage !== "mandatory-update") {
      setPage("mandatory-update");
      setStatus(t("settings.launcherUpdateMandatory"));
      return;
    }
    setPage(nextPage);
  }

  useEffect(() => {
    getAppVersion()
      .then((version) => {
        const normalizedVersion = version.trim();
        if (normalizedVersion) {
          setCurrentLauncherVersion(normalizedVersion);
        }
      })
      .catch(() => {
        setCurrentLauncherVersion(FALLBACK_LAUNCHER_VERSION);
      });
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.instances, JSON.stringify(instances));
  }, [instances]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [authRaw, prefsRaw, accountsRaw] = await Promise.all([
          loadSecureRaw(STORAGE_KEYS.launcherAuth),
          loadSecureRaw(STORAGE_KEYS.launcherLoginPrefs),
          loadSecureRaw(STORAGE_KEYS.minecraftAccounts)
        ]);
        if (cancelled) return;
        setLauncherAuth(authRaw === null ? null : parseLauncherAuthState(authRaw));
        setLauncherLoginPrefs(prefsRaw === null ? DEFAULT_LOGIN_PREFS : parseLauncherLoginPrefs(prefsRaw));
        const accounts = accountsRaw === null ? [] : parseMinecraftAccounts(accountsRaw);
        mcAccounts.setAccounts(accounts);
        setSecureStorageReady(true);
      } catch (error) {
        if (cancelled) return;
        setSecureStorageError(String(error));
        window.dispatchEvent(new Event("fpsmaster:loaded"));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!secureStorageReady) return;
    void persistSecureJson(STORAGE_KEYS.launcherAuth, launcherAuth).catch((error) => {
      console.warn("[secure-storage] failed to persist launcherAuth:", error);
    });
  }, [launcherAuth, secureStorageReady]);

  useEffect(() => {
    if (!secureStorageReady) return;
    void persistSecureJson(STORAGE_KEYS.launcherLoginPrefs, launcherLoginPrefs).catch((error) => {
      console.warn("[secure-storage] failed to persist launcherLoginPrefs:", error);
    });
  }, [launcherLoginPrefs, secureStorageReady]);

  useEffect(() => {
    if (secureStorageReady) {
      window.dispatchEvent(new Event("fpsmaster:loaded"));
    }
  }, [secureStorageReady]);

  useEffect(() => {
    if (!launcherAuth?.token) {
      setLauncherVersions(EMPTY_LAUNCHER_VERSIONS);
      setNovaGameVersions({});
      launcherData.clearDashboard();
      telemetry.setOnlineSummary(null);
      setPresetPackageStatuses({});
      setPage("home");
      if (!backgroundMode) {
        void launcherData.refreshHome(true);
      }
      return;
    }
    if (backgroundMode) {
      return;
    }
    void telemetry.cacheSession();
    void refreshLauncherVersions(true);
    void launcherData.refreshHome(true, launcherAuth.token);
  }, [launcherAuth?.token, backgroundMode]);

  useEffect(() => {
    if (launcherMandatoryUpdateRequired && page !== "mandatory-update") {
      setPage("mandatory-update");
      setStatus(t("settings.launcherUpdateMandatory"));
    }
  }, [launcherMandatoryUpdateRequired, page, t]);

  useEffect(() => {
    if (launcherAuth?.token || launcherAuthLoading) {
      return;
    }
    // Only attempt auto-login once per session
    if (autoLoginAttemptedRef.current) {
      return;
    }
    if (!launcherLoginPrefs.autoLogin || !launcherLoginPrefs.rememberPassword) {
      return;
    }
    const identity = launcherLoginPrefs.usernameOrEmail.trim();
    const password = launcherLoginPrefs.password;
    if (!identity || !password) {
      return;
    }
    autoLoginAttemptedRef.current = true;
    void loginLauncherAccount({
      ...launcherLoginPrefs,
      usernameOrEmail: identity,
      password
    }, true);
  }, [launcherAuth?.token, launcherAuthLoading, launcherLoginPrefs]);

  useEffect(() => {
    let disposed = false;
    let unlistenVisibility: (() => void) | undefined;

    const bind = async () => {
      try {
        const currentWindow = getCurrentWindow();
        const visible = await currentWindow.isVisible();
        const publishVisibility = (nextVisible: boolean) => {
          if (disposed) return;
          document.documentElement.setAttribute("data-window-visible", String(nextVisible));
          setWindowVisible(nextVisible);
          window.dispatchEvent(new Event(BACKGROUND_VIDEO_STATE_EVENT));
        };
        publishVisibility(visible);
        unlistenVisibility = await listen<boolean>(
          "fpsmaster://main-window-visibility",
          ({ payload }) => publishVisibility(payload)
        );
      } catch {
      }
    };

    void bind();
    return () => {
      disposed = true;
      if (unlistenVisibility) {
        unlistenVisibility();
      }
    };
  }, []);

  useEffect(() => {
    if (backgroundMode || launcherAuth?.token) {
      return;
    }
    void launcherData.refreshHome(true);
  }, [backgroundMode, launcherAuth?.token]);

  useEffect(() => {
    applyTheme(settings.themeMode, settings.themeAccent, settings.customAccentHex);
  }, [settings.themeMode, settings.themeAccent, settings.customAccentHex]);

  useEffect(() => {
    applyVisualSettings(
      settings.blurMode,
      settings.cornerRadiusScale,
      settings.glowAmount,
      activeBackgroundVideoUrl !== ""
    );
  }, [settings.blurMode, settings.cornerRadiusScale, settings.glowAmount, activeBackgroundVideoUrl]);

  useEffect(() => {
    document.documentElement.setAttribute("data-monitor-open", String(monitorWindowOpen));
    window.dispatchEvent(new Event(BACKGROUND_VIDEO_STATE_EVENT));
  }, [monitorWindowOpen]);

  useEffect(() => {
    if (current) localStorage.setItem(STORAGE_KEYS.selected, current.id);
  }, [current]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.selectedNovaGameVersion, selectedNovaGameVersion);
  }, [selectedNovaGameVersion]);

  useEffect(() => {
    launchingInstanceRef.current = launchingInstanceId;
    if (launchingInstanceId === null) {
      setLaunchProgressPercent(null);
      setLaunchProgressText("");
    }
  }, [launchingInstanceId]);

  useEffect(() => {
    installDialogRef.current = installDialog;
  }, [installDialog]);

  useEffect(() => {
    launchPrepareDialogRef.current = launchPrepareDialog;
  }, [launchPrepareDialog]);

  const shouldPollUiLogs =
    windowVisible &&
    (launchingInstanceId !== null || installDialog !== null || launchPrepareDialog !== null);

  useEffect(() => {
    if (!shouldPollUiLogs) {
      return;
    }
    let active = true;
    const poll = async () => {
      if (!active || pollingRef.current) return;
      pollingRef.current = true;
      try {
        const args = logCursorRef.current === null ? {} : { afterSeq: logCursorRef.current };
        const out = await invoke<UiLogPollResult>("poll_ui_logs", args);
        if (!active) return;
        logCursorRef.current = out.nextSeq;
        if (out.entries.length === 0) return;
        for (const entry of out.entries) {
          if (launchingInstanceRef.current) {
            const launchProgress = parseLaunchProgressLog(entry.message);
            if (launchProgress) {
              setLaunchProgressText(launchProgress.text);
              if (typeof launchProgress.percent === "number") {
                setLaunchProgressPercent(launchProgress.percent);
              }
            }
            applyLaunchPrepareLog(entry.message);
          }
          const ipc = parseInstallIpc(entry.message);
          if (ipc) {
            applyInstallIpc(ipc);
            applyLaunchPrepareIpc(ipc);
          }
        }
      } catch {
      } finally {
        pollingRef.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), LAUNCHER_LOG_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [shouldPollUiLogs, launchingInstanceId, installDialog, launchPrepareDialog]);

  useEffect(() => {
    if (activeGamePid === null || activeGamePid <= 0) return;
    if (!windowVisible) return;
    let active = true;
    const probe = async () => {
      try {
        const runtime = await invoke<GameRuntimeStats>("poll_game_runtime", { pid: activeGamePid });
        if (!active) return;
        if (!runtime.running) {
          setActiveGamePid(null);
        }
      } catch {
        if (!active) return;
        setActiveGamePid(null);
      }
    };

    void probe();
    const timer = window.setInterval(() => void probe(), LAUNCHER_RUNTIME_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeGamePid, windowVisible]);

  useEffect(() => {
    void syncAutostart(settings.launchOnStartup);
  }, [settings.launchOnStartup]);

  useEffect(() => {
    void syncTrayBehavior(settings.minimizeToTray);
  }, [settings.minimizeToTray]);

  useEffect(() => {
    let active = true;
    const loadDefaultGameDir = async () => {
      try {
        const resolved = await invoke<string>("get_default_game_dir");
        if (!active || !resolved) return;
        setDefaultGameDir(resolved);
        setSettings((prev) =>
          isLegacyDefaultGameDir(prev.gameDir) ? { ...prev, gameDir: resolved } : prev
        );
      } catch {
      }
    };
    void loadDefaultGameDir();
    return () => {
      active = false;
    };
  }, []);

  function applyInstallIpc(ipc: InstallIpcEvent) {
    setInstallDialog((prev) => {
      if (!prev || !prev.open) return prev;
      if (ipc.channel !== "install") return prev;
      if (ipc.session !== prev.sessionId) return prev;

      const phaseKey =
        ipc.phase === "vanilla"
          ? "vanilla"
          : prev.loaderPhase && ipc.phase === prev.loaderPhase.sourcePhase
            ? "loaderPhase"
            : null;
      if (!phaseKey) return prev;

      const currentPhase = phaseKey === "vanilla" ? prev.vanilla : prev.loaderPhase;
      if (!currentPhase) return prev;

      const nextPhase: InstallPhaseState = {
        ...currentPhase,
        status:
          ipc.event === "error"
            ? "error"
            : ipc.event === "phase-complete"
              ? "done"
              : ipc.event === "phase-start" || ipc.event === "progress" || ipc.event.startsWith("item-")
                ? "running"
                : currentPhase.status,
        stage: ipc.stage ?? currentPhase.stage,
        message: translateLaunchPrepareMessage(ipc, t) ?? currentPhase.message,
        ...mergePhaseByteProgress(currentPhase, ipc),
        items: reduceLaunchPrepareItems(currentPhase.items, ipc)
      };

      let next = {
        ...prev,
        vanilla: phaseKey === "vanilla" ? nextPhase : prev.vanilla,
        loaderPhase: phaseKey === "loaderPhase" ? nextPhase : prev.loaderPhase
      };

      if (ipc.event === "error") {
        next = {
          ...next,
          canClose: true,
          errorText: ipc.error ?? ipc.message ?? t("dialog.installationFailed")
        };
      }

      return next;
    });
  }

  function applyLaunchPrepareIpc(ipc: InstallIpcEvent) {
    setLaunchPrepareDialog((prev) => {
      if (!prev || !prev.open) return prev;
      if (ipc.channel !== "install" && ipc.channel !== "launch-prepare") return prev;
      if (ipc.session !== prev.sessionId) return prev;

      const phaseKey = mapLaunchPreparePhaseKey(ipc.phase);
      if (!phaseKey) return prev;

      const phaseIndex = prev.phases.findIndex((phase) => phase.key === phaseKey);
      if (phaseIndex < 0) return prev;

      const currentPhase = prev.phases[phaseIndex];
      const nextPhase = {
        ...currentPhase,
        status:
          ipc.event === "error"
            ? "error"
            : ipc.event === "phase-complete"
              ? "done"
              : ipc.event === "phase-start" || ipc.event === "progress" || ipc.event.startsWith("item-")
                ? "running"
                : currentPhase.status,
        stage: ipc.stage ?? currentPhase.stage,
        message: ipc.message ?? currentPhase.message,
        ...mergePhaseByteProgress(currentPhase, ipc),
        items: reduceLaunchPrepareItems(currentPhase.items, ipc)
      } satisfies LaunchPreparePhaseState;

      const nextPhases = prev.phases.map((phase, index) => (index === phaseIndex ? nextPhase : phase));

      let next = {
        ...prev,
        phases: nextPhases
      };

      if (ipc.event === "error") {
        next = {
          ...next,
          canClose: true,
          errorText: ipc.error ?? ipc.message ?? t("dialog.installationFailed")
        };
      }

      return next;
    });
  }

  function applyLaunchPrepareLog(message: string) {
    const jdkProgress = parseLaunchPrepareJdkLog(message);
    if (!jdkProgress) {
      return;
    }

    setLaunchPrepareDialog((prev) => {
      if (!prev || !prev.open) return prev;
      const phaseIndex = prev.phases.findIndex((phase) => phase.key === "runtime");
      if (phaseIndex < 0) return prev;
      const currentPhase = prev.phases[phaseIndex];
      const nextItems = upsertLaunchPrepareLogItem(currentPhase.items, jdkProgress.item);
      const nextPhase: LaunchPreparePhaseState = {
        ...currentPhase,
        status: jdkProgress.phaseStatus ?? currentPhase.status,
        stage: jdkProgress.stage ?? currentPhase.stage,
        message: jdkProgress.message,
        current: typeof jdkProgress.current === "number" ? jdkProgress.current : currentPhase.current,
        total: typeof jdkProgress.total === "number" ? jdkProgress.total : currentPhase.total,
        downloaded: typeof jdkProgress.downloaded === "number" ? jdkProgress.downloaded : currentPhase.downloaded,
        cached: typeof jdkProgress.cached === "number" ? jdkProgress.cached : currentPhase.cached,
        items: nextItems
      };

      return {
        ...prev,
        phases: prev.phases.map((phase, index) => (index === phaseIndex ? nextPhase : phase))
      };
    });
  }

  function pickLatestLauncherVersions(entries: LauncherVersion[]): LauncherVersionMap {
    const out: LauncherVersionMap = { EDGE: null, NOVA: null, EXTREME: null };
    const scoreOf = (item: LauncherVersion): number => {
      const raw = item.createdAt ?? "";
      const parsed = Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    };

    for (const item of entries) {
      if (item.versionType !== "EDGE" && item.versionType !== "NOVA" && item.versionType !== "EXTREME")
        continue;
      if (!isLauncherVersionCompatible(currentLauncherVersion, item.minLauncherVersion)) continue;
      const current = out[item.versionType];
      const shouldReplace =
        !current ||
        (item.recommended && !current.recommended) ||
        (item.recommended === current.recommended && scoreOf(item) > scoreOf(current));
      if (shouldReplace) {
        out[item.versionType] = item;
      }
    }
    return out;
  }

  // Latest catalog entry per Nova game version (keyed by MC version). Mirrors the recommended/
  // newest tie-break used by pickLatestLauncherVersions, but bucketed by gameVersion.
  function pickNovaGameVersions(entries: LauncherVersion[]): NovaVersionMap {
    const out: NovaVersionMap = {};
    const scoreOf = (item: LauncherVersion): number => {
      const parsed = Date.parse(item.createdAt ?? "");
      return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    };
    for (const item of entries) {
      if (item.versionType !== "NOVA") continue;
      // Backward compatible: entries from an older backend (or any Nova release published before the
      // multi-version rollout) carry no gameVersion — treat those as the default game version so Nova
      // keeps working. Once the new backend + CI publish per-version entries, each gets its own bucket.
      const gameVersion = (item.gameVersion ?? "").trim() || NOVA_DEFAULT_GAME_VERSION;
      if (!isLauncherVersionCompatible(currentLauncherVersion, item.minLauncherVersion)) continue;
      const current = out[gameVersion];
      const shouldReplace =
        !current ||
        (item.recommended && !current.recommended) ||
        (item.recommended === current.recommended && scoreOf(item) > scoreOf(current));
      if (shouldReplace) {
        out[gameVersion] = item;
      }
    }
    return out;
  }

  // The catalog entry for a given Nova game version, preferring a freshly-fetched map (React state
  // may lag within a single login/refresh flow) over component state.
  function resolveNovaEntry(gameVersion: string, override?: NovaVersionMap | null): LauncherVersion | null {
    return override?.[gameVersion] ?? novaGameVersions[gameVersion] ?? null;
  }

  // Nova stays a single preset "region"; at launch time we specialise it to the picked game version
  // (own baseVersion + own on-disk versionId) so each version installs/updates independently.
  // Callers may already pass a specialised copy — keep it so launch isn't racing setState.
  function resolveNovaEffectiveInstance(instance: Instance): Instance {
    if (
      instance.preset &&
      instance.launcherVersionType === "NOVA" &&
      instance.versionId.startsWith(`${NOVA_VERSION_ID_PREFIX}-`)
    ) {
      return instance;
    }
    return buildNovaEffectiveInstance(instance, selectedNovaGameVersion || instance.baseVersion);
  }

  async function refreshLauncherVersions(
    silent = false,
    tokenOverride?: string
  ): Promise<{ map: LauncherVersionMap | null; novaMap: NovaVersionMap | null; error: string | null }> {
    const token = (tokenOverride ?? launcherAuth?.token ?? "").trim();
    if (!token) {
      setLauncherVersions(EMPTY_LAUNCHER_VERSIONS);
      setNovaGameVersions({});
      return { map: null, novaMap: null, error: t("app.status.authRequiredForPreset") };
    }

    const baseUrl = LAUNCHER_API_BASE_URL;
    if (!silent) {
      setStatus(t("app.status.loadingLauncherVersions"));
    }
    setLauncherVersionLoading(true);
    try {
      const entries = await invoke<LauncherVersion[]>("launcher_list_available_versions", {
        baseUrl,
        token
      });
      const map = pickLatestLauncherVersions(entries);
      const novaMap = pickNovaGameVersions(entries);
      setLauncherVersions(map);
      setNovaGameVersions(novaMap);
      // Keep the picked Nova game version valid: fall back to recommended/newest if the previous
      // choice is no longer offered (e.g. pulled from a channel the user lost access to).
      setSelectedNovaGameVersion((prev) =>
        novaMap[prev] ? prev : preferredNovaGameVersion(novaMap) ?? prev
      );
      void refreshPresetPackageStatuses(map, novaMap);
      if (!silent) {
        const count = entries.length;
        setStatus(t("app.status.loadedLauncherVersions", { count }));
      }
      return { map, novaMap, error: null };
    } catch (error) {
      const errorText = describeApiError(error, t);
      if (token && isAuthExpiredError(error)) {
        handleAuthExpired(t("login.sessionExpired"));
        return { map: null, novaMap: null, error: t("login.sessionExpired") };
      }
      setStatus(t("app.status.failed", { error: errorText }));
      if (!silent) {
        notifyError(errorText, t("toast.title.requestFailed"));
      }
      return { map: null, novaMap: null, error: errorText };
    } finally {
      setLauncherVersionLoading(false);
    }
  }

  async function syncPresetLauncherPackages(
    versionMap?: LauncherVersionMap | null,
    novaMap?: NovaVersionMap | null
  ): Promise<void> {
    const targetMap = versionMap ?? launcherVersions;
    const targetNovaMap = novaMap ?? novaGameVersions;
    const presetInstances = instances.filter((item) => {
      if (!item.preset || !item.launcherVersionType) return false;
      if (item.launcherVersionType === "NOVA") {
        return Boolean(resolveNovaEntry(selectedNovaGameVersion, targetNovaMap));
      }
      return Boolean(targetMap[item.launcherVersionType]);
    });
    if (presetInstances.length === 0) {
      return;
    }

    for (const instance of presetInstances) {
      try {
        await ensurePresetModsReady(resolveNovaEffectiveInstance(instance), targetMap, undefined, targetNovaMap);
      } catch {
        // Keep sync best-effort to avoid blocking login flow.
      }
    }
  }

  async function refreshPresetPackageStatuses(
    versionMapOverride?: LauncherVersionMap | null,
    novaMapOverride?: NovaVersionMap | null
  ): Promise<void> {
    const targetMap = versionMapOverride ?? launcherVersions;
    const targetNovaMap = novaMapOverride ?? novaGameVersions;

    async function computePresetStatus(
      instance: Instance,
      effective: Instance,
      novaEntry: LauncherVersion | null
    ): Promise<PresetPackageStatus> {
      const presetAccess = resolvePresetAccessState(instance, targetMap, novaEntry);
      if (presetAccess.state === "pending-release") {
        return createPresetPackageStatus(presetAccess.state, {
          versionTag: presetAccess.versionTag ?? null,
          targetVersionTag: presetAccess.versionTag ?? null,
          changelog: presetAccess.changelog ?? null,
          lastError: presetAccess.lastError ?? null
        });
      }
      const expected =
        instance.launcherVersionType === "NOVA" ? novaEntry : targetMap[instance.launcherVersionType!];
      if (!expected) {
        return createPresetPackageStatus("missing");
      }
      try {
        // Edge with Forge off installs under versions/<id>/aot/, not mods/.
        const isEdgeNoForge =
          instance.launcherVersionType === "EDGE" && instance.useForge === false;
        const state = isEdgeNoForge
          ? await invoke<LauncherPackageState>("get_edge_aot_package_state", {
              gameDir: settings.gameDir,
              versionId: effective.versionId,
              expectedVersionTag: expected.versionName,
              expectedChecksum: expected.aotChecksum,
              expectedDownloadUrl: expected.aotDownloadUrl
            })
          : await invoke<LauncherPackageState>("get_launcher_package_state", {
              gameDir: settings.gameDir,
              versionId: effective.versionId,
              expectedVersionTag: expected.versionName,
              expectedChecksum: expected.checksum,
              expectedManifestUrl: expected.manifestUrl,
              expectedDownloadUrl: expected.downloadUrl
            });
        return !state.installed
          ? createPresetPackageStatus("missing", {
              targetVersionTag: expected.versionName,
              changelog: expected.changelog
            })
          : state.needsRepair
            ? createPresetPackageStatus("needs-repair", {
                versionTag: state.versionTag ?? expected.versionName,
                installedVersionTag: state.versionTag ?? expected.versionName,
                targetVersionTag: expected.versionName,
                changelog: expected.changelog
              })
            : state.upToDate
              ? createPresetPackageStatus("ready", {
                  versionTag: state.versionTag ?? expected.versionName,
                  installedVersionTag: state.versionTag ?? expected.versionName,
                  targetVersionTag: expected.versionName,
                  changelog: expected.changelog
                })
              : createPresetPackageStatus("update-available", {
                  versionTag: expected.versionName,
                  installedVersionTag: state.versionTag ?? null,
                  targetVersionTag: expected.versionName,
                  changelog: expected.changelog
                });
      } catch (error) {
        return createPresetPackageStatus("error", {
          versionTag: expected.versionName,
          targetVersionTag: expected.versionName,
          changelog: expected.changelog,
          lastError: describeApiError(error, t)
        });
      }
    }

    const nextEntries = (
      await Promise.all(
        instances
          .filter((item) => item.preset && item.launcherVersionType)
          .map(async (instance) => {
            // Nova fans out into one status per game version (keyed `nova:<gv>` — the
            // instances page's target key) so every version row reflects its own
            // install dir. The selected version's status is mirrored under the
            // instance id for the existing single-key consumers (home, launch flow).
            if (instance.launcherVersionType === "NOVA") {
              const selectedGv = selectedNovaGameVersion || instance.baseVersion;
              const versions = Array.from(new Set([...Object.keys(targetNovaMap), selectedGv]));
              const perVersion = await Promise.all(
                versions.map(async (gameVersion) => {
                  const effective = buildNovaEffectiveInstance(instance, gameVersion);
                  const status = await computePresetStatus(
                    instance,
                    effective,
                    resolveNovaEntry(gameVersion, targetNovaMap)
                  );
                  return [`nova:${gameVersion}`, status] as const;
                })
              );
              const entries: Array<readonly [string, PresetPackageStatus]> = [...perVersion];
              const selected = perVersion.find(([key]) => key === `nova:${selectedGv}`);
              if (selected) {
                entries.push([instance.id, selected[1]] as const);
              }
              return entries;
            }
            const status = await computePresetStatus(instance, instance, null);
            return [[instance.id, status] as const];
          })
      )
    ).flat();
    setPresetPackageStatuses(Object.fromEntries(nextEntries));
  }

  function requireMinecraftAccountForLaunch(): boolean {
    if (mcAccounts.currentAccount) {
      return true;
    }
    setPage("home");
    setMinecraftAccountPromptOpen(true);
    setStatus(t("minecraftAccount.requiredError"));
    return false;
  }

  async function launchToServer(serverAddress: string): Promise<void> {
    if (!current) {
      setStatus(t("servers.noInstance"));
      return;
    }
    if (ensureMandatoryLauncherUpdate()) {
      return;
    }
    if (!requireMinecraftAccountForLaunch()) {
      return;
    }

    const sessionId = createSessionId();
    openLaunchPrepare(current, sessionId);
    markLaunchPreparePhase("check-instance", "running", "prepare", t("launch.progress.checkInstance"));
    setLaunchError(null);
    setLaunchingInstanceId(current.id);
    setLaunchProgressPercent(0);
    setLaunchProgressText(t("launch.progress.checkInstance"));
    setBusy(true);
    setStatus(t("app.status.launching", { name: current.name }));
    let launchResult: LaunchExecutionResult | null = null;
    try {
      markLaunchPreparePhase("login", "running", "prepare", t("launch.progress.login"));
      setLaunchProgressText(t("launch.progress.login"));
      const readyAccount = await ensureMinecraftAccountReadyForLaunch(mcAccounts.currentAccount, sessionId);
      markLaunchPreparePhase("login", "done", "complete", t("launch.progress.loginCompleted"));
      const launchIdentity = resolveMinecraftLaunchIdentity(readyAccount);
      markLaunchPreparePhase("check-instance", "running", "prepare", t("launch.progress.checkInstance"));
      setLaunchProgressPercent(Math.round((1 / LAUNCH_PREPARE_STEPS) * 100));
      setLaunchProgressText(t("launch.progress.checkInstance"));
      const prepared = await ensureInstanceReadyForLaunch(resolveNovaEffectiveInstance(current), sessionId);
      markLaunchPreparePhase("check-instance", "done", "complete", t("launch.progress.checkInstance"));

      markLaunchPreparePhase("runtime", "running", "prepare", t("launch.progress.prepareRuntime"));
      setLaunchProgressPercent(Math.round((2 / LAUNCH_PREPARE_STEPS) * 100));
      setLaunchProgressText(t("launch.progress.prepareRuntime"));
      const jdk = await ensureJdk(settings.gameDir, prepared.versionId, settings.downloadThreads);
      markLaunchPreparePhase("runtime", "done", "complete", t("launch.progress.prepareRuntime"));

      markLaunchPreparePhase("launch", "running", "prepare", t("launch.progress.buildCommand"));
      setLaunchProgressPercent(Math.round((3 / LAUNCH_PREPARE_STEPS) * 100));
      setLaunchProgressText(t("launch.progress.buildCommand"));
      launchResult = await invoke<LaunchExecutionResult>("launch_vanilla", {
        gameDir: settings.gameDir,
        versionId: prepared.versionId,
        playerName: launchIdentity.playerName,
        uuid: launchIdentity.uuid,
        accessToken: launchIdentity.accessToken,
        userType: launchIdentity.userType,
        authXuid: launchIdentity.xuid,
        maxMemoryMb: settings.maxMemoryMb,
        javaPath: jdk.javaPath,
        downloadSource: settings.downloadSource,
        waitForExit: false,
        serverAddress: serverAddress,
        fpsmasterToken: launcherAuth?.token ?? null,
        useForge: prepared.launcherVersionType === "EDGE" ? prepared.useForge !== false : undefined,
        useOptiFine:
          prepared.launcherVersionType === "EDGE"
            ? prepared.useOptiFine !== false
            : Boolean(prepared.optiFineVersion)
      });
      setLaunchProgressPercent(100);
      setLaunchProgressText(t("launch.progress.startingGame"));
      markLaunchPreparePhase("launch", "done", "complete", t("launch.progress.startingGame"));
    } catch (error) {
      const errorText = describeApiError(error, t);
      setStatus(t("app.status.launchFailed", { error: errorText }));
      setLaunchError(errorText);
      failLaunchPrepare(errorText);
      setBusy(false);
      setLaunchingInstanceId(null);
      return;
    }

    if (!launchResult) {
      const errorText = t("app.status.launchMissingResult");
      setStatus(errorText);
      setLaunchError(errorText);
      failLaunchPrepare(errorText);
      setBusy(false);
      setLaunchingInstanceId(null);
      return;
    }

    await openMonitorForLaunch(launchResult.pid, current.name);
    completeLaunchPrepare();
    setBusy(false);
    setLaunchingInstanceId(null);
  }

  // Opens the runtime monitor as its own webview window and wires the launcher-side
  // bookkeeping (activeGamePid, monitorWindowOpen). Failure to open the window is
  // non-fatal: the game keeps running and the launcher reports it via status.
  async function openMonitorForLaunch(pid: number, instanceName: string) {
    try {
      const monitorWindow = await openMonitor(pid, instanceName, logCursorRef.current ?? 0, settings.language);
      setMonitorWindowOpen(true);
      void monitorWindow.once(TauriEvent.WINDOW_DESTROYED, () => {
        setMonitorWindowOpen(false);
      });
      if (settings.hideMainOnLaunch) {
        await invoke("hide_main_window");
      }
      setActiveGamePid(pid);
      setStatus(t("app.status.gameStarted", { pid }));
    } catch (error) {
      setActiveGamePid(pid);
      setStatus(
        t("app.status.gameStartedMonitorFailed", {
          pid,
          error: String(error)
        })
      );
    }
  }

  function persistLauncherLoginPrefs(next: LauncherLoginPrefs) {
    setLauncherLoginPrefs({
      usernameOrEmail: next.usernameOrEmail.trim(),
      password: next.rememberPassword ? next.password : "",
      rememberPassword: next.rememberPassword,
      autoLogin: next.rememberPassword && next.autoLogin
    });
  }

  function handleAuthExpired(message: string) {
    void telemetry.flushSession();
    setMinecraftAccountPromptOpen(false);
    setLauncherAuth(null);
    setLauncherVersions(EMPTY_LAUNCHER_VERSIONS);
    setNovaGameVersions({});
    launcherData.clearDashboard();
    setPresetPackageStatuses({});
    setPage("home");
    setAuthNotice(message);
    setStatus(message);
  }

  async function loginLauncherAccount(
    prefs: LauncherLoginPrefs,
    silent = false
  ): Promise<string | null> {
    const identity = prefs.usernameOrEmail.trim();
    const password = prefs.password;
    if (!identity || !password) {
      return t("login.required");
    }

    persistLauncherLoginPrefs({
      ...prefs,
      usernameOrEmail: identity,
      password
    });
    setAuthNotice(null);
    setLauncherAuthLoading(true);
    try {
      const result = await invoke<LauncherLoginResult>("launcher_login", {
        baseUrl: LAUNCHER_API_BASE_URL,
        usernameOrEmail: identity,
        password
      });
      const normalizedToken = normalizeStoredToken(result.token);
      if (!normalizedToken) {
        return t("login.missingToken");
      }
      setLauncherAuth({
        token: normalizedToken,
        user: result.user ?? {}
      });
      autoLoginAttemptedRef.current = false;
      void telemetry.cacheSession({
        username: result.user?.username,
        id: result.user?.id ?? null
      });
      void launcherData.refreshHome(true, normalizedToken);
      const refresh = await refreshLauncherVersions(false, normalizedToken);
      if (!refresh.error && refresh.map) {
        void syncPresetLauncherPackages(refresh.map, refresh.novaMap);
      }
      setPage("home");
      // Sign-in itself succeeded, so the login page unmounts right here and can
      // never render this error. Raise it as a toast instead of returning it
      // into a dead component.
      if (refresh.error) {
        notifyWarning(refresh.error, t("toast.title.requestFailed"));
      }
      return null;
    } catch (error) {
      const errorText = normalizeLoginError(error, t);
      setStatus(t("app.status.failed", { error: errorText }));
      // Auto-login runs with `silent` and has no form to render the failure in,
      // so it needs a toast; the interactive path shows it inline on the form.
      if (silent) {
        notifyWarning(t("login.autoLoginFailed", { error: errorText }), t("toast.title.loginFailed"));
      }
      return errorText;
    } finally {
      setLauncherAuthLoading(false);
    }
  }

  function logoutLauncherAccount() {
    void telemetry.flushSession();
    // Manual logout must not bounce straight back in via auto-login.
    // Block the once-per-session guard immediately and disable the
    // auto-login preference so it stays off on the next launch too.
    autoLoginAttemptedRef.current = true;
    setMinecraftAccountPromptOpen(false);
    persistLauncherLoginPrefs({ ...launcherLoginPrefs, autoLogin: false });
    setLauncherAuth(null);
    setLauncherVersions(EMPTY_LAUNCHER_VERSIONS);
    setNovaGameVersions({});
    launcherData.clearDashboard();
    setPresetPackageStatuses({});
    setPage("home");
    setAuthNotice(t("login.tip.signInToContinue"));
    setStatus(t("login.tip.signInToContinue"));
  }

  async function ensurePresetModsReady(
    instance: Instance,
    versionMapOverride?: LauncherVersionMap | null,
    launchSessionId?: string,
    novaMapOverride?: NovaVersionMap | null
  ) {
    if (!instance.preset || !instance.launcherVersionType) return;

    // For Nova, `instance` is the game-version-specialised copy (baseVersion = picked MC version,
    // versionId = FPSMaster-Nova-<gameVersion>). Resolve everything against that game version.
    const isNova = instance.launcherVersionType === "NOVA";
    const novaEntry = isNova ? resolveNovaEntry(instance.baseVersion, novaMapOverride) : null;

    const presetAccess = resolvePresetAccessState(instance, versionMapOverride ?? launcherVersions, novaEntry);
    if (presetAccess.state === "pending-release") {
      setPresetPackageStatuses((prev) => ({
        ...prev,
        [instance.id]: createPresetPackageStatus("pending-release", {
          versionTag: presetAccess.versionTag ?? null,
          targetVersionTag: presetAccess.versionTag ?? null,
          changelog: presetAccess.changelog ?? null,
          lastError: presetAccess.lastError ?? null
        })
      }));
      setStatus(presetAccess.lastError ?? t("app.status.authRequiredForPreset"));
      return;
    }

    const token = launcherAuth?.token?.trim() ?? "";
    if (!token) {
      setStatus(t("app.status.authRequiredForPreset"));
      return;
    }

    let targetVersion = isNova
      ? novaEntry
      : versionMapOverride?.[instance.launcherVersionType] ??
        launcherVersions[instance.launcherVersionType];
    if (!targetVersion) {
      const refresh = await refreshLauncherVersions(true, token);
      if (refresh.error) {
        // The release catalog is only needed to CHECK for a newer package. If this instance
        // already has a mod package installed on disk, a catalog hiccup (backend redeploy, a
        // transient 404, offline) must not block launching what's already installed — degrade
        // to the installed version instead of aborting the launch with a raw backend error.
        let installedTag: string | null = null;
        try {
          const state = await invoke<LauncherPackageState>("get_launcher_package_state", {
            gameDir: settings.gameDir,
            versionId: instance.versionId
          });
          if (state.installed) {
            installedTag = state.versionTag ?? null;
          }
        } catch {
          // fall through to throw below
        }
        if (installedTag !== null) {
          console.warn(
            "[preset-mods] release catalog unavailable, launching installed package:",
            refresh.error
          );
          setPresetPackageStatuses((prev) => ({
            ...prev,
            [instance.id]: createPresetPackageStatus("ready", {
              versionTag: installedTag,
              installedVersionTag: installedTag,
              targetVersionTag: installedTag
            })
          }));
          return;
        }
        throw new Error(refresh.error);
      }
      targetVersion = isNova
        ? refresh.novaMap?.[instance.baseVersion] ?? null
        : refresh.map?.[instance.launcherVersionType] ?? null;
    }

    if (!targetVersion) {
      setPresetPackageStatuses((prev) => ({
        ...prev,
        [instance.id]: createPresetPackageStatus("missing")
      }));
      return;
    }

    if (!isLauncherVersionCompatible(currentLauncherVersion, targetVersion.minLauncherVersion)) {
      const errorText = t("app.status.launcherUpgradeRequired", {
        required: targetVersion.minLauncherVersion ?? "-"
      });
      setPresetPackageStatuses((prev) => ({
        ...prev,
        [instance.id]: createPresetPackageStatus("error", {
          versionTag: targetVersion.versionName,
          targetVersionTag: targetVersion.versionName,
          changelog: targetVersion.changelog,
          lastError: errorText
        })
      }));
      setStatus(
        errorText
      );
      return;
    }

    setPresetPackageStatuses((prev) => ({
      ...prev,
      [instance.id]: createPresetPackageStatus("syncing", {
        versionTag: targetVersion.versionName,
        installedVersionTag: prev[instance.id]?.installedVersionTag ?? prev[instance.id]?.versionTag ?? null,
        targetVersionTag: targetVersion.versionName,
        changelog: targetVersion.changelog,
        lastError: null
      })
    }));
    setStatus(t("app.status.autoInstallMods", { name: instance.name }));
    // Edge with Forge disabled skips the mods/-jar install entirely and instead installs the
    // Forge-free AOT package (fpsmaster-runtime.jar + mappings.tiny only — never Mojang jars)
    // under versions/<id>/aot/. The notch client comes from the normal version download.
    // OptiFine (when enabled) is still installed via install_optifine; AOT launch picks it up.
    const isEdgeNoForge = !isNova && instance.launcherVersionType === "EDGE" && instance.useForge === false;
    try {
      if (isEdgeNoForge) {
        const aotDownloadUrl = targetVersion.aotDownloadUrl?.trim();
        if (!aotDownloadUrl) {
          throw new Error(
            "Edge AOT package URL is missing (aotDownloadUrl). This Edge release does not include a Forge-free package yet."
          );
        }
        const aotResult = await invoke<EdgeAotInstallResult>("install_edge_aot_package", {
          gameDir: settings.gameDir,
          versionId: instance.versionId,
          downloadUrl: aotDownloadUrl,
          // Must use the AOT zip checksum — the Forge jar checksum will never match.
          checksum: targetVersion.aotChecksum ?? undefined,
          versionTag: targetVersion.versionName,
          ipcSession: launchSessionId
        });
        setPresetPackageStatuses((prev) => ({
          ...prev,
          [instance.id]: createPresetPackageStatus("ready", {
            versionTag: targetVersion.versionName,
            installedVersionTag: targetVersion.versionName,
            targetVersionTag: targetVersion.versionName,
            changelog: targetVersion.changelog
          })
        }));
        setStatus(
          aotResult.skipped
            ? t("app.status.autoInstallModsUpToDate")
            : t("app.status.autoInstallModsDone", { count: 1 })
        );
        return;
      }

      const result = await invoke<LauncherModsInstallResult>("install_launcher_version_mods", {
        gameDir: settings.gameDir,
        versionId: instance.versionId,
        downloadUrl: targetVersion.downloadUrl,
        checksum: targetVersion.checksum,
        manifestUrl: targetVersion.manifestUrl,
        versionTag: targetVersion.versionName,
        // Nova used to clean the whole mods dir on every sync (cleanExisting=true), which wiped
        // any manually-added mods (e.g. a hand-installed Fabric API). It now syncs like EDGE:
        // only the launcher-managed package files are reconciled, user mods are left in place.
        // Fabric API is provided automatically below via install_fabric_api instead.
        cleanExisting: false,
        ipcSession: launchSessionId
      });
      // Nova ships as a Fabric mod set but its release package does not bundle Fabric API, so
      // pull the matching Fabric API build into the same mods dir (idempotent — skips when already
      // current). Best-effort: a Modrinth hiccup, or a brand-new Nova game version without a
      // published Fabric API yet, must not block the launch, so failures only warn.
      if (isNova) {
        try {
          await invoke("install_fabric_api", {
            gameDir: settings.gameDir,
            versionId: instance.versionId,
            gameVersion: instance.baseVersion,
            ipcSession: launchSessionId
          });
        } catch (fabricApiError) {
          console.warn("[preset-mods] Fabric API auto-install failed:", fabricApiError);
        }
      }
      setPresetPackageStatuses((prev) => ({
        ...prev,
        [instance.id]: createPresetPackageStatus("ready", {
          versionTag: targetVersion.versionName,
          installedVersionTag: targetVersion.versionName,
          targetVersionTag: targetVersion.versionName,
          changelog: targetVersion.changelog
        })
      }));
      setStatus(
        result.skipped
          ? t("app.status.autoInstallModsUpToDate")
          : t("app.status.autoInstallModsDone", { count: result.installedFiles })
      );
    } catch (error) {
      const errorText = describeApiError(error, t);
      setPresetPackageStatuses((prev) => ({
        ...prev,
        [instance.id]: createPresetPackageStatus("error", {
          versionTag: targetVersion.versionName,
          installedVersionTag: prev[instance.id]?.installedVersionTag ?? null,
          targetVersionTag: targetVersion.versionName,
          changelog: targetVersion.changelog,
          lastError: errorText
        })
      }));
      throw error;
    }
  }

  async function collectInstanceContentUpdateState(instance: Instance): Promise<{
    items: InstalledContentItem[];
    updates: InstalledContentUpdate[];
  }> {
    const items = await invoke<InstalledContentItem[]>("list_installed_content", {
      gameDir: settings.gameDir,
      versionId: instance.versionId
    });
    if (items.length === 0) {
      return { items, updates: [] };
    }

    const updates = await invoke<InstalledContentUpdate[]>("check_installed_content_updates", {
      gameDir: settings.gameDir,
      versionId: instance.versionId,
      gameVersion: instance.baseVersion,
      loader: instance.loader,
      apiKey: settings.curseforgeApiKey
    });
    return { items, updates };
  }

  async function ensureManagedContentUpToDate(instance: Instance): Promise<void> {
    const { items, updates } = await collectInstanceContentUpdateState(instance);
    if (items.length === 0 || updates.length === 0) {
      return;
    }

    const updateMap = new Map(
      updates.map((item) => [`${item.source}:${item.contentType}:${item.projectId}`, item] as const)
    );
    const pendingItems = items.filter((item) => {
      const needsUpdate =
        updateMap.get(`${item.source}:${item.contentType}:${item.projectId}`)?.status === "update-available";
      if (!needsUpdate || item.source === "local") {
        return false;
      }
      if (item.source === "curseforge" && !settings.curseforgeApiKey.trim()) {
        return false;
      }
      return true;
    });
    if (pendingItems.length === 0) {
      return;
    }

    setStatus(t("app.status.autoUpdatingContent", { name: instance.name, count: pendingItems.length }));
    for (const item of pendingItems) {
      if (item.source === "curseforge") {
        await invoke("install_curseforge_project", {
          gameDir: settings.gameDir,
          versionId: instance.versionId,
          projectId: item.projectId,
          projectTitle: item.projectTitle,
          projectType: item.contentType,
          gameVersion: instance.baseVersion,
          loader: instance.loader,
          apiKey: settings.curseforgeApiKey
        });
        continue;
      }

      await invoke("install_modrinth_project", {
        gameDir: settings.gameDir,
        versionId: instance.versionId,
        projectId: item.projectId,
        projectTitle: item.projectTitle,
        projectType: item.contentType,
        gameVersion: instance.baseVersion,
        loader: instance.loader
      });
    }
    setStatus(t("app.status.autoUpdatedContent", { name: instance.name, count: pendingItems.length }));
  }

  async function ensureInstanceReadyForLaunch(instance: Instance, launchSessionId?: string): Promise<Instance> {
    let workingInstance = instance;
    // Nova's on-disk versionId is game-version-specific (the caller already specialised the
    // instance), so use its versionId directly instead of the single fixed preset id.
    const presetVersionId = instance.preset
      ? instance.launcherVersionType === "NOVA"
        ? instance.versionId
        : resolvePresetVersionId(instance.id)
      : null;
    if (presetVersionId && workingInstance.versionId !== presetVersionId) {
      try {
        const renamedVersionId = await invoke<string>("rename_version_profile", {
          gameDir: settings.gameDir,
          fromVersionId: workingInstance.versionId,
          toVersionId: presetVersionId
        });
        workingInstance = {
          ...workingInstance,
          versionId: renamedVersionId
        };
        setInstances((prev) =>
          prev.map((item) => (item.id === workingInstance.id ? workingInstance : item))
        );
      } catch {
      }
    }

    // Edge's `loader` is derived from the `useForge` toggle rather than being an
    // independent choice: Forge on -> "forge" (existing mod-jar path), Forge off ->
    // "vanilla" (Forge-free AOT path). Both fields default to true/on when unset, so
    // existing saved instances keep today's Forge behavior unchanged.
    if (workingInstance.launcherVersionType === "EDGE") {
      const derivedLoader: Loader = workingInstance.useForge === false ? "vanilla" : "forge";
      if (workingInstance.loader !== derivedLoader) {
        workingInstance = { ...workingInstance, loader: derivedLoader };
      }
    }

    const needsLoaderProfile =
      workingInstance.loader !== "vanilla" && workingInstance.versionId === workingInstance.baseVersion;

    if (!needsLoaderProfile) {
      let installed = await invoke<boolean>("is_version_installed", {
        gameDir: settings.gameDir,
        versionId: workingInstance.versionId
      });
      if (installed && presetVersionId && workingInstance.loader !== "vanilla") {
        const profileBaseVersion = await invoke<string | null>("get_version_profile_base_version", {
          gameDir: settings.gameDir,
          versionId: workingInstance.versionId
        });
        if (profileBaseVersion && profileBaseVersion !== workingInstance.baseVersion) {
          installed = false;
          workingInstance = {
            ...workingInstance,
            loaderVersion: undefined,
            optiFineVersion: undefined
          };
        }
      } else if (installed && presetVersionId && workingInstance.loader === "vanilla") {
        // Edge with Forge just toggled off: the on-disk profile at this versionId may still be
        // a leftover Forge child profile (inheritsFrom baseVersion) from before the toggle. The
        // AOT launch plan needs a plain vanilla profile, so force a reinstall in that case.
        const profileBaseVersion = await invoke<string | null>("get_version_profile_base_version", {
          gameDir: settings.gameDir,
          versionId: workingInstance.versionId
        });
        if (profileBaseVersion === workingInstance.baseVersion && profileBaseVersion !== workingInstance.versionId) {
          installed = false;
          workingInstance = {
            ...workingInstance,
            loaderVersion: undefined,
            optiFineVersion: undefined
          };
        }
      }
      if (installed) {
        if (workingInstance.launcherVersionType === "EDGE") {
          markLaunchPreparePhase("check-instance", "running", "resolve", t("launch.progress.resolveLoader"));
          const useForge = workingInstance.useForge !== false;
          const useOptiFine = workingInstance.useOptiFine !== false;
          let edgeInstanceChanged = false;
          if (useForge) {
            const optiFineVersions = useOptiFine
              ? await cachedLoaderLookup(
                  `optifine|${workingInstance.baseVersion}|${workingInstance.loader}|${settings.downloadSource}`,
                  () =>
                    invoke<OptiFineVersion[]>("list_optifine_versions", {
                      gameVersion: workingInstance.baseVersion,
                      loader: workingInstance.loader,
                      loaderVersion: null,
                      downloadSource: settings.downloadSource
                    })
                )
              : [];
            const selectedOptiFine = selectDefaultEdgeOptiFineVersion(optiFineVersions);
            const latestOptiFine = selectedOptiFine?.version ?? "";
            const forgeVersions = await cachedLoaderLookup(
              `forge|${workingInstance.baseVersion}|${settings.downloadSource}`,
              () =>
                invoke<string[]>("list_forge_versions", {
                  gameVersion: workingInstance.baseVersion,
                  downloadSource: settings.downloadSource
                })
            );
            const latestForgeVersion = forgeVersions[0] ?? "";
            if (!latestForgeVersion) {
              throw new Error(`No forge version available for ${workingInstance.baseVersion}`);
            }
            if ((workingInstance.loaderVersion ?? "").trim() !== latestForgeVersion) {
              markLaunchPreparePhase("forge", "running", "prepare", t("install.phase.installingForge", { version: latestForgeVersion }));
              const jdk = await ensureJdk(settings.gameDir, workingInstance.baseVersion, settings.downloadThreads);
              const forge = await invoke<ForgeInstallResult>("install_forge", {
                gameDir: settings.gameDir,
                forgeVersion: latestForgeVersion,
                javaPath: jdk.javaPath,
                downloadSource: settings.downloadSource,
                downloadThreads: settings.downloadThreads,
                ipcSession: launchSessionId
              });
              workingInstance = {
                ...workingInstance,
                versionId: forge.profileId,
                loaderVersion: forge.forgeVersion
              };
              edgeInstanceChanged = true;
              if (presetVersionId && workingInstance.versionId !== presetVersionId) {
                const renamedVersionId = await invoke<string>("rename_version_profile", {
                  gameDir: settings.gameDir,
                  fromVersionId: workingInstance.versionId,
                  toVersionId: presetVersionId
                });
                workingInstance = {
                  ...workingInstance,
                  versionId: renamedVersionId
                };
              }
              markLaunchPreparePhase("forge", "done", "complete", t("install.phase.loaderCompleted"));
            }
            if (useOptiFine && latestOptiFine && (workingInstance.optiFineVersion !== latestOptiFine || edgeInstanceChanged)) {
              markLaunchPreparePhase("optifine", "running", "prepare", t("install.phase.installingOptiFine", { version: latestOptiFine }));
              const optiFine = await invoke<OptiFineInstallResult>("install_optifine", {
                gameDir: settings.gameDir,
                versionId: workingInstance.versionId,
                gameVersion: workingInstance.baseVersion,
                loader: workingInstance.loader,
                loaderVersion: workingInstance.loaderVersion,
                optifineVersion: latestOptiFine,
                downloadSource: settings.downloadSource,
                ipcSession: launchSessionId
              });
              workingInstance = {
                ...workingInstance,
                optiFineVersion: optiFine.optiFineVersion
              };
              edgeInstanceChanged = true;
              markLaunchPreparePhase("optifine", "done", "complete", t("install.phase.optiFineCompleted"));
            } else if (!useOptiFine && workingInstance.optiFineVersion) {
              workingInstance = { ...workingInstance, optiFineVersion: undefined };
              edgeInstanceChanged = true;
            }
          } else {
            // Forge disabled: no loader jar to resolve. OptiFine (when enabled) is
            // installed the same way as the Forge path — the AOT launch plan mirrors
            // the resulting jar from mods/ onto its own classpath at launch time.
            if (workingInstance.loaderVersion) {
              workingInstance = { ...workingInstance, loaderVersion: undefined };
              edgeInstanceChanged = true;
            }
            if (useOptiFine) {
              const optiFineVersions = await cachedLoaderLookup(
                `optifine|${workingInstance.baseVersion}|${workingInstance.loader}|${settings.downloadSource}`,
                () =>
                  invoke<OptiFineVersion[]>("list_optifine_versions", {
                    gameVersion: workingInstance.baseVersion,
                    loader: workingInstance.loader,
                    loaderVersion: null,
                    downloadSource: settings.downloadSource
                  })
              );
              const selectedOptiFine = selectDefaultEdgeOptiFineVersion(optiFineVersions);
              const latestOptiFine = selectedOptiFine?.version ?? "";
              if (latestOptiFine && workingInstance.optiFineVersion !== latestOptiFine) {
                markLaunchPreparePhase("optifine", "running", "prepare", t("install.phase.installingOptiFine", { version: latestOptiFine }));
                const optiFine = await invoke<OptiFineInstallResult>("install_optifine", {
                  gameDir: settings.gameDir,
                  versionId: workingInstance.versionId,
                  gameVersion: workingInstance.baseVersion,
                  loader: workingInstance.loader,
                  loaderVersion: workingInstance.loaderVersion,
                  optifineVersion: latestOptiFine,
                  downloadSource: settings.downloadSource,
                  ipcSession: launchSessionId
                });
                workingInstance = {
                  ...workingInstance,
                  optiFineVersion: optiFine.optiFineVersion
                };
                edgeInstanceChanged = true;
                markLaunchPreparePhase("optifine", "done", "complete", t("install.phase.optiFineCompleted"));
              }
            } else if (workingInstance.optiFineVersion) {
              workingInstance = { ...workingInstance, optiFineVersion: undefined };
              edgeInstanceChanged = true;
            }
          }
          if (edgeInstanceChanged) {
            setInstances((prev) =>
              prev.map((item) => (item.id === workingInstance.id ? workingInstance : item))
            );
          }
        }
        markLaunchPreparePhase("check-instance", "done", "complete", t("launch.progress.checkInstance"));
        markLaunchPreparePhase("verify", "running", "prepare", t("launch.progress.verify"));
        await invoke("verify_installed_files", {
          gameDir: settings.gameDir,
          versionId: workingInstance.versionId,
          downloadSource: settings.downloadSource,
          downloadThreads: settings.downloadThreads,
          ipcSession: launchSessionId
        });
        markLaunchPreparePhase("verify", "done", "complete", t("launch.progress.verifyCompleted"));
        markLaunchPreparePhase("mods", "running", "prepare", t("launch.progress.syncMods"));
        await ensurePresetModsReady(workingInstance, undefined, launchSessionId);
        await ensureManagedContentUpToDate(workingInstance);
        markLaunchPreparePhase("mods", "done", "complete", t("launch.progress.syncModsCompleted"));
        return workingInstance;
      }
    }

    setStatus(
      t("app.status.missingAutoInstall", {
        versionId: workingInstance.versionId,
        baseVersion: workingInstance.baseVersion,
        loader: loaderDisplayName(workingInstance.loader)
      })
    );
    const sessionId = launchSessionId ?? createSessionId();
    // Complete check-instance before the install phases begin: the dialog shows the
    // first "running" phase, so leaving check-instance running here would shadow the
    // real vanilla/forge/optifine download progress behind a stuck "checking" header.
    markLaunchPreparePhase("check-instance", "done", "complete", t("launch.progress.checkInstance"));
    markLaunchPreparePhase("vanilla", "running", "prepare", t("install.phase.preparing", { version: workingInstance.baseVersion }));
    const vanilla = await invoke<InstallResult>("install_vanilla", {
      gameDir: settings.gameDir,
      versionId: workingInstance.baseVersion,
      downloadSource: settings.downloadSource,
      downloadThreads: settings.downloadThreads,
      ipcSession: sessionId
    });
    markLaunchPreparePhase("vanilla", "done", "complete", t("install.phase.vanillaCompleted"));

    let nextVersionId = vanilla.versionId;
    let nextLoaderVersion = workingInstance.loaderVersion;
    let nextOptiFineVersion = workingInstance.optiFineVersion;

    if (workingInstance.loader === "fabric") {
      if (!nextLoaderVersion) {
        const loaderVersions = await invoke<string[]>("list_fabric_loaders", {
          gameVersion: workingInstance.baseVersion,
          downloadSource: settings.downloadSource
        });
        nextLoaderVersion = loaderVersions[0] ?? "";
      }
      if (!nextLoaderVersion) {
        throw new Error(`No fabric loader version available for ${workingInstance.baseVersion}`);
      }
      markLaunchPreparePhase("fabric", "running", "prepare", t("install.phase.installingFabric", { version: nextLoaderVersion }));
      const fabric = await invoke<FabricInstallResult>("install_fabric", {
        gameDir: settings.gameDir,
        gameVersion: workingInstance.baseVersion,
        loaderVersion: nextLoaderVersion,
        downloadSource: settings.downloadSource,
        downloadThreads: settings.downloadThreads,
        ipcSession: sessionId
      });
      nextVersionId = fabric.profileId;
      markLaunchPreparePhase("fabric", "done", "complete", t("install.phase.loaderCompleted"));
    } else if (workingInstance.loader === "forge") {
      if (workingInstance.launcherVersionType === "EDGE") {
        if (workingInstance.useOptiFine !== false) {
          const optiFineVersions = await invoke<OptiFineVersion[]>("list_optifine_versions", {
            gameVersion: workingInstance.baseVersion,
            loader: workingInstance.loader,
            loaderVersion: null,
            downloadSource: settings.downloadSource
          });
          const selectedOptiFine = selectDefaultEdgeOptiFineVersion(optiFineVersions);
          nextOptiFineVersion = selectedOptiFine?.version ?? "";
        }
        const forgeVersions = await invoke<string[]>("list_forge_versions", {
          gameVersion: workingInstance.baseVersion,
          downloadSource: settings.downloadSource
        });
        nextLoaderVersion = forgeVersions[0] ?? "";
      } else if (!nextLoaderVersion) {
        const forgeVersions = await invoke<string[]>("list_forge_versions", {
          gameVersion: workingInstance.baseVersion,
          downloadSource: settings.downloadSource
        });
        nextLoaderVersion = forgeVersions[0] ?? "";
      }
      if (!nextLoaderVersion) {
        throw new Error(`No forge version available for ${workingInstance.baseVersion}`);
      }
      markLaunchPreparePhase("forge", "running", "prepare", t("install.phase.installingForge", { version: nextLoaderVersion }));
      const jdk = await ensureJdk(settings.gameDir, workingInstance.baseVersion, settings.downloadThreads);
      const forge = await invoke<ForgeInstallResult>("install_forge", {
        gameDir: settings.gameDir,
        forgeVersion: nextLoaderVersion,
        javaPath: jdk.javaPath,
        downloadSource: settings.downloadSource,
        downloadThreads: settings.downloadThreads,
        ipcSession: sessionId
      });
      nextVersionId = forge.profileId;
      nextLoaderVersion = forge.forgeVersion;
      markLaunchPreparePhase("forge", "done", "complete", t("install.phase.loaderCompleted"));
    }

    if (
      workingInstance.launcherVersionType === "EDGE" &&
      workingInstance.useOptiFine !== false &&
      !nextOptiFineVersion
    ) {
      const optiFineVersions = await invoke<OptiFineVersion[]>("list_optifine_versions", {
        gameVersion: workingInstance.baseVersion,
        loader: workingInstance.loader,
        loaderVersion: workingInstance.loader === "vanilla" ? null : nextLoaderVersion,
        downloadSource: settings.downloadSource
      });
      nextOptiFineVersion =
        optiFineVersions.find((item) => item.compatibility === "compatible")?.version ?? "";
    }
    if (workingInstance.launcherVersionType === "EDGE" && workingInstance.useOptiFine === false) {
      nextOptiFineVersion = undefined;
    }

    if (nextOptiFineVersion) {
      markLaunchPreparePhase("optifine", "running", "prepare", t("install.phase.installingOptiFine", { version: nextOptiFineVersion }));
      const optiFine = await invoke<OptiFineInstallResult>("install_optifine", {
        gameDir: settings.gameDir,
        versionId: nextVersionId,
        gameVersion: workingInstance.baseVersion,
        loader: workingInstance.loader,
        loaderVersion: nextLoaderVersion,
        optifineVersion: nextOptiFineVersion,
        downloadSource: settings.downloadSource,
        ipcSession: sessionId
      });
      nextOptiFineVersion = optiFine.optiFineVersion;
      markLaunchPreparePhase("optifine", "done", "complete", t("install.phase.optiFineCompleted"));
    }

    if (presetVersionId && nextVersionId !== presetVersionId) {
      nextVersionId = await invoke<string>("rename_version_profile", {
        gameDir: settings.gameDir,
        fromVersionId: nextVersionId,
        toVersionId: presetVersionId
      });
    }

    const updatedInstance: Instance = {
      ...workingInstance,
      versionId: nextVersionId,
      loaderVersion: workingInstance.loader === "vanilla" ? undefined : nextLoaderVersion,
      optiFineVersion: nextOptiFineVersion || undefined
    };
    setInstances((prev) =>
      prev.map((item) => (item.id === updatedInstance.id ? updatedInstance : item))
    );
    markLaunchPreparePhase("mods", "running", "prepare", t("launch.progress.syncMods"));
    await ensurePresetModsReady(updatedInstance, undefined, sessionId);
    await ensureManagedContentUpToDate(updatedInstance);
    markLaunchPreparePhase("mods", "done", "complete", t("launch.progress.syncModsCompleted"));
    setStatus(t("app.status.autoInstallCompleted", { name: updatedInstance.name }));
    markLaunchPreparePhase("check-instance", "done", "complete", t("app.status.autoInstallCompleted", { name: updatedInstance.name }));
    return updatedInstance;
  }

  async function launchTarget(target: Instance) {
    if (ensureMandatoryLauncherUpdate()) {
      return;
    }
    if (!requireMinecraftAccountForLaunch()) {
      return;
    }
    const presetAccess = resolvePresetAccessState(
      target,
      launcherVersions,
      target.launcherVersionType === "NOVA" ? resolveNovaEntry(selectedNovaGameVersion) : null
    );
    if (presetAccess.state === "pending-release") {
      const errorText = presetAccess.lastError ?? t("app.status.authRequiredForPreset");
      setLaunchError(errorText);
      setStatus(errorText);
      return;
    }
    if (activeGamePid !== null && activeGamePid > 0) {
      try {
        const runtime = await invoke<GameRuntimeStats>("poll_game_runtime", { pid: activeGamePid });
        if (runtime.running) {
          setStatus(t("app.status.singleInstanceRunning", { pid: activeGamePid }));
          return;
        }
      } catch {
      }
      setActiveGamePid(null);
    }

    // FPSMaster-Extreme is a native binary, not a Java instance — install and
    // launch it through the native-app path instead of the vanilla pipeline.
    if (target.launcherVersionType === "EXTREME") {
      await launchExtreme(target);
      return;
    }

    const sessionId = createSessionId();
    openLaunchPrepare(target, sessionId);
    markLaunchPreparePhase("check-instance", "running", "prepare", t("launch.progress.checkInstance"));
    setLaunchError(null);
    setLaunchingInstanceId(target.id);
    setLaunchProgressPercent(0);
    setLaunchProgressText(t("launch.progress.checkInstance"));
    setBusy(true);
    setStatus(t("app.status.launching", { name: target.name }));
    let launchResult: LaunchExecutionResult | null = null;
    try {
      markLaunchPreparePhase("login", "running", "prepare", t("launch.progress.login"));
      setLaunchProgressText(t("launch.progress.login"));
      const readyAccount = await ensureMinecraftAccountReadyForLaunch(mcAccounts.currentAccount, sessionId);
      markLaunchPreparePhase("login", "done", "complete", t("launch.progress.loginCompleted"));
      const launchIdentity = resolveMinecraftLaunchIdentity(readyAccount);
      markLaunchPreparePhase("check-instance", "running", "prepare", t("launch.progress.checkInstance"));
      setLaunchProgressPercent(Math.round((1 / LAUNCH_PREPARE_STEPS) * 100));
      setLaunchProgressText(t("launch.progress.checkInstance"));
      const prepared = await ensureInstanceReadyForLaunch(resolveNovaEffectiveInstance(target), sessionId);
      markLaunchPreparePhase("check-instance", "done", "complete", t("launch.progress.checkInstance"));

      markLaunchPreparePhase("runtime", "running", "prepare", t("launch.progress.prepareRuntime"));
      setLaunchProgressPercent(Math.round((2 / LAUNCH_PREPARE_STEPS) * 100));
      setLaunchProgressText(t("launch.progress.prepareRuntime"));
      const jdk = await ensureJdk(settings.gameDir, prepared.versionId, settings.downloadThreads);
      markLaunchPreparePhase("runtime", "done", "complete", t("launch.progress.prepareRuntime"));

      markLaunchPreparePhase("launch", "running", "prepare", t("launch.progress.buildCommand"));
      setLaunchProgressPercent(Math.round((3 / LAUNCH_PREPARE_STEPS) * 100));
      setLaunchProgressText(t("launch.progress.buildCommand"));
      launchResult = await invoke<LaunchExecutionResult>("launch_vanilla", {
        gameDir: settings.gameDir,
        versionId: prepared.versionId,
        playerName: launchIdentity.playerName,
        uuid: launchIdentity.uuid,
        accessToken: launchIdentity.accessToken,
        userType: launchIdentity.userType,
        authXuid: launchIdentity.xuid,
        maxMemoryMb: settings.maxMemoryMb,
        javaPath: jdk.javaPath,
        downloadSource: settings.downloadSource,
        waitForExit: false,
        fpsmasterToken: launcherAuth?.token ?? null,
        useForge: prepared.launcherVersionType === "EDGE" ? prepared.useForge !== false : undefined,
        useOptiFine:
          prepared.launcherVersionType === "EDGE"
            ? prepared.useOptiFine !== false
            : Boolean(prepared.optiFineVersion)
      });
      setLaunchProgressPercent(100);
      setLaunchProgressText(t("launch.progress.startingGame"));
      markLaunchPreparePhase("launch", "done", "complete", t("launch.progress.startingGame"));
    } catch (error) {
      const errorText = describeApiError(error, t);
      setStatus(t("app.status.launchFailed", { error: errorText }));
      setLaunchError(errorText);
      failLaunchPrepare(errorText);
      setBusy(false);
      setLaunchingInstanceId(null);
      return;
    }

    if (!launchResult) {
      const errorText = t("app.status.launchMissingResult");
      setStatus(errorText);
      setLaunchError(errorText);
      failLaunchPrepare(errorText);
      setBusy(false);
      setLaunchingInstanceId(null);
      return;
    }

    await openMonitorForLaunch(launchResult.pid, target.name);
    completeLaunchPrepare();
    setBusy(false);
    setLaunchingInstanceId(null);
  }

  // Install + launch the native FPSMaster-Extreme client. Bypasses the Java
  // vanilla/loader pipeline: downloads the native tarball (install_native_app),
  // best-effort extracts vanilla 1.8.9 assets (prepare_extreme_assets), then
  // spawns the binary (launch_native_app). See MiniCraft/docs/LAUNCHER_INTEGRATION.md.
  async function launchExtreme(target: Instance) {
    const sessionId = createSessionId();
    openLaunchPrepare(target, sessionId);
    setLaunchError(null);
    setLaunchingInstanceId(target.id);
    setLaunchProgressPercent(0);
    setBusy(true);
    setStatus(t("app.status.launching", { name: target.name }));

    let launchResult: LaunchExecutionResult | null = null;
    try {
      markLaunchPreparePhase("login", "running", "prepare", t("launch.progress.login"));
      setLaunchProgressText(t("launch.progress.login"));
      const readyAccount = await ensureMinecraftAccountReadyForLaunch(mcAccounts.currentAccount, sessionId);
      markLaunchPreparePhase("login", "done", "complete", t("launch.progress.loginCompleted"));

      // 1. Resolve the EXTREME distributable from the backend registry.
      const token = launcherAuth?.token?.trim() ?? "";
      let targetVersion = launcherVersions.EXTREME;
      if (!targetVersion && token) {
        const refresh = await refreshLauncherVersions(true, token);
        if (refresh.error) throw new Error(refresh.error);
        targetVersion = refresh.map?.EXTREME ?? null;
      }
      if (!targetVersion) {
        throw new Error(t("app.status.authRequiredForPreset"));
      }
      if (!isLauncherVersionCompatible(currentLauncherVersion, targetVersion.minLauncherVersion)) {
        throw new Error(
          t("app.status.launcherUpgradeRequired", { required: targetVersion.minLauncherVersion ?? "-" })
        );
      }

      // 2. Download + install the native binary.
      markLaunchPreparePhase("check-instance", "running", "prepare", t("launch.progress.checkInstance"));
      setLaunchProgressPercent(20);
      setLaunchProgressText(t("launch.progress.checkInstance"));
      await invoke("install_native_app", {
        gameDir: settings.gameDir,
        versionId: target.versionId,
        downloadUrl: targetVersion.downloadUrl,
        versionTag: targetVersion.versionName,
        checksum: targetVersion.checksum
      });
      markLaunchPreparePhase("check-instance", "done", "complete", t("launch.progress.checkInstance"));

      // 3. Best-effort: extract vanilla 1.8.9 assets to feed the client (§5). If
      // no 1.8.9 client jar is present yet, launch without --assets and let the
      // client fall back to its own resolution.
      markLaunchPreparePhase("runtime", "running", "prepare", t("launch.progress.prepareRuntime"));
      setLaunchProgressPercent(55);
      setLaunchProgressText(t("launch.progress.prepareRuntime"));
      let assetsPath: string | undefined;
      try {
        assetsPath = await invoke<string>("prepare_extreme_assets", {
          gameDir: settings.gameDir,
          versionId: target.versionId
        });
      } catch {
        assetsPath = undefined;
      }
      markLaunchPreparePhase("runtime", "done", "complete", t("launch.progress.prepareRuntime"));

      // 4. Spawn the native process (offline username for v1; see §7).
      markLaunchPreparePhase("launch", "running", "prepare", t("launch.progress.buildCommand"));
      setLaunchProgressPercent(85);
      setLaunchProgressText(t("launch.progress.buildCommand"));
      const playerName = readyAccount.username;
      launchResult = await invoke<LaunchExecutionResult>("launch_native_app", {
        gameDir: settings.gameDir,
        versionId: target.versionId,
        playerName,
        assetsPath,
        waitForExit: false
      });
      setLaunchProgressPercent(100);
      setLaunchProgressText(t("launch.progress.startingGame"));
      markLaunchPreparePhase("launch", "done", "complete", t("launch.progress.startingGame"));
    } catch (error) {
      const errorText = describeApiError(error, t);
      setStatus(t("app.status.launchFailed", { error: errorText }));
      setLaunchError(errorText);
      failLaunchPrepare(errorText);
      setBusy(false);
      setLaunchingInstanceId(null);
      return;
    }

    if (!launchResult) {
      setBusy(false);
      setLaunchingInstanceId(null);
      return;
    }

    await openMonitorForLaunch(launchResult.pid, target.name);
    completeLaunchPrepare();
    setBusy(false);
    setLaunchingInstanceId(null);
  }

  async function launch() {
    if (!current) return;
    await launchTarget(current);
  }

  async function install() {
    if (ensureMandatoryLauncherUpdate()) {
      return;
    }
    const { installVersion, loader, loaderVersion, optiFineEnabled, optiFineVersion } = installCtl;
    if (!installVersion) return;
    if (loader !== "vanilla" && !loaderVersion) {
      setStatus(
        t("app.status.selectLoaderVersionFirst", {
          loader: loaderDisplayName(loader)
        })
      );
      return;
    }
    if (optiFineEnabled && loader === "fabric") {
      setStatus(t("install.optifineFabricConflict"));
      return;
    }
    if (optiFineEnabled && !optiFineVersion) {
      setStatus(
        t("app.status.selectLoaderVersionFirst", {
          loader: t("loader.optifine")
        })
      );
      return;
    }

    const sessionId = createSessionId();
    const loaderPhase =
      loader === "vanilla"
        ? null
        : createPhaseState(
            loader === "forge" ? t("install.phase.forge") : t("install.phase.fabric"),
            loader
          );
    const optiFinePhase = optiFineEnabled
      ? createPhaseState(t("install.phase.optifine"), "optifine")
      : null;

    setInstallDialog({
      open: true,
      sessionId,
      versionId: installVersion,
      loader,
      canClose: false,
      cancelling: false,
      errorText: "",
      vanilla: {
        ...createPhaseState(t("install.phase.vanilla"), "vanilla"),
        status: "running",
        stage: "prepare",
        message: t("install.phase.preparing", { version: installVersion })
      },
      loaderPhase,
      optiFinePhase
    });

    setBusy(true);
    setStatus(t("app.status.installing", { version: installVersion }));
    try {
      const vanilla = await invoke<InstallResult>("install_vanilla", {
        gameDir: settings.gameDir,
        versionId: installVersion,
        downloadSource: settings.downloadSource,
        downloadThreads: settings.downloadThreads,
        ipcSession: sessionId
      });

      setInstallDialog((prev) => {
        if (!prev || prev.sessionId !== sessionId) return prev;
        return {
          ...prev,
          cancelling: false,
          vanilla: {
            ...prev.vanilla,
            status: "done",
            stage: "complete",
            message: t("install.phase.vanillaCompleted")
          }
        };
      });

      let versionId = vanilla.versionId;
      let loaderName: Loader = "vanilla";
      let loaderVer: string | undefined;

      if (loader === "fabric") {
        setInstallDialog((prev) => {
          if (!prev || !prev.loaderPhase) return prev;
          return {
            ...prev,
            loaderPhase: {
              ...prev.loaderPhase,
              status: "running",
              stage: "prepare",
              message: t("install.phase.installingFabric", { version: loaderVersion ?? "" })
            }
          };
        });

        const result = await invoke<FabricInstallResult>("install_fabric", {
          gameDir: settings.gameDir,
          gameVersion: installVersion,
          loaderVersion,
          downloadSource: settings.downloadSource,
          downloadThreads: settings.downloadThreads,
          ipcSession: sessionId
        });
        versionId = result.profileId;
        loaderName = "fabric";
        loaderVer = loaderVersion;
      }

      if (loader === "forge") {
        setInstallDialog((prev) => {
          if (!prev || !prev.loaderPhase) return prev;
          return {
            ...prev,
            loaderPhase: {
              ...prev.loaderPhase,
              status: "running",
              stage: "prepare",
              message: t("install.phase.installingForge", { version: loaderVersion ?? "" })
            }
          };
        });

        const jdk = await ensureJdk(settings.gameDir, installVersion, settings.downloadThreads);
        const result = await invoke<ForgeInstallResult>("install_forge", {
          gameDir: settings.gameDir,
          forgeVersion: loaderVersion,
          javaPath: jdk.javaPath,
          downloadSource: settings.downloadSource,
          downloadThreads: settings.downloadThreads,
          ipcSession: sessionId
        });
        versionId = result.profileId;
        loaderName = "forge";
        loaderVer = result.forgeVersion;
      }

      let installedOptiFineVersion: string | undefined;
      if (optiFineEnabled) {
        setInstallDialog((prev) => {
          if (!prev || !prev.optiFinePhase) return prev;
          return {
            ...prev,
            optiFinePhase: {
              ...prev.optiFinePhase,
              status: "running",
              stage: "prepare",
              message: t("install.phase.installingOptiFine", { version: optiFineVersion })
            }
          };
        });

        const result = await invoke<OptiFineInstallResult>("install_optifine", {
          gameDir: settings.gameDir,
          versionId,
          gameVersion: installVersion,
          loader: loaderName,
          loaderVersion: loaderVer,
          optifineVersion: optiFineVersion,
          downloadSource: settings.downloadSource,
          ipcSession: sessionId
        });
        installedOptiFineVersion = result.optiFineVersion;
      }

      const item: Instance = {
        id: `instance-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        name:
          loaderName === "vanilla"
            ? installVersion
            : `${installVersion} (${loaderName})`,
        versionId,
        baseVersion: installVersion,
        loader: loaderName,
        loaderVersion: loaderVer,
        optiFineVersion: installedOptiFineVersion,
        preset: false
      };

      setInstances((prev) => [item, ...prev]);
      setSelected(item.id);
      setPage("instances");
      setStatus(t("app.status.installed", { name: item.name }));
      setInstallDialog((prev) => {
        if (!prev || prev.sessionId !== sessionId) return prev;
        return {
          ...prev,
          canClose: true,
          cancelling: false,
          loaderPhase: prev.loaderPhase
            ? {
                ...prev.loaderPhase,
                status: "done",
                stage: "complete",
                message: t("install.phase.loaderCompleted")
              }
            : prev.loaderPhase,
          optiFinePhase: prev.optiFinePhase
            ? {
                ...prev.optiFinePhase,
                status: "done",
                stage: "complete",
                message: t("install.phase.optiFineCompleted")
              }
            : prev.optiFinePhase
        };
      });
      setInstallDialog(null);
    } catch (error) {
      const errorText = String(error);
      setStatus(t("app.status.installFailed", { error: errorText }));
      setInstallDialog((prev) => {
        if (!prev || prev.sessionId !== sessionId) return prev;
        const loaderRunning = prev.loaderPhase && prev.loaderPhase.status === "running";
        return {
          ...prev,
          canClose: true,
          cancelling: false,
          errorText,
          vanilla:
            prev.vanilla.status === "running"
              ? { ...prev.vanilla, status: "error", stage: "failed", message: errorText }
              : prev.vanilla,
          loaderPhase: loaderRunning
            ? { ...prev.loaderPhase!, status: "error", stage: "failed", message: errorText }
            : prev.loaderPhase,
          optiFinePhase:
            prev.optiFinePhase && prev.optiFinePhase.status === "running"
              ? { ...prev.optiFinePhase, status: "error", stage: "failed", message: errorText }
              : prev.optiFinePhase
        };
      });
    } finally {
      setBusy(false);
    }
  }

  function removeInstance(id: string) {
    const item = instances.find((entry) => entry.id === id);
    if (!item) return;
    if (item.preset) {
      setStatus(t("app.status.presetCannotDelete"));
      return;
    }
    if (!window.confirm(t("instances.deleteConfirm", { name: item.name }))) return;
    const next = instances.filter((entry) => entry.id !== id);
    setInstances(next);
    if (selected === id && next.length > 0) setSelected(next[0].id);
  }

  async function duplicateInstance(id: string) {
    const source = instances.find((entry) => entry.id === id);
    if (!source) return;

    const duplicatedName = createDuplicatedInstanceName(source.name, instances);
    const duplicatedVersionId = createDuplicatedVersionId(source.versionId, instances);

    try {
      await invoke<string>("duplicate_instance_storage", {
        gameDir: settings.gameDir,
        sourceVersionId: source.versionId,
        targetVersionId: duplicatedVersionId
      });
      const duplicated: Instance = {
        ...source,
        id: `instance-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        name: duplicatedName,
        versionId: duplicatedVersionId,
        launcherVersionType: source.preset ? undefined : source.launcherVersionType,
        preset: false
      };
      setInstances((prev) => [duplicated, ...prev]);
      installCtl.setInstalledVersions((prev) =>
        prev.includes(duplicatedVersionId) ? prev : [duplicatedVersionId, ...prev]
      );
      setSelected(duplicated.id);
      setStatus(t("app.status.instanceDuplicated", { name: source.name }));
    } catch (error) {
      reportFailure(error);
    }
  }

  async function exportInstance(id: string) {
    const source = instances.find((entry) => entry.id === id);
    if (!source) return;

    try {
      await invoke<InstanceExportResult>("export_instance_archive", {
        gameDir: settings.gameDir,
        versionId: source.versionId,
        archiveName: source.name
      });
      setStatus(t("app.status.instanceExported", { name: source.name }));
    } catch (error) {
      reportFailure(error);
    }
  }

  async function repairInstance(id: string) {
    if (ensureMandatoryLauncherUpdate()) {
      return;
    }
    const rawSource = instances.find((entry) => entry.id === id);
    if (!rawSource) return;
    // Nova repairs the currently-picked game version's install dir, not the fixed default.
    const source = resolveNovaEffectiveInstance(rawSource);

    setBusy(true);
    setStatus(t("app.status.instanceRepairing", { name: source.name }));
    try {
      const result = await invoke<InstanceRepairResult>("repair_instance_runtime", {
        gameDir: settings.gameDir,
        versionId: source.versionId,
        loader: source.loader,
        baseVersion: source.baseVersion,
        loaderVersion: source.loaderVersion
      });
      const repaired: Instance = {
        ...source,
        versionId: result.versionId,
        baseVersion: result.baseVersion,
        loader: result.loader,
        loaderVersion: result.loaderVersion,
        optiFineVersion: result.optiFineVersion
      };
      // Keep the Nova preset generic in state (its versionId/baseVersion are picked at launch);
      // custom/other-preset instances persist the repaired runtime ids as before.
      const isNovaPreset = rawSource.preset && rawSource.launcherVersionType === "NOVA";
      const persistedInstance = isNovaPreset ? rawSource : repaired;
      setInstances((prev) =>
        prev.map((item) => (item.id === persistedInstance.id ? persistedInstance : item))
      );
      installCtl.setInstalledVersions((prev) =>
        prev.includes(result.versionId) ? prev : [result.versionId, ...prev]
      );
      if (repaired.preset) {
        await ensurePresetModsReady(repaired);
      }
      setStatus(t("app.status.instanceRepaired", { name: source.name }));
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusy(false);
    }
  }

  function closeInstallDialog() {
    if (!installDialog?.canClose) return;
    setInstallDialog(null);
  }

  async function cancelInstallDialog() {
    const active = installDialogRef.current;
    if (!active || active.canClose || active.cancelling) return;
    setInstallDialog((prev) => (prev ? { ...prev, cancelling: true } : prev));
    try {
      await invoke("cancel_install", { sessionId: active.sessionId });
      setStatus(t("dialog.cancelling"));
    } catch (error) {
      setInstallDialog((prev) => (prev ? { ...prev, cancelling: false } : prev));
      reportFailure(error);
    }
  }

  function closeLaunchPrepareDialog() {
    if (!launchPrepareDialog?.canClose) return;
    setLaunchPrepareDialog(null);
  }

  function openLaunchPrepare(instance: Instance, sessionId: string) {
    setLaunchPrepareDialog(
      createLaunchPrepareDialogState(
        sessionId,
        instance.name,
        instance.versionId,
        {
          login: t("launch.prepare.phase.login"),
          "check-instance": t("launch.prepare.phase.check-instance"),
          verify: t("launch.prepare.phase.verify"),
          vanilla: t("launch.prepare.phase.vanilla"),
          fabric: t("launch.prepare.phase.fabric"),
          forge: t("launch.prepare.phase.forge"),
          optifine: t("launch.prepare.phase.optifine"),
          mods: t("launch.prepare.phase.mods"),
          runtime: t("launch.prepare.phase.runtime"),
          launch: t("launch.prepare.phase.launch")
        },
        t("dialog.waiting"),
        t("launch.progress.checkInstance")
      )
    );
  }

  function markLaunchPreparePhase(
    key: LaunchPreparePhaseKey,
    status: LaunchPreparePhaseState["status"],
    stage: string,
    message: string
  ) {
    setLaunchPrepareDialog((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        phases: prev.phases.map((phase) =>
          phase.key === key
            ? {
                ...phase,
                status,
                stage,
                message
              }
            : phase
        )
      };
    });
  }

  function failLaunchPrepare(errorText: string) {
    setLaunchPrepareDialog((prev) => {
      if (!prev) return prev;
      const runningPhase = prev.phases.find((phase) => phase.status === "running")?.key ?? "check-instance";
      return {
        ...prev,
        canClose: true,
        errorText,
        phases: prev.phases.map((phase) =>
          phase.key === runningPhase
            ? {
                ...phase,
                status: "error",
                stage: "failed",
                message: errorText
              }
            : phase
        )
      };
    });
  }

  function completeLaunchPrepare() {
    setLaunchPrepareDialog((prev) => {
      if (!prev) return prev;
      if (prev.errorText) {
        return {
          ...prev,
          canClose: true
        };
      }
      return {
        ...prev,
        canClose: true
      };
    });
  }

  function updateSettings(next: Settings) {
    const activeAccount = mcAccounts.currentAccount;
    if (activeAccount?.type === "offline" && next.playerName !== settings.playerName) {
      const normalizedName = next.playerName.trim();
      if (normalizedName) {
        mcAccounts.setAccounts((prev) =>
          prev.map((account) =>
            account.id === activeAccount.id
              ? {
                  ...account,
                  username: normalizedName
                }
              : account
          )
        );
      }
    }
    setSettings(next);
  }

  function updateMemory(input: string) {
    const next = Number.parseInt(input, 10);
    setSettings((prev) => ({
      ...prev,
      maxMemoryMb: Number.isFinite(next) ? clamp(next, 1024, 16384) : prev.maxMemoryMb
    }));
  }

  async function ensureMinecraftAccountReadyForLaunch(
    account: MinecraftAccount | null,
    ipcSession?: string
  ): Promise<MinecraftAccount> {
    if (!account) {
      throw new Error(t("minecraftAccount.requiredError"));
    }
    if (account.type !== "microsoft") {
      markLaunchPreparePhase("login", "done", "complete", t("launch.progress.loginOffline"));
      return account;
    }

    // A missing expiry means the stored token cannot be trusted, and a
    // needs-relogin flag from an earlier failed refresh gets one more attempt
    // here (the failure may have been transient). Only a token that is verifiably
    // valid for the whole refresh margin skips the refresh.
    if (!shouldRefreshMicrosoftAccount(account) && !account.needsRelogin) {
      markLaunchPreparePhase("login", "done", "complete", t("launch.progress.loginReady"));
      return account;
    }

    try {
      return await mcAccounts.refreshMicrosoftAccount(account.id, ipcSession);
    } catch (error) {
      // The hook already kept the account and marked it needs-relogin; surface a
      // human message in the launch dialog instead of launching with a dead token.
      const detail = describeApiError(error, t);
      throw new Error(
        detail
          ? `${t("minecraftAccount.microsoftRefreshRequired")} (${detail})`
          : t("minecraftAccount.microsoftRefreshRequired")
      );
    }
  }



  async function closeLauncherWindow() {
    if (settings.minimizeToTray) {
      await invoke("hide_main_window");
      return;
    }
    await getCurrentWindow().close();
  }

  // Stable callback identities so React.memo children (Sidebar, pages) don't
  // re-render when an unrelated piece of App state changes (#5).
  const stableNavigate = useStableCallback(navigatePage);
  const stableLaunch = useStableCallback(launch);
  const stableLaunchToServer = useStableCallback(launchToServer);
  const stableRemoveInstance = useStableCallback(removeInstance);
  const stableAddOfflineAccount = useStableCallback((username: string) => {
    mcAccounts.addOffline(username);
    setMinecraftAccountPromptOpen(false);
  });
  const stableSaveMinecraftAccount = useStableCallback((account: MinecraftAccount) => {
    mcAccounts.save(account);
    setMinecraftAccountPromptOpen(false);
  });
  const stableDeleteMinecraftAccount = useStableCallback(mcAccounts.remove);
  const stableInstall = useStableCallback(install);
  const stableUpdateSettings = useStableCallback(updateSettings);
  const stableUpdateMemory = useStableCallback(updateMemory);
  const stableLogout = useStableCallback(logoutLauncherAccount);
  const stableCloseWindow = useStableCallback(closeLauncherWindow);
  const stableOnLocaleChange = useStableCallback((locale: Locale) => {
    setSettings((prev) => ({ ...prev, language: locale }));
    setStatus(createTranslator(locale)("app.status.ready"));
  });
  const goInstall = useStableCallback(() => navigatePage("install"));
  const goSettings = useStableCallback(() => navigatePage("settings"));
  const goServers = useStableCallback(() => navigatePage("servers"));
  const goInstances = useStableCallback(() => navigatePage("instances"));
  const goContent = useStableCallback(() => navigatePage("content"));
  const onLaunchInstance = useStableCallback(async (id: string, gameVersion?: string) => {
    const target = instances.find((item) => item.id === id);
    if (!target) return;
    if (gameVersion && target.launcherVersionType === "NOVA") {
      setSelectedNovaGameVersion(gameVersion);
    }
    setSelected(id);
    const effective =
      target.launcherVersionType === "NOVA"
        ? buildNovaEffectiveInstance(target, gameVersion || selectedNovaGameVersion || target.baseVersion)
        : target;
    await launchTarget(effective);
  });
  const onOpenInstanceSettings = useStableCallback((id: string, gameVersion?: string) => {
    const target = instances.find((item) => item.id === id);
    if (gameVersion && target?.launcherVersionType === "NOVA") {
      setSelectedNovaGameVersion(gameVersion);
    }
    setSelected(id);
    navigatePage("instance-settings");
  });
  const onOpenInstanceContent = useStableCallback((id: string, gameVersion?: string) => {
    const target = instances.find((item) => item.id === id);
    if (gameVersion && target?.launcherVersionType === "NOVA") {
      setSelectedNovaGameVersion(gameVersion);
    }
    setSelected(id);
    navigatePage("content");
  });
  const onInstanceRepair = useStableCallback(() => {
    if (current) void repairInstance(current.id);
  });
  const onInstanceDelete = useStableCallback(() => {
    if (current) void removeInstance(current.id);
  });
  const onInstanceDuplicate = useStableCallback(() => {
    if (current) void duplicateInstance(current.id);
  });
  const onInstanceExport = useStableCallback(() => {
    if (current) void exportInstance(current.id);
  });
  const onUpdateInstance = useStableCallback((next: Instance) => {
    setInstances((prev) => prev.map((item) => (item.id === next.id ? next : item)));
  });
  const onModpackInstalled = useStableCallback((result: ModpackInstallResult) => {
    const item: Instance = {
      id: `instance-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      name: result.name,
      versionId: result.versionId,
      baseVersion: result.baseVersion,
      loader: result.loader,
      loaderVersion: result.loaderVersion ?? undefined,
      preset: false
    };
    setInstances((prev) => [item, ...prev]);
    installCtl.setInstalledVersions((prev) =>
      prev.includes(result.versionId) ? prev : [result.versionId, ...prev]
    );
    setSelected(item.id);
    setStatus(t("app.status.installed", { name: item.name }));
    navigatePage("instances");
  });
  const onSelectMajor = useStableCallback((nextMajor: string) => {
    installCtl.setShowSnapshots(false);
    installCtl.setMajor(nextMajor);
  });
  const onToggleSnapshots = useStableCallback(() => installCtl.setShowSnapshots((value) => !value));
  const onToggleOptiFine = useStableCallback(() => {
    if (installCtl.loader === "fabric") {
      setStatus(t("install.optifineFabricConflict"));
      return;
    }
    installCtl.setOptiFineEnabled((value) => !value);
  });
  const onRefreshServers = useStableCallback(() => launcherData.refreshServers(false));
  const onSelectNovaGameVersion = useStableCallback((gameVersion: string) => {
    setSelectedNovaGameVersion(gameVersion);
  });
  const onRefreshLauncherUpdate = useStableCallback(() => void launcherUpdate.refresh(false));
  const onInstallLauncherUpdate = useStableCallback(() => void launcherUpdate.install());
  const onSettingsReset = useStableCallback(() =>
    setSettings({
      ...DEFAULT_SETTINGS,
      gameDir: defaultGameDir,
      language: settings.language,
      themeMode: settings.themeMode,
      themeAccent: settings.themeAccent,
      customAccentHex: settings.customAccentHex
    })
  );

  const routerContext: PageRouterContext = {
    page,
    instances,
    current,
    busy,
    user: launcherAuth?.user ?? null,
    settings,
    launcherVersions,
    novaGameVersions,
    selectedNovaGameVersion,
    onSelectNovaGameVersion,
    presetPackageStatuses,
    onSelect: setSelected,
    onRemoveInstance: stableRemoveInstance,
    onLaunchInstance,
    onOpenInstanceSettings,
    onOpenInstanceContent,
    onGoContent: goContent,
    onModpackInstalled,
    onInstanceRepair,
    onInstanceDelete,
    onInstanceDuplicate,
    onInstanceExport,
    onUpdateInstance,
    launcherNews: launcherData.news,
    launcherServers: launcherData.servers,
    launcherOnlineSummary: telemetry.onlineSummary,
    launcherDashboard: launcherData.dashboard,
    currentLauncherVersion,
    onRefreshServers,
    launching,
    launchingInstanceId,
    launchProgressPercent,
    launchProgressText,
    onLaunch: stableLaunch,
    onLaunchToServer: stableLaunchToServer,
    minecraftAccounts: mcAccounts.accounts,
    currentMinecraftAccount: mcAccounts.currentAccount,
    minecraftAccountRequired: minecraftAccountPromptOpen,
    onSelectMinecraftAccount: mcAccounts.setSelectedId,
    onAddOfflineMinecraftAccount: stableAddOfflineAccount,
    onSaveMinecraftAccount: stableSaveMinecraftAccount,
    onDeleteMinecraftAccount: stableDeleteMinecraftAccount,
    launcherUpdate: launcherUpdate.appUpdate,
    launcherUpdateAvailable: launcherUpdate.available,
    launcherUpdateChannels: launcherUpdate.channels,
    launcherUpdateChecking: launcherUpdate.checking,
    launcherUpdateDownloading: launcherUpdate.downloading,
    launcherUpdateProgressPercent: launcherUpdate.progressPercent,
    launcherUpdateDownload: launcherUpdate.download,
    onRefreshLauncherUpdate,
    onInstallLauncherUpdate,
    catalogLoading: installCtl.catalogLoading,
    catalogCount: installCtl.catalog.length,
    majors: installCtl.majors,
    major: installCtl.major,
    grouped: installCtl.grouped,
    showSnapshots: installCtl.showSnapshots,
    snapshots: installCtl.snapshots,
    majorVersions: installCtl.majorVersions,
    installVersion: installCtl.installVersion,
    loader: installCtl.loader,
    loaderLoading: installCtl.loaderLoading,
    loaderOptions: installCtl.loaderOptions,
    loaderVersion: installCtl.loaderVersion,
    optiFineEnabled: installCtl.optiFineEnabled,
    optiFineLoading: installCtl.optiFineLoading,
    optiFineOptions: installCtl.optiFineOptions,
    optiFineVersion: installCtl.optiFineVersion,
    optiFineDisabledReason: installCtl.optiFineDisabledReason,
    installedVersions: installCtl.installedVersions,
    installDisabled: installCtl.installDisabled,
    installButtonText: installCtl.installButtonText,
    onSelectMajor,
    onToggleSnapshots,
    onSelectInstallVersion: installCtl.setInstallVersion,
    onSelectLoader: installCtl.setLoader,
    onSelectLoaderVersion: installCtl.setLoaderVersion,
    onToggleOptiFine,
    onSelectOptiFineVersion: installCtl.setOptiFineVersion,
    onInstall: stableInstall,
    gameDir: settings.gameDir,
    curseforgeApiKey: settings.curseforgeApiKey,
    onStatusChange: setStatus,
    onGoInstall: goInstall,
    onGoInstances: goInstances,
    onGoSettings: goSettings,
    onGoServers: goServers,
    onLogoutLauncherAccount: stableLogout,
    onChangeSettings: stableUpdateSettings,
    onClampMemory: stableUpdateMemory,
    onResetSettings: onSettingsReset
  };

  return (
    <I18nProvider
      locale={settings.language}
      onLocaleChange={stableOnLocaleChange}
    >
      <div className="launcher-shell relative flex h-screen w-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)] select-none pixel-pattern">
        {/* Drop the blurred full-window background while the monitor window is open:
            the game hogs the GPU, and a live-blurred compositor layer is the single
            most expensive thing this window paints. The video pauses (not just
            hides) whenever the window itself is hidden. */}
        <AppBackground
          url={monitorWindowOpen ? null : activeBackgroundUrl}
          videoUrl={activeBackgroundVideoUrl || null}
          opacity={settings.backgroundOpacity}
          blur={settings.blurMode === "background" ? settings.backgroundBlur : 0}
          paused={!windowVisible || monitorWindowOpen}
          hidden={monitorWindowOpen}
        />
        <WindowTitleBar version={currentLauncherVersion} onClose={stableCloseWindow} />

        {!secureStorageReady ? (
          <main className="relative z-10 flex h-full w-full flex-1 items-center justify-center overflow-hidden px-6 py-8">
            {secureStorageError ? (
              <div className="surface-panel max-w-lg rounded-[10px] p-6 text-center">
                <h1 className="page-title !text-xl">{t("secureStorage.unavailableTitle")}</h1>
                <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                  {t("secureStorage.unavailableDescription")}
                </p>
                <pre className="mt-4 max-h-32 overflow-auto whitespace-pre-wrap rounded-[8px] bg-black/25 p-3 text-left text-xs text-[var(--text-muted)]">
                  {secureStorageError}
                </pre>
                <Button variant="primary" className="mt-5" onClick={() => window.location.reload()}>
                  {t("secureStorage.retry")}
                </Button>
              </div>
            ) : (
              <PageFallback />
            )}
          </main>
        ) : authenticated ? (
          <div className="relative z-10 flex h-full w-full flex-1 pt-10">
            <Sidebar
              currentPage={page}
              user={launcherAuth?.user ?? null}
              setPage={stableNavigate}
            />

            <main className="relative flex-1 overflow-hidden border-l border-white/5 bg-[var(--bg-secondary)]/34">
              <div key={page} className="relative z-10 h-full page-transition">
                <Suspense fallback={<PageFallback />}>
                  <PageRouter ctx={routerContext} />
                </Suspense>
              </div>
            </main>
          </div>
        ) : (
          <main className="relative z-10 flex h-full w-full flex-1 items-center justify-center overflow-hidden px-6 py-8">
            <LoginPage
              loading={launcherAuthLoading}
              initialPrefs={launcherLoginPrefs}
              statusText={authNotice}
              onSubmit={loginLauncherAccount}
            />
          </main>
        )}

        {authenticated && installDialog && installDialog.open && (
          <InstallDialog dialog={installDialog} onClose={closeInstallDialog} onCancel={cancelInstallDialog} />
        )}

        {authenticated && launchPrepareDialog && launchPrepareDialog.open && (
          <LaunchPrepareDialog key={launchPrepareDialog.sessionId} dialog={launchPrepareDialog} onClose={closeLaunchPrepareDialog} />
        )}

        {authenticated && launchError && (
          <LaunchErrorDialog message={launchError} onConfirm={() => setLaunchError(null)} />
        )}

        <ToastViewport />
      </div>
    </I18nProvider>
  );
}

function PageFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/15 border-t-[var(--mc-grass)]" />
    </div>
  );
}

function selectDefaultEdgeOptiFineVersion(versions: OptiFineVersion[]): OptiFineVersion | undefined {
  return versions.find((item) => item.compatibility !== "incompatible");
}
