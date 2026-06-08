import { getVersion as getAppVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TauriEvent } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import packageInfo from "../package.json";
import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import AppLogo from "./components/AppLogo";
import Button from "./components/Button";
import Card from "./components/Card";
import InstallDialog from "./components/InstallDialog";
import LaunchPrepareDialog from "./components/LaunchPrepareDialog";
import Sidebar from "./components/Sidebar";
import {
  DEFAULT_SETTINGS,
  LAUNCHER_API_BASE_URL,
  NEWS_ITEMS,
  PRESET_INSTANCES,
  STORAGE_KEYS,
  resolvePresetVersionId
} from "./constants";
import {
  createTranslator,
  I18nProvider,
  resolveLocale
} from "./i18n";
import HomePage from "./pages/Home";
import InstanceSettingsPage from "./pages/InstanceSettings";
import InstallPage from "./pages/Install";
import InstancesPage from "./pages/Instances";
import LoginPage from "./pages/Login";
import MonitorPage from "./pages/Monitor";
import ServersPage from "./pages/Servers";
import ContentPage from "./pages/Content";
import MandatoryUpdatePage from "./pages/MandatoryUpdate";
import AccountCenterPage from "./pages/AccountCenter";
import SettingsPage from "./pages/Settings";
import type {
  LauncherAppUpdateChannel,
  DownloadedLauncherUpdate,
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
  InstanceImportResult,
  InstanceRepairResult,
  LaunchPrepareDialogState,
  LaunchPrepareItem,
  LaunchPrepareItemStatus,
  LaunchPreparePhaseKey,
  LaunchPreparePhaseState,
  LauncherAppUpdateInfo,
  LauncherLoginResult,
  LauncherModsInstallResult,
  LauncherPackageState,
  NewsItem,
  LauncherUser,
  LauncherVersion,
  LauncherVersionType,
  JdkEnsureResult,
  LauncherDashboard,
  LauncherHomePayload,
    LauncherLoginPrefs,
    Locale,
    LaunchExecutionResult,
  Loader,
  MinecraftAccount,
  OptiFineInstallResult,
  OptiFineVersion,
    Page,
  PresetPackageStatus,
  ServerItem,
  Settings,
  TelemetryOnlineSummary,
  UiLogPollResult
} from "./types";
import {
  clamp,
  compareMajor,
  createPhaseState,
  createLaunchPrepareDialogState,
  createSessionId,
  groupByMajor,
  isSnapshot,
  applyTheme,
  loadInstances,
  loadSettings,
  parseInstallIpc,
  resolveBackgroundAssetUrl,
  resolveInstallVersion
} from "./utils/launcher";
import { loadSecureRaw, persistSecureJson } from "./utils/secureStorage";

type LauncherAuthState = {
  token: string;
  user: LauncherUser;
};

const DEFAULT_LOGIN_PREFS: LauncherLoginPrefs = {
  usernameOrEmail: "",
  password: "",
  rememberPassword: false,
  autoLogin: false
};

type LauncherVersionMap = Record<LauncherVersionType, LauncherVersion | null>;

const FALLBACK_LAUNCHER_VERSION = packageInfo.version;
const LAUNCHER_ONLINE_REFRESH_INTERVAL_MS = 90_000;
const LAUNCHER_ONLINE_REFRESH_JITTER_MS = 8_000;
const LAUNCHER_LOG_POLL_INTERVAL_MS = 500;
const LAUNCHER_RUNTIME_POLL_INTERVAL_MS = 1000;
const LAUNCH_PREPARE_STEPS = 5;

const EMPTY_LAUNCHER_VERSIONS: LauncherVersionMap = {
  EDGE: null,
  NOVA: null
};

export function App() {
  useEffect(() => {
    const settings = loadSettings();
    applyTheme(settings.themeMode, settings.themeAccent, settings.customAccentHex);
  }, []);

  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "monitor") {
    const locale = resolveLocale(params.get("lang") ?? readStoredLocale());
    return (
      <I18nProvider locale={locale} onLocaleChange={() => {}}>
        <MonitorPage params={params} />
      </I18nProvider>
    );
  }
  return <Launcher />;
}

function Launcher() {
  const [page, setPage] = useState<Page>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 1120 : false
  );
  const [instances, setInstances] = useState<Instance[]>(loadInstances);
  const [selected, setSelected] = useState<string>(
    localStorage.getItem(STORAGE_KEYS.selected) ?? PRESET_INSTANCES[0].id
  );
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [minecraftAccounts, setMinecraftAccounts] = useState<MinecraftAccount[]>([]);
  const [selectedMinecraftAccountId, setSelectedMinecraftAccountId] = useState<string | null>(() =>
    loadSelectedMinecraftAccountId()
  );
  const [launcherAuth, setLauncherAuth] = useState<LauncherAuthState | null>(null);
  const [launcherLoginPrefs, setLauncherLoginPrefs] = useState<LauncherLoginPrefs>(DEFAULT_LOGIN_PREFS);
  const [secureStorageReady, setSecureStorageReady] = useState(false);
  const [launcherVersions, setLauncherVersions] = useState<LauncherVersionMap>(EMPTY_LAUNCHER_VERSIONS);
  const [currentLauncherVersion, setCurrentLauncherVersion] = useState(FALLBACK_LAUNCHER_VERSION);
  const [launcherNews, setLauncherNews] = useState<NewsItem[]>([]);
  const [launcherServers, setLauncherServers] = useState<ServerItem[]>([]);
  const [launcherDashboard, setLauncherDashboard] = useState<LauncherDashboard | null>(null);
  const [launcherOnlineSummary, setLauncherOnlineSummary] = useState<TelemetryOnlineSummary | null>(null);
  const [launcherAppUpdate, setLauncherAppUpdate] = useState<LauncherAppUpdateInfo | null>(null);
  const [launcherAppUpdateChannels, setLauncherAppUpdateChannels] = useState<LauncherAppUpdateChannel[]>([]);
  const [launcherAppUpdateChecking, setLauncherAppUpdateChecking] = useState(false);
  const [launcherAppUpdateDownloading, setLauncherAppUpdateDownloading] = useState(false);
  const [launcherAppUpdateDownload, setLauncherAppUpdateDownload] = useState<DownloadedLauncherUpdate | null>(null);
  const [presetPackageStatuses, setPresetPackageStatuses] = useState<Record<string, PresetPackageStatus>>({});
  const [launcherAuthLoading, setLauncherAuthLoading] = useState(false);
  const [launcherVersionLoading, setLauncherVersionLoading] = useState(false);
  const [defaultGameDir, setDefaultGameDir] = useState(() => DEFAULT_SETTINGS.gameDir);
  const [busy, setBusy] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [loaderLoading, setLoaderLoading] = useState(false);
  const [status, setStatus] = useState(() =>
    createTranslator(loadSettings().language)("app.status.ready")
  );
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<string[]>([]);
  const [major, setMajor] = useState("");
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [installVersion, setInstallVersion] = useState("");
  const [loader, setLoader] = useState<Loader>("vanilla");
  const [loaderOptions, setLoaderOptions] = useState<string[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [optiFineEnabled, setOptiFineEnabled] = useState(false);
  const [optiFineLoading, setOptiFineLoading] = useState(false);
  const [optiFineOptions, setOptiFineOptions] = useState<OptiFineVersion[]>([]);
  const [optiFineVersion, setOptiFineVersion] = useState("");
  const [installedVersions, setInstalledVersions] = useState<string[]>([]);
  const [activeGamePid, setActiveGamePid] = useState<number | null>(null);
  const [launchingInstanceId, setLaunchingInstanceId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchProgressPercent, setLaunchProgressPercent] = useState<number | null>(null);
  const [launchProgressText, setLaunchProgressText] = useState("");
  const [monitorWindowOpen, setMonitorWindowOpen] = useState(false);

  const [installDialog, setInstallDialog] = useState<InstallDialogState | null>(null);
  const [launchPrepareDialog, setLaunchPrepareDialog] = useState<LaunchPrepareDialogState | null>(null);
  const [titlebarBusy, setTitlebarBusy] = useState(false);
  const [windowVisible, setWindowVisible] = useState(false);
  const launcherSessionIdRef = useRef(loadOrCreateLauncherSessionId());
  const launcherAuthTokenRef = useRef<string | null>(launcherAuth?.token?.trim() ?? null);
  const autoLoginAttemptedRef = useRef(false);

  const logCursorRef = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const loaderRequestRef = useRef(0);
  const optiFineRequestRef = useRef(0);
  const lastInstallPageRef = useRef(false);
  const launchingInstanceRef = useRef<string | null>(null);
  const installDialogRef = useRef<InstallDialogState | null>(null);
  const launchPrepareDialogRef = useRef<LaunchPrepareDialogState | null>(null);

  const t = useMemo(() => createTranslator(settings.language), [settings.language]);
  const launcherAppUpdateAvailable = useMemo(
    () =>
      launcherAppUpdate !== null &&
      compareMajor(launcherAppUpdate.version, currentLauncherVersion) > 0,
    [currentLauncherVersion, launcherAppUpdate]
  );
  const launcherMandatoryUpdateRequired =
    launcherAppUpdateAvailable && Boolean(launcherAppUpdate?.mandatory);

  const current = useMemo(
    () => instances.find((item) => item.id === selected) ?? instances[0] ?? null,
    [instances, selected]
  );
  const currentMinecraftAccount = useMemo(() => {
    if (minecraftAccounts.length === 0) {
      return null;
    }
    return minecraftAccounts.find((item) => item.id === selectedMinecraftAccountId) ?? minecraftAccounts[0];
  }, [minecraftAccounts, selectedMinecraftAccountId]);
  const grouped = useMemo(() => groupByMajor(catalog), [catalog]);
  const majors = useMemo(() => Object.keys(grouped).sort((a, b) => compareMajor(b, a)), [grouped]);
  const majorVersions = major ? grouped[major] ?? [] : [];
  const effectiveSidebarCollapsed = compactLayout ? true : sidebarCollapsed;
  const backgroundMode = settings.minimizeToTray && !windowVisible;
  const activeBackgroundUrl =
    resolveBackgroundAssetUrl(settings);
  const snapshots = useMemo(() => catalog.filter(isSnapshot), [catalog]);
  const authenticated = Boolean(launcherAuth?.token?.trim());
  const launching = busy && launchingInstanceId !== null;
  const installDisabled =
    busy ||
    catalogLoading ||
    !installVersion ||
    (loader !== "vanilla" && (loaderLoading || !loaderVersion)) ||
    (optiFineEnabled && (optiFineLoading || !optiFineVersion || loader === "fabric"));
  const optiFineDisabledReason =
    loader === "fabric" ? t("install.optifineFabricConflict") : "";
  const loaderDisplayName = (value: Loader) => t(loaderLabelKey(value));
  const installButtonText = busy
    ? t("install.button.installing")
    : catalogLoading
      ? t("install.button.syncing")
      : loader !== "vanilla" && loaderLoading
        ? t("install.button.loadingLoader", { loader: loaderDisplayName(loader) })
        : t("install.button.installSelected");

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
      const [authRaw, prefsRaw, accountsRaw] = await Promise.all([
        loadSecureRaw(STORAGE_KEYS.launcherAuth),
        loadSecureRaw(STORAGE_KEYS.launcherLoginPrefs),
        loadSecureRaw(STORAGE_KEYS.minecraftAccounts)
      ]);
      if (cancelled) return;
      setLauncherAuth(authRaw === null ? null : parseLauncherAuthState(authRaw));
      setLauncherLoginPrefs(prefsRaw === null ? DEFAULT_LOGIN_PREFS : parseLauncherLoginPrefs(prefsRaw));
      const fallbackPlayerName = settings.playerName.trim() || "Player";
      const accounts = accountsRaw === null ? [] : parseMinecraftAccounts(accountsRaw);
      setMinecraftAccounts(
        accounts.length > 0 ? accounts : [createOfflineMinecraftAccount(fallbackPlayerName)]
      );
      setSecureStorageReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!secureStorageReady) return;
    void persistSecureJson(STORAGE_KEYS.minecraftAccounts, minecraftAccounts).catch((error) => {
      console.warn("[secure-storage] failed to persist minecraftAccounts:", error);
    });
  }, [minecraftAccounts, secureStorageReady]);

  useEffect(() => {
    if (selectedMinecraftAccountId) {
      localStorage.setItem(STORAGE_KEYS.selectedMinecraftAccount, selectedMinecraftAccountId);
      return;
    }
    localStorage.removeItem(STORAGE_KEYS.selectedMinecraftAccount);
  }, [selectedMinecraftAccountId]);

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
      setLauncherDashboard(null);
      setLauncherOnlineSummary(null);
      setPresetPackageStatuses({});
      setPage("home");
      if (!backgroundMode) {
        void refreshLauncherHome(true);
      }
      return;
    }
    if (backgroundMode) {
      return;
    }
    void cacheLauncherTelemetrySession();
    void refreshLauncherVersions(true);
    void refreshLauncherHome(true, launcherAuth.token);
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
    const currentToken = launcherAuth?.token?.trim() ?? null;
    const previousToken = launcherAuthTokenRef.current;

    if (!currentToken) {
      if (previousToken) {
        void flushLauncherTelemetrySession();
      }
      launcherAuthTokenRef.current = null;
      return;
    }

    void cacheLauncherTelemetrySession();
    launcherAuthTokenRef.current = currentToken;
  }, [launcherAuth?.token, launcherAuth?.user?.id, launcherAuth?.user?.username, settings.playerName]);

  useEffect(() => {
    const token = launcherAuth?.token?.trim();
    if (!token) {
      setLauncherOnlineSummary(null);
      return;
    }

    let active = true;

    // Start heartbeat in Rust backend
    const startHeartbeat = async () => {
      try {
        await invoke("start_launcher_heartbeat");
      } catch (error) {
        if (active && isAuthExpiredError(error)) {
          handleAuthExpired(t("login.sessionExpired"));
        }
      }
    };

    const loadOnline = async () => {
      if (backgroundMode) {
        return;
      }
      try {
        const summary = await fetchTelemetryOnlineSummary();
        if (active) {
          setLauncherOnlineSummary(summary);
        }
      } catch (error) {
        if (active && isAuthExpiredError(error)) {
          handleAuthExpired(t("login.sessionExpired"));
          return;
        }
        if (active) {
          setLauncherOnlineSummary(null);
        }
      }
    };

    let onlineTimer: number | null = null;
    const scheduleOnlineRefresh = () => {
      onlineTimer = window.setTimeout(async () => {
        await loadOnline();
        if (active && !backgroundMode) {
          scheduleOnlineRefresh();
        }
      }, nextRecurringDelay(LAUNCHER_ONLINE_REFRESH_INTERVAL_MS, LAUNCHER_ONLINE_REFRESH_JITTER_MS));
    };

    void startHeartbeat();
    if (!backgroundMode) {
      void loadOnline();
      scheduleOnlineRefresh();
    }

    return () => {
      active = false;
      // Stop heartbeat when token changes or component unmounts
      invoke("stop_launcher_heartbeat").catch(() => {});
      if (onlineTimer !== null) {
        window.clearTimeout(onlineTimer);
      }
    };
  }, [launcherAuth?.token, launcherAuth?.user?.username, backgroundMode]);

  useEffect(() => {
    if (minecraftAccounts.length === 0) {
      const fallback = createOfflineMinecraftAccount(
        settings.playerName.trim() || launcherAuth?.user?.username?.trim() || "Player"
      );
      setMinecraftAccounts([fallback]);
      setSelectedMinecraftAccountId(fallback.id);
      return;
    }
    if (!selectedMinecraftAccountId || !minecraftAccounts.some((item) => item.id === selectedMinecraftAccountId)) {
      setSelectedMinecraftAccountId(minecraftAccounts[0].id);
    }
  }, [launcherAuth?.user?.username, minecraftAccounts, selectedMinecraftAccountId, settings.playerName]);

  useEffect(() => {
    const nextPlayerName = currentMinecraftAccount?.username?.trim();
    if (!nextPlayerName || settings.playerName === nextPlayerName) {
      return;
    }
    setSettings((prev) => ({ ...prev, playerName: nextPlayerName }));
  }, [currentMinecraftAccount?.username, settings.playerName]);

  useEffect(() => {
    let disposed = false;
    let unlistenVisible: (() => void) | undefined;
    let unlistenHidden: (() => void) | undefined;

    const bind = async () => {
      try {
        const currentWindow = getCurrentWindow();
        const visible = await currentWindow.isVisible();
        if (!disposed) {
          setWindowVisible(visible);
        }
        unlistenVisible = await listen("tauri://window-shown", () => setWindowVisible(true));
        unlistenHidden = await listen("tauri://window-hidden", () => setWindowVisible(false));
      } catch {
      }
    };

    void bind();
    return () => {
      disposed = true;
      if (unlistenVisible) {
        unlistenVisible();
      }
      if (unlistenHidden) {
        unlistenHidden();
      }
    };
  }, []);

  useEffect(() => {
    if (backgroundMode || launcherAuth?.token) {
      return;
    }
    void refreshLauncherHome(true);
  }, [backgroundMode, launcherAuth?.token]);

  useEffect(() => {
    void refreshLauncherAppUpdateChannels();
  }, []);

  useEffect(() => {
    void refreshLauncherAppUpdate(true);
  }, [settings.launcherUpdateChannel]);

  useEffect(() => {
    applyTheme(settings.themeMode, settings.themeAccent, settings.customAccentHex);
  }, [settings.themeMode, settings.themeAccent, settings.customAccentHex]);

  useEffect(() => {
    if (current) localStorage.setItem(STORAGE_KEYS.selected, current.id);
  }, [current]);

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

  useEffect(() => {
    const inInstall = page === "install";
    if (inInstall && !lastInstallPageRef.current) {
      void refreshCatalog();
    }
    lastInstallPageRef.current = inInstall;
  }, [page]);

  useEffect(() => {
    if (catalog.length === 0) return;
    const nextVersion = resolveInstallVersion(catalog, grouped, major, showSnapshots, installVersion);
    if (nextVersion !== installVersion) {
      setInstallVersion(nextVersion);
    }
  }, [catalog, grouped, major, showSnapshots, installVersion]);

  useEffect(() => {
    loaderRequestRef.current += 1;
    setLoaderOptions([]);
    setLoaderVersion("");
    if (page !== "install" || loader === "vanilla" || !installVersion) {
      setLoaderLoading(false);
      return;
    }
    void refreshLoader();
  }, [page, loader, installVersion]);

  useEffect(() => {
    if (loader === "fabric" && optiFineEnabled) {
      setOptiFineEnabled(false);
    }
  }, [loader, optiFineEnabled]);

  useEffect(() => {
    optiFineRequestRef.current += 1;
    setOptiFineOptions([]);
    setOptiFineVersion("");
    if (page !== "install" || !optiFineEnabled || !installVersion || loader === "fabric") {
      setOptiFineLoading(false);
      return;
    }
    if (loader !== "vanilla" && !loaderVersion) {
      setOptiFineLoading(false);
      return;
    }
    void refreshOptiFine();
  }, [page, optiFineEnabled, installVersion, loader, loaderVersion]);

  const shouldPollUiLogs =
    windowVisible &&
    !monitorWindowOpen &&
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
    if (monitorWindowOpen) return;
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
  }, [activeGamePid, windowVisible, monitorWindowOpen]);

  useEffect(() => {
    void syncAutostart(settings.launchOnStartup);
  }, [settings.launchOnStartup]);

  useEffect(() => {
    void syncTrayBehavior(settings.minimizeToTray);
  }, [settings.minimizeToTray]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      setCompactLayout(window.innerWidth < 1120);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
        current: typeof ipc.current === "number" ? ipc.current : currentPhase.current,
        total: typeof ipc.total === "number" ? ipc.total : currentPhase.total,
        downloaded: typeof ipc.downloaded === "number" ? ipc.downloaded : currentPhase.downloaded,
        cached: typeof ipc.cached === "number" ? ipc.cached : currentPhase.cached,
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
        current: typeof ipc.current === "number" ? ipc.current : currentPhase.current,
        total: typeof ipc.total === "number" ? ipc.total : currentPhase.total,
        downloaded: typeof ipc.downloaded === "number" ? ipc.downloaded : currentPhase.downloaded,
        cached: typeof ipc.cached === "number" ? ipc.cached : currentPhase.cached,
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
          cancelling: false,
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
    const out: LauncherVersionMap = { EDGE: null, NOVA: null };
    const scoreOf = (item: LauncherVersion): number => {
      const raw = item.createdAt ?? "";
      const parsed = Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    };

    for (const item of entries) {
      if (item.versionType !== "EDGE" && item.versionType !== "NOVA") continue;
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

  async function refreshLauncherVersions(
    silent = false,
    tokenOverride?: string
  ): Promise<{ map: LauncherVersionMap | null; error: string | null }> {
    const token = (tokenOverride ?? launcherAuth?.token ?? "").trim();
    if (!token) {
      setLauncherVersions(EMPTY_LAUNCHER_VERSIONS);
      return { map: null, error: t("app.status.authRequiredForPreset") };
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
      setLauncherVersions(map);
      void refreshPresetPackageStatuses(map);
      if (!silent) {
        const count = entries.length;
        setStatus(t("app.status.loadedLauncherVersions", { count }));
      }
      return { map, error: null };
    } catch (error) {
      const errorText = formatLaunchError(error);
      if (token && isAuthExpiredError(error)) {
        handleAuthExpired(t("login.sessionExpired"));
        return { map: null, error: t("login.sessionExpired") };
      }
      if (!silent) {
        setStatus(t("app.status.failed", { error: errorText }));
      }
      return { map: null, error: errorText };
    } finally {
      setLauncherVersionLoading(false);
    }
  }

  async function syncPresetLauncherPackages(versionMap?: LauncherVersionMap | null): Promise<void> {
    const targetMap = versionMap ?? launcherVersions;
    const presetInstances = instances.filter(
      (item) => item.preset && item.launcherVersionType && targetMap[item.launcherVersionType]
    );
    if (presetInstances.length === 0) {
      return;
    }

    for (const instance of presetInstances) {
      try {
        await ensurePresetModsReady(instance, targetMap);
      } catch {
        // Keep sync best-effort to avoid blocking login flow.
      }
    }
  }

  async function refreshPresetPackageStatuses(
    versionMapOverride?: LauncherVersionMap | null
  ): Promise<void> {
    const targetMap = versionMapOverride ?? launcherVersions;
    const nextEntries = await Promise.all(
      instances
        .filter((item) => item.preset && item.launcherVersionType)
        .map(async (instance) => {
          const presetAccess = resolvePresetAccessState(instance, launcherAuth?.user ?? null, targetMap);
          if (presetAccess.state === "beta" || presetAccess.state === "pending-release") {
            return [instance.id, createPresetPackageStatus(presetAccess.state, {
              versionTag: presetAccess.versionTag ?? null,
              targetVersionTag: presetAccess.versionTag ?? null,
              changelog: presetAccess.changelog ?? null,
              lastError: presetAccess.lastError ?? null
            })] as const;
          }
          const expected = targetMap[instance.launcherVersionType!];
          if (!expected) {
            return [instance.id, createPresetPackageStatus("missing")] as const;
          }
          try {
            const state = await invoke<LauncherPackageState>("get_launcher_package_state", {
              gameDir: settings.gameDir,
              versionId: instance.versionId,
              expectedVersionTag: expected.versionName,
              expectedChecksum: expected.checksum,
              expectedManifestUrl: expected.manifestUrl,
              expectedDownloadUrl: expected.downloadUrl
            });
            const mapped: PresetPackageStatus = !state.installed
              ? createPresetPackageStatus("missing", {
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
            return [instance.id, mapped] as const;
          } catch (error) {
            return [
              instance.id,
              createPresetPackageStatus("error", {
                versionTag: expected.versionName,
                targetVersionTag: expected.versionName,
                changelog: expected.changelog,
                lastError: formatLaunchError(error)
              })
            ] as const;
          }
        })
    );
    setPresetPackageStatuses(Object.fromEntries(nextEntries));
  }

  async function refreshLauncherHome(silent = false, tokenOverride?: string): Promise<void> {
    const token = (tokenOverride ?? launcherAuth?.token ?? "").trim();
    try {
      const payload = await invoke<LauncherHomePayload>("launcher_get_home", {
        baseUrl: LAUNCHER_API_BASE_URL,
        token: token || null
      });
      setLauncherNews(payload.news ?? []);
      setLauncherServers(payload.servers ?? []);
      setLauncherOnlineSummary(payload.online ?? null);
      if (payload.dashboard) {
        setLauncherDashboard(payload.dashboard);
        setLauncherAuth((prev) =>
          prev
            ? {
                ...prev,
                user: {
                  ...prev.user,
                  ...payload.dashboard?.user
                }
              }
            : prev
        );
      } else if (!token) {
        setLauncherDashboard(null);
      }
      if (!silent) {
        setStatus(t("app.status.ready"));
      }
    } catch (error) {
      const errorText = formatLaunchError(error);
      if (token && isAuthExpiredError(error)) {
        handleAuthExpired(t("login.sessionExpired"));
        return;
      }
      if (!token) {
        setLauncherNews([]);
        setLauncherServers([]);
        setLauncherOnlineSummary(null);
      }
      if (!silent) {
        setStatus(t("app.status.failed", { error: errorText }));
      }
    }
  }

  async function refreshLauncherNews(silent = false): Promise<void> {
    try {
      const items = await invoke<NewsItem[]>("launcher_list_news", {
        baseUrl: LAUNCHER_API_BASE_URL,
        limit: 4
      });
      if (items.length > 0) {
        setLauncherNews(items);
        if (!silent) {
          setStatus(t("app.status.loadedLauncherNews", { count: items.length }));
        }
      } else {
        setLauncherNews([]);
      }
    } catch (error) {
      setLauncherNews([]);
      if (!silent) {
        setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
      }
    }
  }

  async function refreshLauncherServers(silent = false): Promise<void> {
    try {
      const token = (launcherAuth?.token ?? "").trim();
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const response = await fetch(`${LAUNCHER_API_BASE_URL}/api/v1/launcher/servers`, {
        headers
      });
      const raw = await response.json();
      const data = (raw as { success?: boolean; data?: ServerItem[] })?.data ?? [];
      setLauncherServers(data);
      if (!silent) {
        setStatus(t("app.status.loadedServers", { count: data.length }));
      }
    } catch (error) {
      if (!silent) {
        setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
      }
    }
  }

  async function launchToServer(serverAddress: string): Promise<void> {
    if (!current) {
      setStatus(t("servers.noInstance"));
      return;
    }
    if (ensureMandatoryLauncherUpdate()) {
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
      const readyAccount = await ensureMinecraftAccountReadyForLaunch(currentMinecraftAccount, sessionId);
      markLaunchPreparePhase("login", "done", "complete", t("launch.progress.loginCompleted"));
      const launchIdentity = resolveMinecraftLaunchIdentity(readyAccount, settings.playerName);
      markLaunchPreparePhase("check-instance", "running", "prepare", t("launch.progress.checkInstance"));
      setLaunchProgressPercent(Math.round((1 / LAUNCH_PREPARE_STEPS) * 100));
      setLaunchProgressText(t("launch.progress.checkInstance"));
      const prepared = await ensureInstanceReadyForLaunch(current, sessionId);
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
        maxMemoryMb: settings.maxMemoryMb,
        javaPath: jdk.javaPath,
        downloadSource: settings.downloadSource,
        waitForExit: false,
        serverAddress: serverAddress
      });
      setLaunchProgressPercent(100);
      setLaunchProgressText(t("launch.progress.startingGame"));
      markLaunchPreparePhase("launch", "done", "complete", t("launch.progress.startingGame"));
    } catch (error) {
      const errorText = formatLaunchError(error);
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

    try {
      const monitorWindow = await openMonitor(
        launchResult.pid,
        current.name,
        logCursorRef.current ?? 0,
        settings.language
      );
      setMonitorWindowOpen(true);
      void monitorWindow.once(TauriEvent.WINDOW_DESTROYED, () => {
        setMonitorWindowOpen(false);
      });
      if (settings.hideMainOnLaunch) {
        await getCurrentWindow().hide();
      }
      setActiveGamePid(launchResult.pid);
      setStatus(t("app.status.gameStarted", { pid: launchResult.pid }));
    } catch (error) {
      setStatus(
        t("app.status.gameStartedMonitorFailed", {
          pid: launchResult.pid,
          error: String(error)
        })
      );
    } finally {
      completeLaunchPrepare();
      setBusy(false);
      setLaunchingInstanceId(null);
    }
  }

  async function refreshLauncherDashboard(silent = false, tokenOverride?: string): Promise<void> {
    const token = (tokenOverride ?? launcherAuth?.token ?? "").trim();
    if (!token) {
      setLauncherDashboard(null);
      return;
    }

    try {
      const item = await invoke<LauncherDashboard>("launcher_get_dashboard", {
        baseUrl: LAUNCHER_API_BASE_URL,
        token
      });
      setLauncherDashboard(item);
      setLauncherAuth((prev) =>
        prev
          ? {
              ...prev,
              user: {
                ...prev.user,
                ...item.user
              }
            }
          : prev
      );
      if (!silent) {
        setStatus(t("app.status.ready"));
      }
    } catch (error) {
      const errorText = formatLaunchError(error);
      if (token && isAuthExpiredError(error)) {
        handleAuthExpired(t("login.sessionExpired"));
        return;
      }
      setLauncherDashboard(null);
      if (!silent) {
        setStatus(t("app.status.failed", { error: errorText }));
      }
    }
  }

  async function refreshLauncherAppUpdateChannels(): Promise<void> {
    try {
      const items = await invoke<LauncherAppUpdateChannel[]>("launcher_list_app_update_channels", {
        baseUrl: LAUNCHER_API_BASE_URL,
        token: launcherAuth?.token ?? null
      });
      setLauncherAppUpdateChannels(items);
    } catch {
      setLauncherAppUpdateChannels([]);
    }
  }

  async function refreshLauncherAppUpdate(silent = false): Promise<void> {
    setLauncherAppUpdateChecking(true);
    try {
      const info = await invoke<LauncherAppUpdateInfo>("launcher_get_app_update", {
        baseUrl: LAUNCHER_API_BASE_URL,
        channel: settings.launcherUpdateChannel
      });
      setLauncherAppUpdate(info);
      setLauncherAppUpdateDownload((prev) =>
        prev?.version === info.version ? prev : null
      );
      if (!silent) {
        setStatus(
          compareMajor(info.version, currentLauncherVersion) > 0
            ? t("settings.launcherUpdateAvailable", { version: info.version })
            : t("settings.launcherUpToDate")
        );
      }
    } catch (error) {
      const errorText = formatLaunchError(error);
      if (isLauncherAppUpdateMissing(errorText)) {
        setLauncherAppUpdate(null);
        setLauncherAppUpdateDownload(null);
      } else if (!silent) {
        setStatus(t("app.status.failed", { error: errorText }));
      }
    } finally {
      setLauncherAppUpdateChecking(false);
    }
  }

  async function installLauncherAppUpdate(): Promise<void> {
    if (!launcherAppUpdate || !launcherAppUpdateAvailable) {
      return;
    }

    setLauncherAppUpdateDownloading(true);
    try {
      setStatus(t("settings.launcherUpdateDownloading", { version: launcherAppUpdate.version }));
      const download = await invoke<DownloadedLauncherUpdate>("download_launcher_app_update", {
        downloadUrl: launcherAppUpdate.downloadUrl,
        version: launcherAppUpdate.version,
        checksum: launcherAppUpdate.checksum
      });
      setLauncherAppUpdateDownload(download);
      await invoke("open_downloaded_file", { filePath: download.filePath });
      setStatus(t("settings.launcherUpdateInstallerOpened", { file: download.fileName }));
      await flushLauncherTelemetrySession();
      await invoke("quit_launcher_app");
    } catch (error) {
      setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
    } finally {
      setLauncherAppUpdateDownloading(false);
    }
  }

  async function cacheLauncherTelemetrySession(
    sessionUser?: { id?: string | null; username?: string | null }
  ): Promise<void> {
    try {
      await invoke("launcher_cache_telemetry_session", {
        session: buildLauncherTelemetrySession(sessionUser)
      });
    } catch {
    }
  }

  async function flushLauncherTelemetrySession(): Promise<void> {
    try {
      await invoke("launcher_offline_telemetry_session");
    } catch {
    }
  }

  function buildLauncherTelemetrySession(sessionUser?: { id?: string | null; username?: string | null }) {
    const user = sessionUser ?? launcherAuth?.user ?? null;
    return {
      baseUrl: LAUNCHER_API_BASE_URL,
      clientName: "fpsmaster-launcher",
      clientKind: "LAUNCHER",
      sessionId: launcherSessionIdRef.current,
      username: user?.username ?? settings.playerName,
      playerUuid: user?.id ?? null
    };
  }

  async function fetchTelemetryOnlineSummary(): Promise<TelemetryOnlineSummary> {
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
    void flushLauncherTelemetrySession();
    setLauncherAuth(null);
    setLauncherVersions(EMPTY_LAUNCHER_VERSIONS);
    setLauncherDashboard(null);
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
        return "登录异常: 未能读取到有效 token";
      }
      setLauncherAuth({
        token: normalizedToken,
        user: result.user ?? {}
      });
      autoLoginAttemptedRef.current = false;
      void cacheLauncherTelemetrySession({
        username: result.user?.username,
        id: result.user?.id ?? null
      });
      void refreshLauncherHome(true, normalizedToken);
      const refresh = await refreshLauncherVersions(false, normalizedToken);
      if (!refresh.error && refresh.map) {
        void syncPresetLauncherPackages(refresh.map);
      }
      setPage("home");
      return refresh.error;
    } catch (error) {
      const errorText = normalizeLoginError(error, t);
      if (!silent) {
        setStatus(t("app.status.failed", { error: errorText }));
      }
      return errorText;
    } finally {
      setLauncherAuthLoading(false);
    }
  }

  function logoutLauncherAccount() {
    void flushLauncherTelemetrySession();
    setLauncherAuth(null);
    setLauncherVersions(EMPTY_LAUNCHER_VERSIONS);
    setLauncherDashboard(null);
    setPresetPackageStatuses({});
    setPage("home");
    setAuthNotice(t("login.tip.signInToContinue"));
    setStatus(t("login.tip.signInToContinue"));
  }

  async function ensurePresetModsReady(
    instance: Instance,
    versionMapOverride?: LauncherVersionMap | null
  ) {
    if (!instance.preset || !instance.launcherVersionType) return;

    const presetAccess = resolvePresetAccessState(instance, launcherAuth?.user ?? null, versionMapOverride ?? launcherVersions);
    if (presetAccess.state === "beta" || presetAccess.state === "pending-release") {
      setPresetPackageStatuses((prev) => ({
        ...prev,
        [instance.id]: createPresetPackageStatus(presetAccess.state, {
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

    let targetVersion =
      versionMapOverride?.[instance.launcherVersionType] ??
      launcherVersions[instance.launcherVersionType];
    if (!targetVersion) {
      const refresh = await refreshLauncherVersions(true, token);
      if (refresh.error) {
        throw new Error(refresh.error);
      }
      targetVersion = refresh.map?.[instance.launcherVersionType] ?? null;
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
    try {
      const result = await invoke<LauncherModsInstallResult>("install_launcher_version_mods", {
        gameDir: settings.gameDir,
        versionId: instance.versionId,
        downloadUrl: targetVersion.downloadUrl,
        checksum: targetVersion.checksum,
        manifestUrl: targetVersion.manifestUrl,
        versionTag: targetVersion.versionName,
        cleanExisting: false
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
        result.skipped
          ? t("app.status.autoInstallModsUpToDate")
          : t("app.status.autoInstallModsDone", { count: result.installedFiles })
      );
    } catch (error) {
      const errorText = formatLaunchError(error);
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
    const presetVersionId = instance.preset ? resolvePresetVersionId(instance.id) : null;
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

    const needsLoaderProfile =
      workingInstance.loader !== "vanilla" && workingInstance.versionId === workingInstance.baseVersion;

    if (!needsLoaderProfile) {
      const installed = await invoke<boolean>("is_version_installed", {
        gameDir: settings.gameDir,
        versionId: workingInstance.versionId
      });
      if (installed) {
        markLaunchPreparePhase("check-instance", "done", "complete", t("launch.progress.checkInstance"));
        if (workingInstance.launcherVersionType === "EDGE") {
          const optiFineVersions = await invoke<OptiFineVersion[]>("list_optifine_versions", {
            gameVersion: workingInstance.baseVersion,
            loader: workingInstance.loader,
            loaderVersion: null,
            downloadSource: settings.downloadSource
          });
          const selectedOptiFine = selectDefaultEdgeOptiFineVersion(optiFineVersions);
          const latestOptiFine = selectedOptiFine?.version ?? "";
          let edgeInstanceChanged = false;
          if (workingInstance.loader === "forge") {
            const forgeVersions = await invoke<string[]>("list_forge_versions", {
              gameVersion: workingInstance.baseVersion,
              downloadSource: settings.downloadSource
            });
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
          }
          if (latestOptiFine && (workingInstance.optiFineVersion !== latestOptiFine || edgeInstanceChanged)) {
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
          if (edgeInstanceChanged) {
            setInstances((prev) =>
              prev.map((item) => (item.id === workingInstance.id ? workingInstance : item))
            );
          }
        }
        await ensurePresetModsReady(workingInstance);
        await ensureManagedContentUpToDate(workingInstance);
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
    markLaunchPreparePhase("check-instance", "running", "prepare", t("app.status.missingAutoInstall", {
      versionId: workingInstance.versionId,
      baseVersion: workingInstance.baseVersion,
      loader: loaderDisplayName(workingInstance.loader)
    }));
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
        const optiFineVersions = await invoke<OptiFineVersion[]>("list_optifine_versions", {
          gameVersion: workingInstance.baseVersion,
          loader: workingInstance.loader,
          loaderVersion: null,
          downloadSource: settings.downloadSource
        });
        const selectedOptiFine = selectDefaultEdgeOptiFineVersion(optiFineVersions);
        nextOptiFineVersion = selectedOptiFine?.version ?? "";
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

    if (workingInstance.launcherVersionType === "EDGE" && !nextOptiFineVersion) {
      const optiFineVersions = await invoke<OptiFineVersion[]>("list_optifine_versions", {
        gameVersion: workingInstance.baseVersion,
        loader: workingInstance.loader,
        loaderVersion: workingInstance.loader === "vanilla" ? null : nextLoaderVersion,
        downloadSource: settings.downloadSource
      });
      nextOptiFineVersion =
        optiFineVersions.find((item) => item.compatibility === "compatible")?.version ?? "";
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
    await ensurePresetModsReady(updatedInstance);
    await ensureManagedContentUpToDate(updatedInstance);
    setStatus(t("app.status.autoInstallCompleted", { name: updatedInstance.name }));
    markLaunchPreparePhase("check-instance", "done", "complete", t("app.status.autoInstallCompleted", { name: updatedInstance.name }));
    return updatedInstance;
  }

  async function launchTarget(target: Instance) {
    if (ensureMandatoryLauncherUpdate()) {
      return;
    }
    const presetAccess = resolvePresetAccessState(target, launcherAuth?.user ?? null, launcherVersions);
    if (presetAccess.state === "beta" || presetAccess.state === "pending-release") {
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
      const readyAccount = await ensureMinecraftAccountReadyForLaunch(currentMinecraftAccount, sessionId);
      markLaunchPreparePhase("login", "done", "complete", t("launch.progress.loginCompleted"));
      const launchIdentity = resolveMinecraftLaunchIdentity(readyAccount, settings.playerName);
      markLaunchPreparePhase("check-instance", "running", "prepare", t("launch.progress.checkInstance"));
      setLaunchProgressPercent(Math.round((1 / LAUNCH_PREPARE_STEPS) * 100));
      setLaunchProgressText(t("launch.progress.checkInstance"));
      const prepared = await ensureInstanceReadyForLaunch(target, sessionId);
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
        maxMemoryMb: settings.maxMemoryMb,
        javaPath: jdk.javaPath,
        downloadSource: settings.downloadSource,
        waitForExit: false
      });
      setLaunchProgressPercent(100);
      setLaunchProgressText(t("launch.progress.startingGame"));
      markLaunchPreparePhase("launch", "done", "complete", t("launch.progress.startingGame"));
    } catch (error) {
      const errorText = formatLaunchError(error);
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

    try {
      const monitorWindow = await openMonitor(
        launchResult.pid,
        target.name,
        logCursorRef.current ?? 0,
        settings.language
      );
      setMonitorWindowOpen(true);
      void monitorWindow.once(TauriEvent.WINDOW_DESTROYED, () => {
        setMonitorWindowOpen(false);
      });
      if (settings.hideMainOnLaunch) {
        await getCurrentWindow().hide();
      }
      setActiveGamePid(launchResult.pid);
      setStatus(t("app.status.gameStarted", { pid: launchResult.pid }));
    } catch (error) {
      setStatus(
        t("app.status.gameStartedMonitorFailed", {
          pid: launchResult.pid,
          error: String(error)
        })
      );
    } finally {
      completeLaunchPrepare();
      setBusy(false);
      setLaunchingInstanceId(null);
    }
  }

  async function launch() {
    if (!current) return;
    await launchTarget(current);
  }

  async function refreshCatalog() {
    if (catalogLoading) return;
    setCatalogLoading(true);
    setStatus(t("app.status.loadingVersions"));
    try {
      const [versions, installed] = await Promise.all([
        invoke<string[]>("list_vanilla_versions", { downloadSource: settings.downloadSource }),
        invoke<string[]>("list_installed_versions", { gameDir: settings.gameDir }).catch(() => [])
      ]);
      const groupedVersions = groupByMajor(versions);
      const majorKeys = Object.keys(groupedVersions).sort((a, b) => compareMajor(b, a));
      const nextMajor = majorKeys.includes(major) ? major : majorKeys[0] ?? "";
      const nextVersion = resolveInstallVersion(
        versions,
        groupedVersions,
        nextMajor,
        showSnapshots,
        installVersion
      );

      setCatalog(versions);
      setInstalledVersions(installed);
      setMajor(nextMajor);
      setInstallVersion(nextVersion);
      setStatus(t("app.status.loadedVersions", { count: versions.length }));
    } catch (error) {
      setStatus(t("app.status.failed", { error: String(error) }));
    } finally {
      setCatalogLoading(false);
    }
  }

  async function refreshLoader() {
    if (!installVersion || loader === "vanilla") return;
    const requestId = loaderRequestRef.current + 1;
    loaderRequestRef.current = requestId;
    setLoaderLoading(true);
    try {
      const versions =
        loader === "fabric"
          ? await invoke<string[]>("list_fabric_loaders", {
              gameVersion: installVersion,
              downloadSource: settings.downloadSource
            })
          : await invoke<string[]>("list_forge_versions", {
              gameVersion: installVersion,
              downloadSource: settings.downloadSource
            });

      if (requestId !== loaderRequestRef.current) return;

      const options = versions;
      setLoaderOptions(options);
      setLoaderVersion(options[0] ?? "");
      setStatus(
        options.length > 0
          ? t("app.status.loadedLoaderVersions", {
              count: options.length,
              loader: loaderDisplayName(loader)
            })
          : t("app.status.noLoaderVersions", {
              loader: loaderDisplayName(loader),
              version: installVersion
            })
      );
    } catch (error) {
      if (requestId !== loaderRequestRef.current) return;
      setLoaderOptions([]);
      setLoaderVersion("");
      setStatus(t("app.status.failed", { error: String(error) }));
    } finally {
      if (requestId === loaderRequestRef.current) {
        setLoaderLoading(false);
      }
    }
  }

  async function refreshOptiFine() {
    if (!installVersion || loader === "fabric") return;
    const requestId = optiFineRequestRef.current + 1;
    optiFineRequestRef.current = requestId;
    setOptiFineLoading(true);
    try {
      const versions = await invoke<OptiFineVersion[]>("list_optifine_versions", {
        gameVersion: installVersion,
        loader,
        loaderVersion: loader === "vanilla" ? null : loaderVersion,
        downloadSource: settings.downloadSource
      });

      if (requestId !== optiFineRequestRef.current) return;

      const options = versions.slice(0, 80);
      const firstCompatible = options.find((item) => item.compatibility === "compatible") ?? null;
      setOptiFineOptions(options);
      setOptiFineVersion(firstCompatible?.version ?? "");
      setStatus(
        options.length > 0
          ? t("app.status.loadedLoaderVersions", {
              count: options.length,
              loader: t("loader.optifine")
            })
          : t("app.status.noLoaderVersions", {
              loader: t("loader.optifine"),
              version: installVersion
            })
      );
    } catch (error) {
      if (requestId !== optiFineRequestRef.current) return;
      setOptiFineOptions([]);
      setOptiFineVersion("");
      setStatus(t("app.status.failed", { error: String(error) }));
    } finally {
      if (requestId === optiFineRequestRef.current) {
        setOptiFineLoading(false);
      }
    }
  }

  async function install() {
    if (ensureMandatoryLauncherUpdate()) {
      return;
    }
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
      setInstalledVersions((prev) =>
        prev.includes(duplicatedVersionId) ? prev : [duplicatedVersionId, ...prev]
      );
      setSelected(duplicated.id);
      setStatus(t("app.status.instanceDuplicated", { name: source.name }));
    } catch (error) {
      setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
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
      setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
    }
  }

  async function repairInstance(id: string) {
    if (ensureMandatoryLauncherUpdate()) {
      return;
    }
    const source = instances.find((entry) => entry.id === id);
    if (!source) return;

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
      setInstances((prev) =>
        prev.map((item) => (item.id === repaired.id ? repaired : item))
      );
      setInstalledVersions((prev) =>
        prev.includes(result.versionId) ? prev : [result.versionId, ...prev]
      );
      if (repaired.preset) {
        await ensurePresetModsReady(repaired);
      }
      setStatus(t("app.status.instanceRepaired", { name: source.name }));
    } catch (error) {
      setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
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
      const errorText = String(error);
      setInstallDialog((prev) => (prev ? { ...prev, cancelling: false } : prev));
      setStatus(t("app.status.failed", { error: errorText }));
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
          vanilla: t("launch.prepare.phase.vanilla"),
          fabric: t("launch.prepare.phase.fabric"),
          forge: t("launch.prepare.phase.forge"),
          optifine: t("launch.prepare.phase.optifine"),
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
    if (currentMinecraftAccount?.type === "offline" && next.playerName !== settings.playerName) {
      const normalizedName = next.playerName.trim();
      if (normalizedName) {
        setMinecraftAccounts((prev) =>
          prev.map((account) =>
            account.id === currentMinecraftAccount.id
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

  function addOfflineMinecraftAccount(username: string) {
    const normalizedName = username.trim();
    if (!normalizedName) {
      return;
    }
    setMinecraftAccounts((prev) => {
      const existing = prev.find(
        (account) =>
          account.type === "offline" &&
          account.username.localeCompare(normalizedName, undefined, { sensitivity: "accent" }) === 0
      );
      const nextAccount = existing ?? createOfflineMinecraftAccount(normalizedName);
      setSelectedMinecraftAccountId(nextAccount.id);
      setSettings((currentSettings) => ({ ...currentSettings, playerName: normalizedName }));
      return existing ? prev : [nextAccount, ...prev];
    });
  }

  function saveMinecraftAccount(account: MinecraftAccount) {
    const normalizedAccount = normalizeMinecraftAccount(account) ?? account;
    setMinecraftAccounts((prev) => {
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
          ...normalizedAccount
        };
        return next;
      }
      return [normalizedAccount, ...next];
    });
    setSelectedMinecraftAccountId(normalizedAccount.id);
    setSettings((currentSettings) => ({
      ...currentSettings,
      playerName: normalizedAccount.username
    }));
  }

  function deleteMinecraftAccount(accountId: string) {
    setMinecraftAccounts((prev) => {
      const next = prev.filter((account) => account.id !== accountId);
      if (next.length > 0) {
        if (selectedMinecraftAccountId === accountId) {
          const fallback = next[0];
          setSelectedMinecraftAccountId(fallback.id);
          setSettings((currentSettings) => ({ ...currentSettings, playerName: fallback.username }));
        }
        return next;
      }

      const fallback = createOfflineMinecraftAccount(settings.playerName.trim() || "Player");
      setSelectedMinecraftAccountId(fallback.id);
      setSettings((currentSettings) => ({ ...currentSettings, playerName: fallback.username }));
      return [fallback];
    });
  }

  async function ensureMinecraftAccountReadyForLaunch(
    account: MinecraftAccount | null,
    ipcSession?: string
  ): Promise<MinecraftAccount | null> {
    if (!account || account.type !== "microsoft") {
      markLaunchPreparePhase("login", "done", "complete", t("launch.progress.loginOffline"));
      return account;
    }

    const expiresAt = typeof account.expiresAt === "number" ? account.expiresAt : null;
    const hasAccessToken = account.accessToken.trim().length > 0;
    const shouldRefresh = !hasAccessToken || (expiresAt !== null && expiresAt <= Date.now() + 60_000);

    if (!shouldRefresh) {
      markLaunchPreparePhase("login", "done", "complete", t("launch.progress.loginReady"));
      return account;
    }

    const refreshToken = account.refreshToken?.trim();
    if (!refreshToken) {
      throw new Error(t("minecraftAccount.microsoftRefreshRequired"));
    }

    const refreshedAccount = await refreshMinecraftAccount(refreshToken, ipcSession);
    saveMinecraftAccount(refreshedAccount);
    return refreshedAccount;
  }

  function renderPage() {
    if (page === "home") {
      return (
        <HomePage
          availableInstances={instances}
          launcherNews={launcherNews}
          launcherServers={launcherServers}
          launcherOnlineSummary={launcherOnlineSummary}
          launcherUpdate={launcherAppUpdate}
          launcherUpdateAvailable={launcherAppUpdateAvailable}
          launcherUpdateDownloading={launcherAppUpdateDownloading}
          launcherUpdateDownload={launcherAppUpdateDownload}
          current={current}
          busy={busy}
          launching={launching}
          launchProgressPercent={launchProgressPercent}
          launchProgressText={launchProgressText}
          user={launcherAuth?.user ?? null}
          minecraftAccounts={minecraftAccounts}
          currentMinecraftAccount={currentMinecraftAccount}
          onSelect={setSelected}
          onLaunch={launch}
          onLaunchToServer={launchToServer}
          onOpenSettings={() => navigatePage("settings")}
          onOpenServers={() => navigatePage("servers")}
          onSelectMinecraftAccount={setSelectedMinecraftAccountId}
          onAddOfflineMinecraftAccount={addOfflineMinecraftAccount}
          onSaveMicrosoftMinecraftAccount={saveMinecraftAccount}
          onDeleteMinecraftAccount={deleteMinecraftAccount}
        />
      );
    }

    if (page === "servers") {
      return (
        <ServersPage
          servers={launcherServers}
          currentInstance={current}
          busy={busy}
          launching={launching}
          launchProgressPercent={launchProgressPercent}
          launchProgressText={launchProgressText}
          user={launcherAuth?.user ?? null}
          onLaunch={launchToServer}
          onRefreshServers={() => refreshLauncherServers(false)}
        />
      );
    }

    if (page === "account-center") {
      return <AccountCenterPage launcherDashboard={launcherDashboard} />;
    }

    if (page === "instances") {
      return (
        <InstancesPage
          instances={instances}
          launcherVersions={launcherVersions}
          busy={busy}
          launchingInstanceId={launchingInstanceId}
          launchProgressPercent={launchProgressPercent}
          launchProgressText={launchProgressText}
          user={launcherAuth?.user ?? null}
          presetPackageStatuses={presetPackageStatuses}
          onDelete={removeInstance}
          onGoInstall={() => navigatePage("install")}
          onLaunchInstance={async (id) => {
            const target = instances.find((item) => item.id === id);
            if (!target) return;
            setSelected(id);
            await launchTarget(target);
          }}
          onOpenInstanceSettings={(id) => {
            setSelected(id);
            navigatePage("instance-settings");
          }}
        />
      );
    }

    if (page === "instance-settings") {
      return (
        <InstanceSettingsPage
          instance={current}
          gameDir={settings.gameDir}
          busy={busy}
          onBack={() => navigatePage("instances")}
          onRepair={() => {
            if (current) {
              void repairInstance(current.id);
            }
          }}
          onDelete={() => {
            if (current) {
              void removeInstance(current.id);
            }
          }}
          onDuplicate={() => {
            if (current) {
              void duplicateInstance(current.id);
            }
          }}
          onExport={() => {
            if (current) {
              void exportInstance(current.id);
            }
          }}
        />
      );
    }

    if (page === "install") {
      return (
        <InstallPage
          catalogLoading={catalogLoading}
          catalogCount={catalog.length}
          majors={majors}
          major={major}
          grouped={grouped}
          showSnapshots={showSnapshots}
          snapshots={snapshots}
          majorVersions={majorVersions}
          installVersion={installVersion}
          loader={loader}
          loaderLoading={loaderLoading}
          loaderOptions={loaderOptions}
          loaderVersion={loaderVersion}
          optiFineEnabled={optiFineEnabled}
          optiFineLoading={optiFineLoading}
          optiFineOptions={optiFineOptions}
          optiFineVersion={optiFineVersion}
          optiFineDisabledReason={optiFineDisabledReason}
          installedVersions={installedVersions}
          installDisabled={installDisabled}
          installButtonText={installButtonText}
          onSelectMajor={(nextMajor) => {
            setShowSnapshots(false);
            setMajor(nextMajor);
          }}
          onToggleSnapshots={() => setShowSnapshots((value) => !value)}
          onSelectInstallVersion={setInstallVersion}
          onSelectLoader={setLoader}
          onSelectLoaderVersion={setLoaderVersion}
          onToggleOptiFine={() => {
            if (loader === "fabric") {
              setStatus(t("install.optifineFabricConflict"));
              return;
            }
            setOptiFineEnabled((value) => !value);
          }}
          onSelectOptiFineVersion={setOptiFineVersion}
          onInstall={install}
        />
      );
    }

    if (page === "content") {
      return (
        <ContentPage
          instances={instances}
          current={current}
          gameDir={settings.gameDir}
          curseforgeApiKey={settings.curseforgeApiKey}
          busy={busy}
          onSelectInstance={setSelected}
          onStatusChange={setStatus}
        />
      );
    }

    if (page === "mandatory-update") {
      return (
        <MandatoryUpdatePage
          launcherUpdate={launcherAppUpdate}
          launcherUpdateDownloading={launcherAppUpdateDownloading}
          launcherUpdateDownload={launcherAppUpdateDownload}
          onInstallLauncherUpdate={() => void installLauncherAppUpdate()}
        />
      );
    }

    return (
      <SettingsPage
        settings={settings}
        launcherCurrentVersion={currentLauncherVersion}
        launcherUpdate={launcherAppUpdate}
        launcherUpdateChannels={launcherAppUpdateChannels}
        launcherUpdateAvailable={launcherAppUpdateAvailable}
        launcherUpdateChecking={launcherAppUpdateChecking}
        launcherUpdateDownloading={launcherAppUpdateDownloading}
        launcherUpdateDownload={launcherAppUpdateDownload}
        launcherUser={launcherAuth?.user ?? null}
        onLogoutLauncherAccount={logoutLauncherAccount}
        onRefreshLauncherUpdate={() => void refreshLauncherAppUpdate(false)}
        onInstallLauncherUpdate={() => void installLauncherAppUpdate()}
        onChange={updateSettings}
        onClampMemory={updateMemory}
        onReset={() =>
            setSettings({
              ...DEFAULT_SETTINGS,
              gameDir: defaultGameDir,
              language: settings.language,
              themeMode: settings.themeMode,
              themeAccent: settings.themeAccent,
              customAccentHex: settings.customAccentHex
            })
        }
      />
    );
}

function isLauncherAppUpdateMissing(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("launcher app update config not found") ||
    normalized.includes("http 404") ||
    normalized.includes("not configured")
  );
}

function nextRecurringDelay(baseMs: number, jitterMs: number): number {
  if (jitterMs <= 0) {
    return baseMs;
  }
  const offset = Math.round((Math.random() * 2 - 1) * jitterMs);
  return Math.max(30_000, baseMs + offset);
}

async function withTitlebarGuard(action: () => Promise<void>) {
    if (titlebarBusy) return;
    setTitlebarBusy(true);
    try {
      await action();
    } catch (error) {
      console.error("Window action failed", error);
    } finally {
      setTitlebarBusy(false);
    }
  }

  async function closeLauncherWindow() {
    if (settings.minimizeToTray) {
      await invoke("hide_main_window");
      return;
    }
    await getCurrentWindow().close();
  }

  return (
    <I18nProvider
      locale={settings.language}
      onLocaleChange={(locale) => {
        setSettings((prev) => ({ ...prev, language: locale }));
        setStatus(createTranslator(locale)("app.status.ready"));
      }}
    >
      <div className="launcher-shell relative flex h-screen w-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)] select-none pixel-pattern">
        {activeBackgroundUrl && (
          <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
            <div
              className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-[var(--duration-normal)]"
              style={{
                backgroundImage: `url("${activeBackgroundUrl}")`,
                opacity: settings.backgroundOpacity / 100,
                filter: `blur(${settings.backgroundBlur}px)`,
                transform: settings.backgroundBlur > 0 ? "scale(1.04)" : "scale(1)"
              }}
            />
            <div className="absolute inset-0 bg-[var(--bg-primary)]/16" />
          </div>
        )}
        <div
          className="fixed left-0 right-0 top-0 z-50 flex h-10 items-center justify-between border-b border-white/5 bg-[var(--bg-secondary)]/92 px-3"
          data-tauri-drag-region
        >
          <div
            className={`flex min-w-0 flex-1 items-center ${authenticated ? "gap-2" : "gap-3"}`}
            data-tauri-drag-region
          >
            {!authenticated && <AppLogo size={24} className="rounded-md" />}
            <span className="truncate text-sm font-semibold tracking-wide text-[var(--text-secondary)]">
              {t("app.name")}
            </span>
          </div>
          <div className="flex h-full items-center gap-0.5 window-no-drag" data-no-drag="true">
            <button
              type="button"
              className="h-full px-4 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-soft)] hover:shadow-[inset_0_0_0_1px_var(--border-medium),0_0_16px_rgba(var(--accent-rgb),0.16)] transition-all duration-150 window-no-drag"
              data-no-drag="true"
              onClick={() => withTitlebarGuard(() => getCurrentWindow().minimize())}
            >
              <Minus size={13} />
            </button>
            <button
              type="button"
              className="h-full px-4 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-soft)] hover:shadow-[inset_0_0_0_1px_var(--border-medium),0_0_16px_rgba(var(--accent-rgb),0.16)] transition-all duration-150 window-no-drag"
              data-no-drag="true"
              onClick={() => withTitlebarGuard(() => getCurrentWindow().toggleMaximize())}
            >
              <Square size={11} />
            </button>
            <button
              type="button"
              className="h-full px-4 text-[var(--text-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 hover:shadow-[inset_0_0_0_1px_var(--accent-danger)] transition-all duration-150 window-no-drag"
              data-no-drag="true"
              onClick={() => withTitlebarGuard(closeLauncherWindow)}
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {authenticated ? (
          <div className="relative z-10 flex h-full w-full flex-1 pt-10">
            <Sidebar
              currentPage={page}
              collapsed={effectiveSidebarCollapsed}
              canToggleCollapse={!compactLayout}
              user={launcherAuth?.user ?? null}
              onToggleCollapse={() => setSidebarCollapsed((value) => !value)}
              setPage={navigatePage}
            />

            <main className="relative flex-1 overflow-hidden border-l border-white/5 bg-[var(--bg-secondary)]/34">
              <div className="pointer-events-none absolute -right-32 -top-24 h-[420px] w-[420px] rounded-full bg-[var(--mc-grass)]/8 blur-[42px] opacity-38" />
              <div className="pointer-events-none absolute -bottom-32 -left-24 h-[360px] w-[360px] rounded-full bg-[var(--mc-grass)]/6 blur-[38px] opacity-30" />

              <div key={page} className="relative z-10 h-full page-transition">
                {renderPage()}
              </div>
            </main>
          </div>
        ) : (
          <main className="relative z-10 flex h-full w-full flex-1 items-center justify-center px-4 pb-4 pt-10">
            <div className="w-full max-w-[520px]">
              <LoginPage
                loading={launcherAuthLoading}
                initialPrefs={launcherLoginPrefs}
                statusText={authNotice}
                onSubmit={loginLauncherAccount}
              />
            </div>
          </main>
        )}

        {authenticated && installDialog && installDialog.open && (
          <InstallDialog dialog={installDialog} onClose={closeInstallDialog} onCancel={cancelInstallDialog} />
        )}

        {authenticated && launchPrepareDialog && launchPrepareDialog.open && (
          <LaunchPrepareDialog dialog={launchPrepareDialog} onClose={closeLaunchPrepareDialog} />
        )}

        {authenticated && launchError && (
          <div className="fixed inset-0 z-[95] flex items-center justify-center bg-[var(--bg-primary)]/82 p-6">
            <Card variant="frost" className="w-full max-w-lg rounded-2xl p-6" interactive={false}>
              <h3 className="text-xl font-semibold text-[var(--accent-danger)]">
                {t("launch.error.title")}
              </h3>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{t("launch.error.subtitle")}</p>
              <div className="mt-4 rounded-xl border border-[#ff6b8f]/25 bg-[#ff6b8f]/10 px-4 py-3">
                <p className="text-sm leading-6 text-[var(--text-primary)] break-all">{launchError}</p>
              </div>
              <div className="mt-6 flex justify-end">
                <Button size="sm" variant="primary" onClick={() => setLaunchError(null)}>
                  {t("launch.error.confirm")}
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>
    </I18nProvider>
  );
}

function isLauncherVersionCompatible(
  currentLauncherVersion: string,
  minLauncherVersion?: null | string,
): boolean {
  const required = (minLauncherVersion ?? "").trim();
  if (!required) {
    return true;
  }
    return compareSemanticVersion(currentLauncherVersion, required) >= 0;
}

function compareSemanticVersion(current: string, required: string): number {
  const currentParts = normalizeSemanticVersion(current);
  const requiredParts = normalizeSemanticVersion(required);
  const maxLength = Math.max(currentParts.length, requiredParts.length, 3);
  for (let index = 0; index < maxLength; index += 1) {
    const left = currentParts[index] ?? 0;
    const right = requiredParts[index] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function normalizeSemanticVersion(input: string): number[] {
  return input
    .trim()
    .split(".")
    .map((part) => {
      const match = part.match(/\d+/);
      return match ? Number.parseInt(match[0], 10) : 0;
    });
}

function createPresetPackageStatus(
  state: PresetPackageStatus["state"],
  overrides: Partial<Omit<PresetPackageStatus, "state">> = {}
): PresetPackageStatus {
  return {
    state,
    versionTag: null,
    installedVersionTag: null,
    targetVersionTag: null,
    changelog: null,
    lastError: null,
    ...overrides
  };
}

function resolvePresetAccessState(
  instance: Instance,
  user: LauncherUser | null,
  versionMap: LauncherVersionMap
): { state: "ok" | "beta" | "pending-release"; versionTag?: string | null; changelog?: string | null; lastError?: string | null } {
  if (!instance.preset || !instance.launcherVersionType) {
    return { state: "ok" };
  }
  if (instance.launcherVersionType === "EDGE") {
    return { state: "ok" };
  }
  const eligible = Boolean(user?.novaBetaEligible);
  const version = versionMap.NOVA;
  if (!eligible) {
    return {
      state: "beta",
      lastError: "Nova is still in beta for this account."
    };
  }
  if (!version) {
    return {
      state: "pending-release",
      lastError: "Nova is approved for this account but not released yet."
    };
  }
  return {
    state: "ok",
    versionTag: version.versionName,
    changelog: version.changelog ?? null
  };
}

function formatLaunchError(error: unknown): string {
  const raw = String(error ?? "");
  if (raw === "") return "Unknown launch error";
  if (raw.startsWith("Error: ")) {
    return raw.slice("Error: ".length).trim();
  }
  return raw.trim();
}

function normalizeLoginError(
  error: unknown,
  t: ReturnType<typeof createTranslator>
): string {
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

function tryExtractMessageFromJson(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return findMessageInUnknown(value);
  } catch {
    return null;
  }
}

function findMessageInUnknown(value: unknown): string | null {
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

function parseLaunchProgressLog(message: string): { percent?: number; text: string } | null {
  const text = message.trim();
  if (!text) return null;

  const match = text.match(/JDK download progress:\s*(\d+)%/);
  if (match) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed)) {
      return { percent: Math.min(100, Math.max(0, parsed)), text };
    }
  }

  if (text.startsWith("JDK download succeeded") || text.startsWith("JDK ready") || text.startsWith("JDK already exists")) {
    return { percent: 100, text };
  }

  if (text.startsWith("Downloading JDK ")) {
    return { percent: 30, text };
  }

  if (text.startsWith("Extracting JDK archive")) {
    return { percent: 60, text };
  }

  if (text.startsWith("launch game:")) {
    return { percent: 90, text: text.replace(/^launch game:\s*/i, "Starting game process") };
  }

  if (text.startsWith("[process] started pid=")) {
    return { percent: 100, text: "Game process started" };
  }
  return null;
}

function parseLaunchPrepareJdkLog(message: string): {
  message: string;
  stage?: string;
  phaseStatus?: LaunchPreparePhaseState["status"];
  current?: number;
  total?: number;
  downloaded?: number;
  cached?: number;
  item: LaunchPrepareItem;
} | null {
  const text = message.trim();
  if (!text) {
    return null;
  }

  const progressMatch = text.match(/^JDK download progress:\s*(\d+)%\s*\((\d+)\/(\d+)\s+bytes\)$/i);
  if (progressMatch) {
    const percent = Number.parseInt(progressMatch[1], 10);
    const currentBytes = Number.parseInt(progressMatch[2], 10);
    const totalBytes = Number.parseInt(progressMatch[3], 10);
    return {
      message: text,
      stage: "download",
      phaseStatus: "running",
      current: Number.isFinite(percent) ? percent : 0,
      total: 100,
      item: {
        id: "jdk-download",
        name: "JDK Runtime",
        kind: "jdk",
        status: percent >= 100 ? "done" : "running",
        currentBytes,
        totalBytes,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  const bytesOnlyMatch = text.match(/^JDK download progress:\s*(\d+)\s+bytes$/i);
  if (bytesOnlyMatch) {
    const currentBytes = Number.parseInt(bytesOnlyMatch[1], 10);
    return {
      message: text,
      stage: "download",
      phaseStatus: "running",
      item: {
        id: "jdk-download",
        name: "JDK Runtime",
        kind: "jdk",
        status: "running",
        currentBytes,
        totalBytes: null,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  if (text.startsWith("Managed JDK already exists")) {
    return {
      message: text,
      stage: "complete",
      phaseStatus: "done",
      current: 100,
      total: 100,
      downloaded: 0,
      cached: 1,
      item: {
        id: "jdk-download",
        name: "JDK Runtime",
        kind: "jdk",
        status: "cached",
        currentBytes: 0,
        totalBytes: null,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  if (text.startsWith("Resolving Mojang runtime") || text.startsWith("Installing Mojang runtime")) {
    return {
      message: text,
      stage: "prepare",
      phaseStatus: "running",
      item: {
        id: "jdk-download",
        name: "JDK Runtime",
        kind: "jdk",
        status: "running",
        currentBytes: 0,
        totalBytes: null,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  if (text.startsWith("Fetching Mojang Java all.json") || text.startsWith("Fetching Mojang Java manifest")) {
    return {
      message: text,
      stage: "prepare",
      phaseStatus: "running",
      item: {
        id: "jdk-manifest",
        name: text.includes("all.json") ? "Runtime Index" : "Runtime Manifest",
        kind: "jdk-meta",
        status: "running",
        currentBytes: 0,
        totalBytes: null,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  const runtimeMatch = text.match(/^Mojang runtime progress:\s*(\d+)\/(\d+)\s+downloaded=(\d+)\s+cached=(\d+)$/i);
  if (runtimeMatch) {
    const current = Number.parseInt(runtimeMatch[1], 10);
    const total = Number.parseInt(runtimeMatch[2], 10);
    const downloaded = Number.parseInt(runtimeMatch[3], 10);
    const cached = Number.parseInt(runtimeMatch[4], 10);
    return {
      message: text,
      stage: current >= total ? "complete" : "download",
      phaseStatus: current >= total ? "done" : "running",
      current,
      total,
      downloaded,
      cached,
      item: {
        id: "jdk-runtime-files",
        name: "Runtime Files",
        kind: "jdk",
        status: current >= total ? "done" : "running",
        currentBytes: current,
        totalBytes: total,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  if (text.startsWith("JDK ready ") || text.startsWith("JDK download succeeded")) {
    return {
      message: text,
      stage: "complete",
      phaseStatus: "done",
      current: 100,
      total: 100,
      item: {
        id: "jdk-download",
        name: "JDK Runtime",
        kind: "jdk",
        status: "done",
        currentBytes: 100,
        totalBytes: 100,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  return null;
}

function mapLaunchPreparePhaseKey(phase?: string): LaunchPreparePhaseKey | null {
  if (phase === "login") return "login";
  if (phase === "vanilla") return "vanilla";
  if (phase === "fabric") return "fabric";
  if (phase === "forge") return "forge";
  if (phase === "runtime") return "runtime";
  return null;
}

function selectDefaultEdgeOptiFineVersion(versions: OptiFineVersion[]): OptiFineVersion | undefined {
  return versions.find((item) => item.compatibility !== "incompatible");
}

function translateLaunchPrepareMessage(
  ipc: InstallIpcEvent,
  t: ReturnType<typeof useI18n>["t"]
): string | null {
  if (ipc.phase !== "login") {
    return ipc.message ?? null;
  }
  if (ipc.stage === "microsoft") return t("launch.progress.loginMicrosoft");
  if (ipc.stage === "xbox") return t("launch.progress.loginXbox");
  if (ipc.stage === "xsts") return t("launch.progress.loginXsts");
  if (ipc.stage === "minecraft") return t("launch.progress.loginMinecraft");
  if (ipc.stage === "profile") return t("launch.progress.loginProfile");
  return ipc.message ?? null;
}

function reduceLaunchPrepareItems(items: LaunchPrepareItem[], ipc: InstallIpcEvent): LaunchPrepareItem[] {
  if (!ipc.event.startsWith("item-")) {
    return items;
  }
  const itemId = ipc.itemId?.trim();
  if (!itemId) {
    return items;
  }

  const existingIndex = items.findIndex((item) => item.id === itemId);
  const existing = existingIndex >= 0 ? items[existingIndex] : null;
  const nextStatus = resolveLaunchPrepareItemStatus(ipc, existing?.status);
  const nextItem: LaunchPrepareItem = {
    id: itemId,
    name: ipc.itemName?.trim() || existing?.name || itemId,
    kind: ipc.itemKind?.trim() || existing?.kind || "file",
    status: nextStatus,
    currentBytes: typeof ipc.itemCurrentBytes === "number" ? ipc.itemCurrentBytes : existing?.currentBytes ?? 0,
    totalBytes:
      typeof ipc.itemTotalBytes === "number"
        ? ipc.itemTotalBytes
        : existing?.totalBytes ?? null,
    message: ipc.message?.trim() || existing?.message || "",
    updatedAt: Date.now()
  };

  const next = existingIndex >= 0 ? [...items] : [nextItem, ...items];
  if (existingIndex >= 0) {
    next[existingIndex] = nextItem;
  }

  next.sort((left, right) => {
    const leftRank = launchPrepareItemRank(left.status);
    const rightRank = launchPrepareItemRank(right.status);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return right.updatedAt - left.updatedAt;
  });

  return next;
}

function resolveLaunchPrepareItemStatus(
  ipc: InstallIpcEvent,
  previous?: LaunchPrepareItemStatus
): LaunchPrepareItemStatus {
  if (ipc.event === "item-error") return "error";
  if (ipc.event === "item-complete") {
    return ipc.itemCached ? "cached" : "done";
  }
  if (ipc.event === "item-progress" || ipc.event === "item-start") {
    if ((ipc.message ?? "").trim().toLowerCase() === "queued") {
      return "pending";
    }
    return "running";
  }
  return previous ?? "pending";
}

function launchPrepareItemRank(status: LaunchPrepareItemStatus): number {
  if (status === "running") return 0;
  if (status === "pending") return 1;
  if (status === "error") return 2;
  if (status === "done") return 3;
  return 4;
}

function upsertLaunchPrepareLogItem(items: LaunchPrepareItem[], item: LaunchPrepareItem): LaunchPrepareItem[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  const next = index >= 0 ? [...items] : [item, ...items];
  if (index >= 0) {
    next[index] = item;
  }
  next.sort((left, right) => {
    const leftRank = launchPrepareItemRank(left.status);
    const rightRank = launchPrepareItemRank(right.status);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return right.updatedAt - left.updatedAt;
  });
  return next.slice(0, 4);
}

async function ensureJdk(gameDir: string, versionId: string, downloadThreads: number): Promise<JdkEnsureResult> {
  return invoke<JdkEnsureResult>("ensure_jdk", { gameDir, versionId, downloadThreads });
}

async function refreshMinecraftAccount(refreshToken: string, ipcSession?: string): Promise<MinecraftAccount> {
  return invoke<MinecraftAccount>("refresh_minecraft_account", { refreshToken, ipcSession });
}

async function syncAutostart(enabled: boolean): Promise<void> {
  try {
    await invoke("set_launch_on_startup", { enabled });
  } catch {
  }
}

async function syncTrayBehavior(minimizeToTray: boolean): Promise<void> {
  try {
    await invoke("configure_tray_behavior", { minimizeToTray });
  } catch {
  }
}

async function openMonitor(pid: number, instanceName: string, cursor: number, locale: Locale) {
  const params = new URLSearchParams({
    view: "monitor",
    pid: String(pid),
    version: instanceName,
    startedAt: String(Date.now()),
    cursor: String(cursor),
    lang: locale
  });

  const monitorLabel = `runtime-monitor-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const win = new WebviewWindow(monitorLabel, {
    title: `Runtime - ${instanceName}`,
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    decorations: false,
    url: `/?${params.toString()}`
  });

  await new Promise<void>((resolve, reject) => {
    void win.once("tauri://created", () => resolve());
    void win.once("tauri://error", (event) => {
      reject(new Error(String((event as { payload?: unknown }).payload ?? "create monitor failed")));
    });
  });

  return win;
}

function parseLauncherAuthState(raw: string): LauncherAuthState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LauncherAuthState>;
    const token = normalizeStoredToken(parsed?.token);
    if (!parsed || !token) {
      return null;
    }
    return {
      token,
      user: (parsed.user as LauncherUser | undefined) ?? {}
    };
  } catch {
    return null;
  }
}

function parseLauncherLoginPrefs(raw: string): LauncherLoginPrefs {
  try {
    const parsed = JSON.parse(raw) as Partial<LauncherLoginPrefs>;
    const rememberPassword = Boolean(parsed?.rememberPassword);
    return {
      usernameOrEmail: typeof parsed?.usernameOrEmail === "string" ? parsed.usernameOrEmail : "",
      password: rememberPassword && typeof parsed?.password === "string" ? parsed.password : "",
      rememberPassword,
      autoLogin: rememberPassword && Boolean(parsed?.autoLogin)
    };
  } catch {
    return DEFAULT_LOGIN_PREFS;
  }
}

function parseMinecraftAccounts(raw: string): MinecraftAccount[] {
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

function loadSelectedMinecraftAccountId(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.selectedMinecraftAccount)?.trim();
    return raw || null;
  } catch {
    return null;
  }
}

function normalizeMinecraftAccount(raw: unknown): MinecraftAccount | null {
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

function createOfflineMinecraftAccount(username: string): MinecraftAccount {
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

function createMicrosoftAccountId(uuid: string): string {
  return `microsoft-${uuid.trim().toLowerCase()}`;
}

function resolveMinecraftLaunchIdentity(
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

function isAuthExpiredError(error: unknown): boolean {
  const normalized = formatLaunchError(error).trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "token is required" || normalized === "authentication required") {
    return true;
  }
  // Match "HTTP 401" or "HTTP 401 - message"
  if (/\bhttp\s*401\b/i.test(normalized)) {
    return true;
  }
  // Match "HTTP 403" for auth-related forbidden
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
  // Common auth error messages from APIs
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
  return authErrorPatterns.some(pattern => normalized.includes(pattern));
}

function loadOrCreateLauncherSessionId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEYS.launcherSessionId)?.trim();
    if (existing) {
      return existing;
    }
    const created = createSessionId();
    localStorage.setItem(STORAGE_KEYS.launcherSessionId, created);
    return created;
  } catch {
    return createSessionId();
  }
}

function normalizeStoredToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let token = raw.trim().replace(/^"+|"+$/g, "").trim();
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  return token || null;
}

function readStoredLocale(): Locale | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (parsed.language === "en-US" || parsed.language === "zh-CN") {
      return parsed.language;
    }
  } catch {
  }
  return null;
}

function loaderLabelKey(loader: Loader) {
  if (loader === "forge") return "loader.forge" as const;
  if (loader === "fabric") return "loader.fabric" as const;
  return "loader.vanilla" as const;
}

function createDuplicatedInstanceName(sourceName: string, instances: Instance[]): string {
  const existingNames = new Set(instances.map((item) => item.name.trim().toLowerCase()));
  const baseName = `${sourceName} Copy`;
  if (!existingNames.has(baseName.trim().toLowerCase())) {
    return baseName;
  }

  let index = 2;
  while (index < 1000) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.has(candidate.trim().toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${baseName} ${Date.now()}`;
}

function createDuplicatedVersionId(sourceVersionId: string, instances: Instance[]): string {
  const existingIds = new Set(instances.map((item) => item.versionId.trim().toLowerCase()));
  const slugBase = slugifyInstanceKey(sourceVersionId);
  let index = 1;
  while (index < 1000) {
    const candidate = `${slugBase}-copy-${index}`;
    if (!existingIds.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${slugBase}-copy-${Date.now()}`;
}

function slugifyInstanceKey(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "instance";
}

function isLegacyDefaultGameDir(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/").toLowerCase();
  return normalized === "" || normalized === "./.minecraft" || normalized === ".minecraft";
}
