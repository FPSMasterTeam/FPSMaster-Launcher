import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import AppLogo from "./components/AppLogo";
import Button from "./components/Button";
import Card from "./components/Card";
import InstallDialog from "./components/InstallDialog";
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
import ContentPage from "./pages/Content";
import SettingsPage from "./pages/Settings";
import type {
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
  Locale,
  LaunchExecutionResult,
  Loader,
  Page,
  PresetPackageStatus,
  Settings,
  TelemetryOnlineSummary,
  UiLogPollResult
} from "./types";
import {
  clamp,
  compareMajor,
  createPhaseState,
  createSessionId,
  groupByMajor,
  isSnapshot,
  applyTheme,
  loadInstances,
  loadSettings,
  parseInstallIpc,
  resolveInstallVersion
} from "./utils/launcher";

type LauncherAuthState = {
  token: string;
  user: LauncherUser;
};

type LauncherVersionMap = Record<LauncherVersionType, LauncherVersion | null>;

const CURRENT_LAUNCHER_VERSION = "0.2.0";
const LAUNCHER_HEARTBEAT_INTERVAL_MS = 90_000;
const LAUNCHER_BACKGROUND_HEARTBEAT_INTERVAL_MS = 120_000;
const LAUNCHER_ONLINE_REFRESH_INTERVAL_MS = 90_000;
const LAUNCHER_HEARTBEAT_JITTER_MS = 12_000;
const LAUNCHER_ONLINE_REFRESH_JITTER_MS = 8_000;

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
  const [launcherAuth, setLauncherAuth] = useState<LauncherAuthState | null>(loadLauncherAuthState);
  const [launcherVersions, setLauncherVersions] = useState<LauncherVersionMap>(EMPTY_LAUNCHER_VERSIONS);
  const [launcherNews, setLauncherNews] = useState<NewsItem[]>(() => [...NEWS_ITEMS]);
  const [launcherDashboard, setLauncherDashboard] = useState<LauncherDashboard | null>(null);
  const [launcherOnlineSummary, setLauncherOnlineSummary] = useState<TelemetryOnlineSummary | null>(null);
  const [launcherAppUpdate, setLauncherAppUpdate] = useState<LauncherAppUpdateInfo | null>(null);
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

  const [catalog, setCatalog] = useState<string[]>([]);
  const [major, setMajor] = useState("");
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [installVersion, setInstallVersion] = useState("");
  const [loader, setLoader] = useState<Loader>("vanilla");
  const [loaderOptions, setLoaderOptions] = useState<string[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [installedVersions, setInstalledVersions] = useState<string[]>([]);
  const [activeGamePid, setActiveGamePid] = useState<number | null>(null);
  const [launchingInstanceId, setLaunchingInstanceId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchProgressPercent, setLaunchProgressPercent] = useState<number | null>(null);
  const [launchProgressText, setLaunchProgressText] = useState("");

  const [installDialog, setInstallDialog] = useState<InstallDialogState | null>(null);
  const [titlebarBusy, setTitlebarBusy] = useState(false);
  const [windowVisible, setWindowVisible] = useState(false);
  const launcherSessionIdRef = useRef(loadOrCreateLauncherSessionId());
  const launcherAuthTokenRef = useRef<string | null>(launcherAuth?.token?.trim() ?? null);

  const logCursorRef = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const loaderRequestRef = useRef(0);
  const lastInstallPageRef = useRef(false);
  const launchingInstanceRef = useRef<string | null>(null);

  const t = useMemo(() => createTranslator(settings.language), [settings.language]);
  const launcherAppUpdateAvailable = useMemo(
    () =>
      launcherAppUpdate !== null &&
      compareMajor(launcherAppUpdate.version, CURRENT_LAUNCHER_VERSION) > 0,
    [launcherAppUpdate]
  );

  const current = useMemo(
    () => instances.find((item) => item.id === selected) ?? instances[0] ?? null,
    [instances, selected]
  );
  const grouped = useMemo(() => groupByMajor(catalog), [catalog]);
  const majors = useMemo(() => Object.keys(grouped).sort((a, b) => compareMajor(b, a)), [grouped]);
  const majorVersions = major ? grouped[major] ?? [] : [];
  const effectiveSidebarCollapsed = compactLayout ? true : sidebarCollapsed;
  const backgroundMode = settings.minimizeToTray && !windowVisible;
  const activeBackgroundUrl =
    settings.backgroundSource === "web-random" ? settings.backgroundWebUrl : settings.backgroundImage;
  const snapshots = useMemo(() => catalog.filter(isSnapshot), [catalog]);
  const authenticated = Boolean(launcherAuth?.token?.trim());
  const launching = busy && launchingInstanceId !== null;
  const installDisabled =
    busy ||
    catalogLoading ||
    !installVersion ||
    (loader !== "vanilla" && (loaderLoading || !loaderVersion));
  const loaderDisplayName = (value: Loader) => t(loaderLabelKey(value));
  const installButtonText = busy
    ? t("install.button.installing")
    : catalogLoading
      ? t("install.button.syncing")
      : loader !== "vanilla" && loaderLoading
        ? t("install.button.loadingLoader", { loader: loaderDisplayName(loader) })
        : t("install.button.installSelected");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.instances, JSON.stringify(instances));
  }, [instances]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (launcherAuth) {
      localStorage.setItem(STORAGE_KEYS.launcherAuth, JSON.stringify(launcherAuth));
      return;
    }
    localStorage.removeItem(STORAGE_KEYS.launcherAuth);
  }, [launcherAuth]);

  useEffect(() => {
    if (!launcherAuth?.token) {
      setLauncherVersions(EMPTY_LAUNCHER_VERSIONS);
      setLauncherDashboard(null);
      setLauncherOnlineSummary(null);
      setPresetPackageStatuses({});
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
    const runHeartbeat = async () => {
      try {
        await cacheLauncherTelemetrySession();
        await postLauncherHeartbeat(token);
      } catch {
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
      } catch {
        if (active) {
          setLauncherOnlineSummary(null);
        }
      }
    };

    let heartbeatTimer: number | null = null;
    let onlineTimer: number | null = null;
    const scheduleHeartbeat = () => {
      heartbeatTimer = window.setTimeout(async () => {
        await runHeartbeat();
        if (active) {
          scheduleHeartbeat();
        }
      }, nextRecurringDelay(backgroundMode ? LAUNCHER_BACKGROUND_HEARTBEAT_INTERVAL_MS : LAUNCHER_HEARTBEAT_INTERVAL_MS, LAUNCHER_HEARTBEAT_JITTER_MS));
    };
    const scheduleOnlineRefresh = () => {
      onlineTimer = window.setTimeout(async () => {
        await loadOnline();
        if (active && !backgroundMode) {
          scheduleOnlineRefresh();
        }
      }, nextRecurringDelay(LAUNCHER_ONLINE_REFRESH_INTERVAL_MS, LAUNCHER_ONLINE_REFRESH_JITTER_MS));
    };

    void runHeartbeat();
    scheduleHeartbeat();
    if (!backgroundMode) {
      void loadOnline();
      scheduleOnlineRefresh();
    }
    return () => {
      active = false;
      if (heartbeatTimer !== null) {
        window.clearTimeout(heartbeatTimer);
      }
      if (onlineTimer !== null) {
        window.clearTimeout(onlineTimer);
      }
    };
  }, [launcherAuth?.token, launcherAuth?.user?.username, backgroundMode]);

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
    void refreshLauncherAppUpdate(true);
  }, []);

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
    if (!windowVisible) {
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
          }
          const ipc = parseInstallIpc(entry.message);
          if (ipc) {
            applyInstallIpc(ipc);
          }
        }
      } catch {
      } finally {
        pollingRef.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 250);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [windowVisible]);

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
    const timer = window.setInterval(() => void probe(), 2000);
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
        const hasStoredSettings = Boolean(localStorage.getItem(STORAGE_KEYS.settings));
        if (!hasStoredSettings) {
          setSettings((prev) =>
            isLegacyDefaultGameDir(prev.gameDir) ? { ...prev, gameDir: resolved } : prev
          );
        }
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
              : ipc.event === "phase-start" || ipc.event === "progress"
                ? "running"
                : currentPhase.status,
        stage: ipc.stage ?? currentPhase.stage,
        message: ipc.message ?? currentPhase.message,
        current: typeof ipc.current === "number" ? ipc.current : currentPhase.current,
        total: typeof ipc.total === "number" ? ipc.total : currentPhase.total,
        downloaded: typeof ipc.downloaded === "number" ? ipc.downloaded : currentPhase.downloaded,
        cached: typeof ipc.cached === "number" ? ipc.cached : currentPhase.cached
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

  function pickLatestLauncherVersions(entries: LauncherVersion[]): LauncherVersionMap {
    const out: LauncherVersionMap = { EDGE: null, NOVA: null };
    const scoreOf = (item: LauncherVersion): number => {
      const raw = item.createdAt ?? "";
      const parsed = Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    };

    for (const item of entries) {
      if (item.versionType !== "EDGE" && item.versionType !== "NOVA") continue;
      if (!isLauncherVersionCompatible(item.minLauncherVersion)) continue;
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
      if (payload.news.length > 0) {
        setLauncherNews(payload.news);
      } else {
        setLauncherNews([...NEWS_ITEMS]);
      }
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
      if (!token) {
        setLauncherNews([...NEWS_ITEMS]);
        setLauncherOnlineSummary(null);
      }
      if (!silent) {
        setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
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
        setLauncherNews([...NEWS_ITEMS]);
      }
    } catch (error) {
      setLauncherNews([...NEWS_ITEMS]);
      if (!silent) {
        setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
      }
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
      setLauncherDashboard(null);
      if (!silent) {
        setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
      }
    }
  }

  async function refreshLauncherAppUpdate(silent = false): Promise<void> {
    setLauncherAppUpdateChecking(true);
    try {
      const info = await invoke<LauncherAppUpdateInfo>("launcher_get_app_update", {
        baseUrl: LAUNCHER_API_BASE_URL
      });
      setLauncherAppUpdate(info);
      setLauncherAppUpdateDownload((prev) =>
        prev?.version === info.version ? prev : null
      );
      if (!silent) {
        setStatus(
          compareMajor(info.version, CURRENT_LAUNCHER_VERSION) > 0
            ? t("settings.launcherUpdateAvailable", { version: info.version })
            : t("settings.launcherUpToDate")
        );
      }
    } catch (error) {
      const errorText = formatLaunchError(error);
      if (isLauncherAppUpdateMissing(errorText)) {
        setLauncherAppUpdate(null);
        setLauncherAppUpdateDownload(null);
        if (!silent) {
          setStatus(t("settings.launcherUpdateNotConfigured"));
        }
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

  async function postLauncherHeartbeat(token: string): Promise<void> {
    const response = await fetch(`${LAUNCHER_API_BASE_URL}/api/v1/telemetry/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        clientName: "fpsmaster-launcher",
        clientKind: "LAUNCHER",
        sessionId: launcherSessionIdRef.current,
        username: launcherAuth?.user?.username ?? settings.playerName,
        playerUuid: launcherAuth?.user?.id ?? null
      })
    });

    if (!response.ok) {
      throw new Error(`heartbeat failed with HTTP ${response.status}`);
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

  async function loginLauncherAccount(
    usernameOrEmail: string,
    password: string
  ): Promise<string | null> {
    const identity = usernameOrEmail.trim();
    if (!identity || !password) {
      return t("login.required");
    }

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
      void cacheLauncherTelemetrySession({
        username: result.user?.username,
        id: result.user?.id ?? null
      });
      void refreshLauncherHome(true, normalizedToken);
      const refresh = await refreshLauncherVersions(false, normalizedToken);
      if (!refresh.error && refresh.map) {
        void syncPresetLauncherPackages(refresh.map);
      }
      return refresh.error;
    } catch (error) {
      const errorText = normalizeLoginError(error, t);
      setStatus(t("app.status.failed", { error: errorText }));
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
    setStatus(t("login.tip.signInToContinue"));
  }

  async function ensurePresetModsReady(
    instance: Instance,
    versionMapOverride?: LauncherVersionMap | null
  ) {
    if (!instance.preset || !instance.launcherVersionType) return;

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

    if (!isLauncherVersionCompatible(targetVersion.minLauncherVersion)) {
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
        cleanExisting: true
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

  async function ensureInstanceReadyForLaunch(instance: Instance): Promise<Instance> {
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
    const sessionId = createSessionId();
    const vanilla = await invoke<InstallResult>("install_vanilla", {
      gameDir: settings.gameDir,
      versionId: workingInstance.baseVersion,
      ipcSession: sessionId
    });

    let nextVersionId = vanilla.versionId;
    let nextLoaderVersion = workingInstance.loaderVersion;

    if (workingInstance.loader === "fabric") {
      if (!nextLoaderVersion) {
        const loaderVersions = await invoke<string[]>("list_fabric_loaders", {
          gameVersion: workingInstance.baseVersion
        });
        nextLoaderVersion = loaderVersions[0] ?? "";
      }
      if (!nextLoaderVersion) {
        throw new Error(`No fabric loader version available for ${workingInstance.baseVersion}`);
      }
      const fabric = await invoke<FabricInstallResult>("install_fabric", {
        gameDir: settings.gameDir,
        gameVersion: workingInstance.baseVersion,
        loaderVersion: nextLoaderVersion,
        ipcSession: sessionId
      });
      nextVersionId = fabric.profileId;
    } else if (workingInstance.loader === "forge") {
      if (!nextLoaderVersion) {
        const forgeVersions = await invoke<string[]>("list_forge_versions", {
          gameVersion: workingInstance.baseVersion
        });
        nextLoaderVersion = forgeVersions[0] ?? "";
      }
      if (!nextLoaderVersion) {
        throw new Error(`No forge version available for ${workingInstance.baseVersion}`);
      }
      const jdk = await ensureJdk(settings.gameDir, workingInstance.baseVersion);
      const forge = await invoke<ForgeInstallResult>("install_forge", {
        gameDir: settings.gameDir,
        forgeVersion: nextLoaderVersion,
        javaPath: jdk.javaPath,
        ipcSession: sessionId
      });
      nextVersionId = forge.profileId;
      nextLoaderVersion = forge.forgeVersion;
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
      loaderVersion: workingInstance.loader === "vanilla" ? undefined : nextLoaderVersion
    };
    setInstances((prev) =>
      prev.map((item) => (item.id === updatedInstance.id ? updatedInstance : item))
    );
    await ensurePresetModsReady(updatedInstance);
    await ensureManagedContentUpToDate(updatedInstance);
    setStatus(t("app.status.autoInstallCompleted", { name: updatedInstance.name }));
    return updatedInstance;
  }

  async function launchTarget(target: Instance) {
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

    setLaunchError(null);
    setLaunchingInstanceId(target.id);
    setLaunchProgressPercent(null);
    setLaunchProgressText(t("launch.progress.preparing"));
    setBusy(true);
    setStatus(t("app.status.launching", { name: target.name }));
    let launchResult: LaunchExecutionResult | null = null;
    try {
      const prepared = await ensureInstanceReadyForLaunch(target);
      const jdk = await ensureJdk(settings.gameDir, prepared.versionId);
      launchResult = await invoke<LaunchExecutionResult>("launch_vanilla", {
        gameDir: settings.gameDir,
        versionId: prepared.versionId,
        playerName: settings.playerName,
        uuid: "00000000-0000-0000-0000-000000000000",
        accessToken: "offline",
        maxMemoryMb: settings.maxMemoryMb,
        javaPath: jdk.javaPath,
        waitForExit: false
      });
    } catch (error) {
      const errorText = formatLaunchError(error);
      setStatus(t("app.status.launchFailed", { error: errorText }));
      setLaunchError(errorText);
      setBusy(false);
      setLaunchingInstanceId(null);
      return;
    }

    if (!launchResult) {
      const errorText = t("app.status.launchMissingResult");
      setStatus(errorText);
      setLaunchError(errorText);
      setBusy(false);
      setLaunchingInstanceId(null);
      return;
    }

    try {
      await openMonitor(
        launchResult.pid,
        launchResult.versionId,
        logCursorRef.current ?? 0,
        settings.language
      );
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
        invoke<string[]>("list_vanilla_versions"),
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
          ? await invoke<string[]>("list_fabric_loaders", { gameVersion: installVersion })
          : await invoke<string[]>("list_forge_versions", { gameVersion: installVersion });

      if (requestId !== loaderRequestRef.current) return;

      const options = loader === "fabric" ? versions.slice(0, 60) : versions.slice(0, 80);
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

  async function install() {
    if (!installVersion) return;
    if (loader !== "vanilla" && !loaderVersion) {
      setStatus(
        t("app.status.selectLoaderVersionFirst", {
          loader: loaderDisplayName(loader)
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

    setInstallDialog({
      open: true,
      sessionId,
      versionId: installVersion,
      loader,
      canClose: false,
      errorText: "",
      vanilla: {
        ...createPhaseState(t("install.phase.vanilla"), "vanilla"),
        status: "running",
        stage: "prepare",
        message: t("install.phase.preparing", { version: installVersion })
      },
      loaderPhase
    });

    setBusy(true);
    setStatus(t("app.status.installing", { version: installVersion }));
    try {
      const vanilla = await invoke<InstallResult>("install_vanilla", {
        gameDir: settings.gameDir,
        versionId: installVersion,
        ipcSession: sessionId
      });

      setInstallDialog((prev) => {
        if (!prev || prev.sessionId !== sessionId) return prev;
        return {
          ...prev,
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

        const jdk = await ensureJdk(settings.gameDir, installVersion);
        const result = await invoke<ForgeInstallResult>("install_forge", {
          gameDir: settings.gameDir,
          forgeVersion: loaderVersion,
          javaPath: jdk.javaPath,
          ipcSession: sessionId
        });
        versionId = result.profileId;
        loaderName = "forge";
        loaderVer = result.forgeVersion;
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
          loaderPhase: prev.loaderPhase
            ? {
                ...prev.loaderPhase,
                status: "done",
                stage: "complete",
                message: t("install.phase.loaderCompleted")
              }
            : prev.loaderPhase
        };
      });
    } catch (error) {
      const errorText = String(error);
      setStatus(t("app.status.installFailed", { error: errorText }));
      setInstallDialog((prev) => {
        if (!prev || prev.sessionId !== sessionId) return prev;
        const loaderRunning = prev.loaderPhase && prev.loaderPhase.status === "running";
        return {
          ...prev,
          canClose: true,
          errorText,
          vanilla:
            prev.vanilla.status === "running"
              ? { ...prev.vanilla, status: "error", stage: "failed", message: errorText }
              : prev.vanilla,
          loaderPhase: loaderRunning
            ? { ...prev.loaderPhase!, status: "error", stage: "failed", message: errorText }
            : prev.loaderPhase
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

  async function importInstance(file: File) {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setStatus(t("app.status.failed", { error: t("instances.importZipRequired") }));
      return;
    }

    setBusy(true);
    setStatus(t("app.status.instanceImporting"));
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const result = await invoke<InstanceImportResult>("import_instance_archive", {
        gameDir: settings.gameDir,
        archiveName: file.name,
        archiveData: bytes
      });
      const importedName = createImportedInstanceName(file.name, instances);
      const imported: Instance = {
        id: `instance-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        name: importedName,
        versionId: result.versionId,
        baseVersion: result.baseVersion,
        loader: result.loader,
        loaderVersion: result.loaderVersion,
        preset: false
      };
      setInstances((prev) => [imported, ...prev]);
      setInstalledVersions((prev) =>
        prev.includes(result.versionId) ? prev : [result.versionId, ...prev]
      );
      setSelected(imported.id);
      setStatus(t("app.status.instanceImported", { name: imported.name }));
    } catch (error) {
      setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function repairInstance(id: string) {
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
        loaderVersion: result.loaderVersion
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

  async function syncPresetPackage(instanceId: string) {
    const target = instances.find((item) => item.id === instanceId);
    if (!target || !target.preset) {
      return;
    }
    setPresetPackageStatuses((prev) => ({
      ...prev,
      [instanceId]: {
        ...prev[instanceId],
        state: "syncing",
        versionTag: prev[instanceId]?.targetVersionTag ?? prev[instanceId]?.versionTag ?? null,
        lastError: null
      }
    }));
    try {
      await ensurePresetModsReady(target);
      await refreshPresetPackageStatuses();
    } catch (error) {
      setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
      await refreshPresetPackageStatuses();
    }
  }

  function updateSettings(next: Settings) {
    setSettings(next);
  }

  function updateMemory(input: string) {
    const next = Number.parseInt(input, 10);
    setSettings((prev) => ({
      ...prev,
      maxMemoryMb: Number.isFinite(next) ? clamp(next, 1024, 16384) : prev.maxMemoryMb
    }));
  }

  function renderPage() {
    if (page === "home") {
      return (
        <HomePage
          availableInstances={instances}
          launcherNews={launcherNews}
          launcherDashboard={launcherDashboard}
          launcherOnlineSummary={launcherOnlineSummary}
          recommendedVersion={
            current?.launcherVersionType ? launcherVersions[current.launcherVersionType] : null
          }
          current={current}
          busy={busy}
          launching={launching}
          launchProgressPercent={launchProgressPercent}
          launchProgressText={launchProgressText}
          presetPackageStatus={current ? presetPackageStatuses[current.id] : undefined}
          onSelect={setSelected}
          onLaunch={launch}
          onSyncPresetPackage={() => {
            if (current) {
              void syncPresetPackage(current.id);
            }
          }}
        />
      );
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
          presetPackageStatuses={presetPackageStatuses}
          onDelete={removeInstance}
          onDuplicateInstance={duplicateInstance}
          onExportInstance={exportInstance}
          onImportInstance={importInstance}
          onGoInstall={() => setPage("install")}
          onLaunchInstance={async (id) => {
            const target = instances.find((item) => item.id === id);
            if (!target) return;
            setSelected(id);
            await launchTarget(target);
          }}
          onOpenInstanceSettings={(id) => {
            setSelected(id);
            setPage("instance-settings");
          }}
          onSyncPresetPackage={syncPresetPackage}
        />
      );
    }

    if (page === "instance-settings") {
      return (
        <InstanceSettingsPage
          instance={current}
          gameDir={settings.gameDir}
          busy={busy}
          onBack={() => setPage("instances")}
          onRepair={() => {
            if (current) {
              void repairInstance(current.id);
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

    return (
      <SettingsPage
        settings={settings}
        launcherCurrentVersion={CURRENT_LAUNCHER_VERSION}
        launcherUpdate={launcherAppUpdate}
        launcherUpdateAvailable={launcherAppUpdateAvailable}
        launcherUpdateChecking={launcherAppUpdateChecking}
        launcherUpdateDownloading={launcherAppUpdateDownloading}
        launcherUpdateDownload={launcherAppUpdateDownload}
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
      <div className="launcher-shell relative flex h-screen w-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)] select-none pixel-pattern linear-backdrop">
        {activeBackgroundUrl && (
          <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
            <div
              className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-[var(--duration-normal)]"
              style={{
                backgroundImage: `url("${activeBackgroundUrl}")`,
                opacity: settings.backgroundOpacity / 100,
                filter: `blur(${settings.backgroundBlur}px)`,
                transform: settings.backgroundBlur > 0 ? "scale(1.06)" : "scale(1)"
              }}
            />
            <div className="absolute inset-0 bg-[var(--bg-primary)]/16" />
          </div>
        )}
        <div
          className="fixed left-0 right-0 top-0 z-50 flex h-10 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/86 px-3 backdrop-blur-xl"
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
              setPage={setPage}
            />

            <main className="relative flex-1 overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--bg-secondary)]/34">
              <div className="pointer-events-none absolute -right-32 -top-24 h-[420px] w-[420px] rounded-full bg-[var(--mc-grass)]/8 blur-[110px] opacity-45" />
              <div className="pointer-events-none absolute -bottom-32 -left-24 h-[360px] w-[360px] rounded-full bg-[var(--mc-grass)]/6 blur-[105px] opacity-35" />

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
                onSubmit={loginLauncherAccount}
              />
            </div>
          </main>
        )}

        {authenticated && installDialog && installDialog.open && (
          <InstallDialog dialog={installDialog} onClose={closeInstallDialog} />
        )}

        {authenticated && launchError && (
          <div className="fixed inset-0 z-[95] flex items-center justify-center bg-[var(--bg-primary)]/68 p-6 backdrop-blur-md">
            <Card variant="frost" className="w-full max-w-lg rounded-2xl p-6">
              <h3 className="text-xl font-semibold text-[var(--accent-danger)]">
                {t("launch.error.title")}
              </h3>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{t("launch.error.subtitle")}</p>
              <div className="mt-4 rounded-xl border border-[var(--accent-danger)]/40 bg-[var(--accent-danger)]/10 px-4 py-3">
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

function isLauncherVersionCompatible(minLauncherVersion?: null | string): boolean {
  const required = (minLauncherVersion ?? "").trim();
  if (!required) {
    return true;
  }
  return compareSemanticVersion(CURRENT_LAUNCHER_VERSION, required) >= 0;
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
  const lower = text.toLowerCase();
  const isJdkLog =
    lower.includes("jdk") ||
    lower.includes("ensure_jdk") ||
    lower.includes("temurin") ||
    lower.includes("adoptium");
  if (!isJdkLog) return null;

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
  return { text };
}

async function ensureJdk(gameDir: string, versionId: string): Promise<JdkEnsureResult> {
  return invoke<JdkEnsureResult>("ensure_jdk", { gameDir, versionId });
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

async function openMonitor(pid: number, versionId: string, cursor: number, locale: Locale) {
  const params = new URLSearchParams({
    view: "monitor",
    pid: String(pid),
    version: versionId,
    startedAt: String(Date.now()),
    cursor: String(cursor),
    lang: locale
  });

  const monitorLabel = `runtime-monitor-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const win = new WebviewWindow(monitorLabel, {
    title: `FPSMaster Runtime - ${versionId}`,
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
}

function loadLauncherAuthState(): LauncherAuthState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.launcherAuth);
    if (!raw) return null;
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

function createImportedInstanceName(archiveName: string, instances: Instance[]): string {
  const archiveStem = archiveName.replace(/\.[^/.]+$/, "").trim();
  const normalizedBase = archiveStem || "Imported Instance";
  const existingNames = new Set(instances.map((item) => item.name.trim().toLowerCase()));
  if (!existingNames.has(normalizedBase.toLowerCase())) {
    return normalizedBase;
  }

  let index = 2;
  while (index < 1000) {
    const candidate = `${normalizedBase} ${index}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${normalizedBase} ${Date.now()}`;
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
