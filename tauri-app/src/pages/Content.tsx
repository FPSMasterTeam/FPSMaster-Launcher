import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Archive, Box, Download, File, Globe, HardDriveDownload, Layers, PackageCheck, PackageOpen, Palette, Search, Trash2, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Button from "../components/Button";
import Card from "../components/Card";
import Select from "../components/Select";
import modrinthIcon from "../assets/icons/modrinth.ico";
import curseforgeIcon from "../assets/icons/curseforge.ico";
import { useI18n, type TranslationKey } from "../i18n";
import { describeApiError } from "../lib/launcherError";
import { buildNovaEffectiveInstance, listNovaVersionTargets } from "../lib/novaTargets";
import type {
  ContentInstallProgressEvent,
  ContentProjectType,
  ContentSource,
  DownloadSource,
  InstalledContentItem,
  InstalledContentUpdate,
  Instance,
  LauncherVersion,
  ModpackInstallProgressEvent,
  ModpackInstallResult,
  ModrinthInstallResult,
  ModrinthSearchResult,
  OnlineContentSource,
  WorldInstallResult
} from "../types";
import { resolveInstanceIconPath } from "../utils/launcher";

type RightTab = "search" | "installed";

type ContentSelectOption = {
  value: string;
  instanceId: string;
  gameVersion?: string;
  label: string;
  icon: string | null;
};

type ContentPageProps = {
  instances: Instance[];
  current: Instance | null;
  gameDir: string;
  curseforgeApiKey: string;
  downloadSource: DownloadSource;
  downloadThreads: number;
  busy: boolean;
  novaGameVersions: Record<string, LauncherVersion>;
  selectedNovaGameVersion: string;
  onSelectNovaGameVersion: (gameVersion: string) => void;
  onSelectInstance: (id: string) => void;
  onModpackInstalled: (result: ModpackInstallResult) => void;
  onStatusChange: (message: string) => void;
};

const CONTENT_TYPES: readonly { id: ContentProjectType; icon: React.ReactNode }[] = [
  { id: "mod", icon: <Box size={16} /> },
  { id: "modpack", icon: <Layers size={16} /> },
  { id: "resourcepack", icon: <Palette size={16} /> },
  { id: "shader", icon: <File size={16} /> },
  { id: "world", icon: <Globe size={16} /> }
];

const MODPACK_STAGE_LABEL_KEYS: Record<string, TranslationKey> = {
  catalog: "content.modpack.stage.catalog",
  "download-pack": "content.modpack.stage.downloadPack",
  parse: "content.modpack.stage.parse",
  loader: "content.modpack.stage.loader",
  files: "content.modpack.stage.files",
  overrides: "content.modpack.stage.overrides",
  finalize: "content.modpack.stage.finalize"
};

// Backend modpack errors carry a machine-readable "[modpack:<stage>] " prefix
// so the UI can name the failed stage instead of showing a generic failure.
function splitModpackError(raw: string): { stage: string | null; message: string } {
  const match = /^\[modpack:([a-z-]+)\]\s*/i.exec(raw);
  if (!match) return { stage: null, message: raw };
  return { stage: match[1].toLowerCase(), message: raw.slice(match[0].length) };
}

function contentTypeLabel(value: ContentProjectType, t: ReturnType<typeof useI18n>["t"]): string {
  if (value === "resourcepack") return t("content.type.resourcepack");
  if (value === "shader") return t("content.type.shader");
  if (value === "world") return t("content.type.world");
  if (value === "modpack") return t("content.type.modpack");
  return t("content.type.mod");
}

function contentSourceLabel(value: ContentSource, t: ReturnType<typeof useI18n>["t"]): string {
  if (value === "modrinth") return t("content.source.modrinth");
  if (value === "curseforge") return t("content.source.curseforge");
  return t("content.source.local");
}

function formatCompactCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return String(value);
}

function formatInstalledDate(installedAtEpochSec: number): string | null {
  if (!Number.isFinite(installedAtEpochSec) || installedAtEpochSec <= 0) return null;
  const parsed = new Date(installedAtEpochSec * 1000);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString();
}

// Small in-page confirm dialog reusing the app's modal pattern — the raw
// window.confirm it replaces looked foreign and could not be styled/localized.
function UninstallConfirmDialog({
  item,
  closing,
  busy,
  onCancel,
  onConfirm
}: {
  item: InstalledContentItem | null;
  closing: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!item) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancelRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused?.isConnected && !previouslyFocused.matches(":disabled")) {
        previouslyFocused.focus();
        if (document.activeElement === previouslyFocused) return;
      }
      // The trigger row is gone after a confirmed uninstall — fall back to
      // the installed tab (or the search field) instead of dropping focus.
      const fallback =
        document.querySelector<HTMLElement>(".content-primary-tab.is-active") ??
        document.querySelector<HTMLElement>(".content-topbar-search input");
      fallback?.focus();
    };
  }, [item]);

  if (!item || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`modal-shell ${closing ? "modal-backdrop-animate-out" : "modal-backdrop-animate"}`}
      onClick={onCancel}
      role="presentation"
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="content-uninstall-title"
        variant="strong"
        className={`${closing ? "modal-animate-out" : "modal-animate"} modal-card page-card w-full max-w-md`}
        interactive={false}
        onClick={(event: React.MouseEvent) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="min-w-0">
            <p className="page-eyebrow">{t("content.uninstall")}</p>
            <h3 id="content-uninstall-title" className="section-title mt-2">
              {t("content.uninstallDialogTitle")}
            </h3>
          </div>
          <button
            ref={closeButtonRef}
            className="modal-close"
            onClick={onCancel}
            type="button"
            aria-label={t("common.cancel")}
          >
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="text-sm leading-6 text-[var(--text-secondary)]">
            {t("content.uninstallConfirm", { title: item.projectTitle })}
          </p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" size="sm" className="gap-2" disabled={busy} onClick={onConfirm}>
              <Trash2 size={14} />
              {t("content.uninstall")}
            </Button>
          </div>
        </div>
      </Card>
    </div>,
    document.body
  );
}

// Skeleton placeholders shown while a search or trending load is in flight.
function ResultSkeletonList() {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="skeleton-row">
          <div className="skeleton-block h-14 w-14 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="skeleton-block h-4 w-2/5" />
            <div className="skeleton-block mt-2 h-3 w-1/4" />
            <div className="skeleton-block mt-3 h-3 w-4/5" />
          </div>
          <div className="skeleton-block h-9 w-28 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function ContentPage({
  instances,
  current,
  gameDir,
  curseforgeApiKey,
  downloadSource,
  downloadThreads,
  busy,
  novaGameVersions,
  selectedNovaGameVersion,
  onSelectNovaGameVersion,
  onSelectInstance,
  onModpackInstalled,
  onStatusChange
}: ContentPageProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<ContentSource>("modrinth");
  const [contentType, setContentType] = useState<ContentProjectType>("mod");
  const [loading, setLoading] = useState(false);
  const [installingProjectId, setInstallingProjectId] = useState<string | null>(null);
  const [uninstallingProjectId, setUninstallingProjectId] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [batchUpdating, setBatchUpdating] = useState(false);
  const [importingWorld, setImportingWorld] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("search");
  const [results, setResults] = useState<ModrinthSearchResult[]>([]);
  const [installedItems, setInstalledItems] = useState<InstalledContentItem[]>([]);
  const [installedUpdates, setInstalledUpdates] = useState<InstalledContentUpdate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [contentInstallProgress, setContentInstallProgress] = useState<ContentInstallProgressEvent | null>(null);
  const [modpackProgress, setModpackProgress] = useState<ModpackInstallProgressEvent | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledContentItem | null>(null);
  const [uninstallDialogClosing, setUninstallDialogClosing] = useState(false);
  const novaPreset = useMemo(
    () => instances.find((item) => item.preset && item.launcherVersionType === "NOVA") ?? null,
    [instances]
  );

  const selectOptions = useMemo(() => {
    const options: ContentSelectOption[] = [];
    for (const instance of instances) {
      if (instance.preset && instance.launcherVersionType === "NOVA") {
        continue;
      }
      options.push({
        value: instance.id,
        instanceId: instance.id,
        label: instance.name,
        icon: resolveInstanceIconPath(instance)
      });
    }
    if (novaPreset) {
      for (const { gameVersion } of listNovaVersionTargets(novaGameVersions, selectedNovaGameVersion)) {
        options.push({
          value: `nova:${gameVersion}`,
          instanceId: novaPreset.id,
          gameVersion,
          label: `Nova ${gameVersion}`,
          icon: resolveInstanceIconPath(novaPreset)
        });
      }
    }
    return options;
  }, [instances, novaPreset, novaGameVersions, selectedNovaGameVersion]);

  const currentInstance = useMemo(() => {
    if (current?.launcherVersionType === "NOVA") {
      return buildNovaEffectiveInstance(current, selectedNovaGameVersion || current.baseVersion);
    }
    if (current) return current;
    const first = instances[0] ?? null;
    if (!first) return null;
    if (first.launcherVersionType === "NOVA") {
      return buildNovaEffectiveInstance(first, selectedNovaGameVersion || first.baseVersion);
    }
    return first;
  }, [current, instances, selectedNovaGameVersion]);

  const selectedOptionValue =
    currentInstance?.launcherVersionType === "NOVA"
      ? `nova:${currentInstance.baseVersion}`
      : currentInstance?.id ?? "";

  const currentInstanceLabel =
    currentInstance?.launcherVersionType === "NOVA"
      ? `Nova ${currentInstance.baseVersion}`
      : currentInstance?.name ?? "";
  const currentInstanceIcon = currentInstance ? resolveInstanceIconPath(currentInstance) : null;

  function handleSelectInstance(value: string) {
    if (value.startsWith("nova:")) {
      const gameVersion = value.slice("nova:".length);
      if (novaPreset) {
        onSelectNovaGameVersion(gameVersion);
        onSelectInstance(novaPreset.id);
      }
      return;
    }
    onSelectInstance(value);
  }

  const availableSources =
    contentType === "world"
      ? (["modrinth", "curseforge", "local"] as const satisfies readonly ContentSource[])
      : (["modrinth", "curseforge"] as const satisfies readonly OnlineContentSource[]);
  const worldImportMode = contentType === "world" && source === "local";
  // Modpack search/install builds a brand-new instance, so it never depends on
  // the currently selected instance.
  const modpackMode = contentType === "modpack";
  const contentNavigationBusy =
    loading || batchUpdating || importingWorld || Boolean(installingProjectId) || Boolean(uninstallingProjectId);
  const searchPlaceholder = worldImportMode
    ? t("content.worldSearchUnavailable")
    : contentType === "world"
      ? t("content.worldSearchPlaceholder")
      : t("content.searchPlaceholder");

  const installedMap = useMemo(() => {
    const map = new Map<string, InstalledContentItem>();
    installedItems.forEach((item) => map.set(`${item.source}:${item.contentType}:${item.projectId}`, item));
    return map;
  }, [installedItems]);

  const updateMap = useMemo(() => {
    const map = new Map<string, InstalledContentUpdate>();
    installedUpdates.forEach((item) => map.set(`${item.source}:${item.contentType}:${item.projectId}`, item));
    return map;
  }, [installedUpdates]);

  const filteredInstalledItems = useMemo(
    () => installedItems.filter((item) => item.contentType === contentType),
    [installedItems, contentType]
  );

  const filteredUpdatableItems = useMemo(
    () =>
      filteredInstalledItems.filter(
        (item) => updateMap.get(`${item.source}:${item.contentType}:${item.projectId}`)?.status === "update-available"
      ),
    [filteredInstalledItems, updateMap]
  );

  // Library view: items with a pending update float to the top, the rest sort
  // alphabetically so a long list stays scannable.
  const sortedInstalledItems = useMemo(() => {
    const hasUpdate = (item: InstalledContentItem) =>
      updateMap.get(`${item.source}:${item.contentType}:${item.projectId}`)?.status === "update-available";
    return [...filteredInstalledItems].sort((a, b) => {
      const updateDelta = Number(hasUpdate(b)) - Number(hasUpdate(a));
      if (updateDelta !== 0) return updateDelta;
      return a.projectTitle.localeCompare(b.projectTitle);
    });
  }, [filteredInstalledItems, updateMap]);

  async function fetchProjects(queryValue: string): Promise<ModrinthSearchResult[]> {
    if (!currentInstance && !modpackMode) return [];
    // Modpacks bring their own Minecraft version and loader, so their search
    // is not filtered by the selected instance.
    const gameVersion = modpackMode ? undefined : currentInstance?.baseVersion;
    const loader = modpackMode ? undefined : currentInstance?.loader;
    if (source === "modrinth") {
      return invoke<ModrinthSearchResult[]>("modrinth_search_projects", {
        query: queryValue,
        projectType: contentType,
        gameVersion,
        loader
      });
    }
    if (source === "curseforge") {
      return invoke<ModrinthSearchResult[]>("curseforge_search_projects", {
        query: queryValue,
        projectType: contentType,
        gameVersion,
        loader,
        apiKey: curseforgeApiKey
      });
    }
    return [];
  }

  async function loadTrendingProjects() {
    if ((!currentInstance && !modpackMode) || worldImportMode) return;
    setLoading(true);
    setError(null);
    onStatusChange(t("content.loadingTrending"));
    try {
      const searchResults = await fetchProjects("");
      setResults(searchResults);
      setHasSearched(true);
      setRightTab("search");
      onStatusChange(t("content.trendingLoaded", { count: searchResults.length }));
    } catch (invokeError) {
      setError(normalizeError(invokeError));
      setResults([]);
      setHasSearched(true);
    } finally {
      setLoading(false);
    }
  }

  async function refreshInstalledState(instance: Instance | null) {
    if (!instance) {
      setInstalledItems([]);
      setInstalledUpdates([]);
      setCheckingUpdates(false);
      return;
    }
    try {
      const items = await invoke<InstalledContentItem[]>("list_installed_content", {
        gameDir,
        versionId: instance.versionId
      });
      setInstalledItems(items);
      if (items.length === 0) {
        setInstalledUpdates([]);
        return;
      }
      setCheckingUpdates(true);
      try {
        const updates = await invoke<InstalledContentUpdate[]>("check_installed_content_updates", {
          gameDir,
          versionId: instance.versionId,
          gameVersion: instance.baseVersion,
          loader: instance.loader,
          apiKey: curseforgeApiKey
        });
        setInstalledUpdates(updates);
      } catch {
        // Ignore update check errors
      }
    } catch {
      // Ignore content refresh errors
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function searchProjects() {
    if (!currentInstance && !modpackMode) return;
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      await loadTrendingProjects();
      return;
    }
    setLoading(true);
    setError(null);
    setResults([]);
    try {
      const searchResults = await fetchProjects(trimmedQuery);
      setResults(searchResults);
      setHasSearched(true);
      setRightTab("search");
      onStatusChange(t("content.searchDone", { count: searchResults.length }));
    } catch (invokeError) {
      setError(normalizeError(invokeError));
    } finally {
      setLoading(false);
    }
  }

  async function installModpack(params: {
    source: OnlineContentSource;
    projectId: string;
    title: string;
  }): Promise<boolean> {
    const projectKey = `${params.source}:modpack:${params.projectId}`;
    setInstallingProjectId(projectKey);
    setContentInstallProgress({ projectKey, downloadedBytes: 0, totalBytes: null, percent: null });
    setModpackProgress(null);
    setError(null);
    onStatusChange(t("content.modpack.installing", { title: params.title }));
    try {
      const result = await invoke<ModpackInstallResult>("install_modpack", {
        gameDir,
        source: params.source,
        projectId: params.projectId,
        projectTitle: params.title,
        apiKey: params.source === "curseforge" ? curseforgeApiKey : undefined,
        downloadSource,
        downloadThreads
      });
      onModpackInstalled(result);
      onStatusChange(t("content.modpack.installDone", { name: result.name }));
      return true;
    } catch (invokeError) {
      const raw = typeof invokeError === "string" ? invokeError : invokeError instanceof Error ? invokeError.message : String(invokeError);
      const { stage, message } = splitModpackError(raw.trim());
      const stageLabelKey = stage ? MODPACK_STAGE_LABEL_KEYS[stage] : undefined;
      const errorText = stageLabelKey
        ? t("content.modpack.stageFailed", { stage: t(stageLabelKey), error: message })
        : normalizeError(message);
      setError(errorText);
      onStatusChange(t("app.status.failed", { error: errorText }));
      return false;
    } finally {
      setInstallingProjectId(null);
      setContentInstallProgress(null);
      setModpackProgress(null);
    }
  }

  async function installProject(params: {
    source: OnlineContentSource;
    projectId: string;
    projectType: string;
    title: string;
  }): Promise<boolean> {
    if (params.projectType === "modpack") {
      return installModpack(params);
    }
    if (!currentInstance) {
      setError(t("content.noInstance"));
      return false;
    }
    const projectKey = `${params.source}:${params.projectType}:${params.projectId}`;
    setInstallingProjectId(projectKey);
    setContentInstallProgress({ projectKey, downloadedBytes: 0, totalBytes: null, percent: null });
    setError(null);
    onStatusChange(t("content.installing", { title: params.title }));
    try {
      const command = params.source === "curseforge" ? "install_curseforge_project" : "install_modrinth_project";
      const result = await invoke<ModrinthInstallResult>(command, {
        gameDir,
        versionId: currentInstance.versionId,
        projectId: params.projectId,
        projectTitle: params.title,
        projectType: params.projectType,
        gameVersion: currentInstance.baseVersion,
        loader: currentInstance.loader,
        ...(params.source === "curseforge" ? { apiKey: curseforgeApiKey } : {})
      });
      await refreshInstalledState(currentInstance);
      onStatusChange(t("content.installDone", { title: params.title, file: result.fileName }));
      return true;
    } catch (invokeError) {
      const errorText = normalizeError(invokeError);
      setError(errorText);
      onStatusChange(t("app.status.failed", { error: errorText }));
      return false;
    } finally {
      setInstallingProjectId(null);
      setContentInstallProgress(null);
    }
  }

  function closeUninstallDialog() {
    setUninstallDialogClosing(true);
    window.setTimeout(() => {
      setPendingUninstall(null);
      setUninstallDialogClosing(false);
    }, 150);
  }

  function confirmUninstall() {
    const item = pendingUninstall;
    closeUninstallDialog();
    if (item) void uninstallProject(item);
  }

  async function uninstallProject(item: InstalledContentItem) {
    if (!currentInstance) {
      setError(t("content.noInstance"));
      return;
    }
    setUninstallingProjectId(`${item.source}:${item.contentType}:${item.projectId}`);
    setError(null);
    onStatusChange(t("content.uninstalling", { title: item.projectTitle }));
    try {
      await invoke("uninstall_installed_content", {
        gameDir,
        versionId: currentInstance.versionId,
        source: item.source,
        projectId: item.projectId,
        contentType: item.contentType
      });
      await refreshInstalledState(currentInstance);
      onStatusChange(t("content.uninstallDone", { title: item.projectTitle }));
    } catch (invokeError) {
      const errorText = normalizeError(invokeError);
      setError(errorText);
      onStatusChange(t("app.status.failed", { error: errorText }));
    } finally {
      setUninstallingProjectId(null);
    }
  }

  async function updateAllProjects() {
    if (!currentInstance || filteredUpdatableItems.length === 0) return;
    setBatchUpdating(true);
    setError(null);
    try {
      let completed = 0;
      for (const item of filteredUpdatableItems) {
        completed += 1;
        onStatusChange(
          t("content.updatingProgress", {
            title: item.projectTitle,
            current: completed,
            total: filteredUpdatableItems.length
          })
        );
        const success = await installProject({
          source: item.source as OnlineContentSource,
          projectId: item.projectId,
          projectType: item.contentType,
          title: item.projectTitle
        });
        if (!success) return;
      }
      onStatusChange(t("content.updateAllDone", { count: filteredUpdatableItems.length }));
    } finally {
      setBatchUpdating(false);
    }
  }

  async function handleWorldImport() {
    if (!currentInstance) {
      setError(t("content.noInstance"));
      return;
    }
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "ZIP", extensions: ["zip"] }]
    });
    if (typeof selected !== "string" || !selected) return;
    if (!selected.toLowerCase().endsWith(".zip")) {
      setError(t("content.worldZipRequired"));
      return;
    }
    const archiveName = selected.split(/[\\/]/).pop() ?? "world.zip";
    setImportingWorld(true);
    setError(null);
    onStatusChange(t("content.importingWorld"));
    try {
      // Pass the picked path instead of streaming the whole ZIP over IPC.
      const result = await invoke<WorldInstallResult>("import_world_archive", {
        gameDir,
        versionId: currentInstance.versionId,
        archiveName,
        archivePath: selected
      });
      await refreshInstalledState(currentInstance);
      onStatusChange(t("content.worldImportDone", { title: result.projectTitle }));
    } catch (invokeError) {
      const errorText = normalizeError(invokeError);
      setError(errorText);
      onStatusChange(t("app.status.failed", { error: errorText }));
    } finally {
      setImportingWorld(false);
    }
  }

  useEffect(() => {
    setResults([]);
    setError(null);
    setContentInstallProgress(null);
    setModpackProgress(null);
    setHasSearched(false);
    setRightTab("search");
  }, [currentInstance?.id, currentInstance?.versionId, contentType, source]);

  useEffect(() => {
    void refreshInstalledState(currentInstance);
  }, [currentInstance]);

  useEffect(() => {
    if ((!currentInstance && !modpackMode) || worldImportMode || query.trim()) {
      if (worldImportMode) {
        setResults([]);
        setHasSearched(false);
      }
      return;
    }
    void loadTrendingProjects();
  }, [currentInstance?.id, currentInstance?.versionId, contentType, source, worldImportMode]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<ContentInstallProgressEvent>("content-install-progress", (event) => {
      if (!cancelled) setContentInstallProgress(event.payload);
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<ModpackInstallProgressEvent>("modpack-install-progress", (event) => {
      if (!cancelled) setModpackProgress(event.payload);
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const loaderLabel = (loader: Instance["loader"]) => {
    if (loader === "forge") return t("loader.forge");
    if (loader === "fabric") return t("loader.fabric");
    return t("loader.vanilla");
  };

  const normalizeError = (errorValue: unknown) => {
    const raw = typeof errorValue === "string" ? errorValue : errorValue instanceof Error ? errorValue.message : String(errorValue);
    const normalized = raw.trim();
    const currentVersion = currentInstance?.baseVersion?.trim();
    const currentLoader = currentInstance ? loaderLabel(currentInstance.loader) : null;
    if (/CurseForge download URL lookup failed with HTTP 403/i.test(normalized)) {
      return t("content.error.curseforgeDistributionBlocked");
    }
    if (/No compatible CurseForge file found for the current instance/i.test(normalized)) {
      if (currentVersion && currentLoader) {
        return t("content.error.curseforgeNoCompatibleFileDetailed", { version: currentVersion, loader: currentLoader });
      }
      return t("content.error.curseforgeNoCompatibleFile");
    }
    if (/CurseForge file does not expose a usable download URL/i.test(normalized)) {
      return t("content.error.curseforgeNoDownloadUrl");
    }
    if (/CurseForge project id cannot be empty/i.test(normalized)) {
      return t("content.error.curseforgeMissingProjectId");
    }
    // Anything not matched above is usually a transport failure; returning the
    // raw reqwest chain gave users nothing actionable.
    return describeApiError(errorValue, t);
  };

  return (
    <div className="page-shell h-full overflow-y-auto">
      <header className="page-header mb-6">
        <div className="page-header-main">
          <p className="page-eyebrow">{t("nav.content")}</p>
          <h1 className="page-title">{t("content.title")}</h1>
          <p className="page-subtitle">{t("content.subtitle")}</p>
        </div>

      </header>

      <section className="content-layout">
        <aside className="content-sidebar">
          <Card variant="frost" className="liquid-chrome page-card rounded-[10px]" interactive={false}>
            <div className="content-nav-group">
              <p className="content-nav-label">{t("content.downloadResources")}</p>
              <div className="content-primary-tabs content-primary-tabs-vertical">
                <button
                  type="button"
                  onClick={() => setRightTab("search")}
                  className={`content-primary-tab ${rightTab === "search" ? "is-active" : ""}`}
                >
                  <HardDriveDownload size={16} />
                  <span>{t("content.downloadResources")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab("installed")}
                  className={`content-primary-tab ${rightTab === "installed" ? "is-active" : ""}`}
                >
                  <PackageCheck size={16} />
                  <span>{t("content.installed")}</span>
                  {filteredInstalledItems.length > 0 && (
                    <span className={`badge ${rightTab === "installed" ? "badge-muted" : "badge-accent"} normal-case tracking-normal`}>
                      {filteredInstalledItems.length}
                    </span>
                  )}
                </button>
              </div>
            </div>

            <div className="content-nav-group">
              <p className="content-nav-label">{t("content.type.mod")}</p>
              <div className="content-type-list">
                {CONTENT_TYPES.map((item) => {
                  const isActive = contentType === item.id;
                  const count = installedItems.filter((installed) => installed.contentType === item.id).length;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={contentNavigationBusy}
                      onClick={() => {
                        setContentType(item.id);
                        // "local" only exists for worlds; keeping it selected on
                        // other tabs would silently return empty results.
                        if (item.id !== "world" && source === "local") {
                          setSource("modrinth");
                        }
                        setRightTab("search");
                      }}
                      className={`content-type-item ${isActive ? "is-active" : ""}`}
                      title={contentTypeLabel(item.id, t)}
                    >
                      <span className="content-type-item-icon">{item.icon}</span>
                      <span className="min-w-0 flex-1 truncate">{contentTypeLabel(item.id, t)}</span>
                      {count > 0 && <span className={`badge ${isActive ? "badge-muted" : "badge-accent"} normal-case tracking-normal`}>{count}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="content-nav-group">
              <p className="content-nav-label">{t("content.platformSwitch")}</p>
              <div className="content-platform-row">
                {availableSources.map((item) => {
                  const isActive = source === item;
                  const iconSrc = item === "modrinth" ? modrinthIcon : item === "curseforge" ? curseforgeIcon : null;
                  return (
                    <button
                      key={item}
                      type="button"
                      disabled={contentNavigationBusy}
                      onClick={() => setSource(item)}
                      className={`content-platform-button ${isActive ? "is-active" : ""}`}
                      title={contentSourceLabel(item, t)}
                      aria-label={contentSourceLabel(item, t)}
                    >
                      <span className="content-platform-button-icon">
                        {iconSrc ? <img src={iconSrc} alt={item} className="h-4 w-4" /> : <Archive size={15} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {checkingUpdates && (
              <div className="content-nav-group pt-1">
                <span className="badge badge-muted normal-case tracking-normal">{t("content.checkingUpdates")}</span>
              </div>
            )}
          </Card>
        </aside>

        <div className="content-main">
          <Card variant="frost" className="liquid-chrome page-card page-card-compact mb-4 rounded-[10px]" interactive={false}>
            <div className="content-topbar-card">
              <div className="content-topbar-instance">
                <Select value={selectedOptionValue} onValueChange={handleSelectInstance}>
                  <Select.Trigger unstyled className="content-topbar-select" aria-label={t("content.selectInstance")}>
                    {currentInstance ? (
                      <span className="content-topbar-select-value">
                        <span className="content-instance-icon">
                          {currentInstanceIcon ? (
                            <img
                              src={currentInstanceIcon}
                              alt={currentInstanceLabel}
                              className="h-full w-full object-contain p-[1px]"
                            />
                          ) : (
                            <span>{currentInstanceLabel.slice(0, 1).toUpperCase()}</span>
                          )}
                        </span>
                        <span className="truncate">{currentInstanceLabel}</span>
                      </span>
                    ) : (
                      <Select.Value placeholder={t("content.selectInstance")} />
                    )}
                  </Select.Trigger>
                  <Select.Content>
                    {selectOptions.map((option) => (
                      <Select.Item key={option.value} value={option.value}>
                        <span className="flex min-w-0 items-center gap-3">
                          <span className="content-instance-icon">
                            {option.icon ? (
                              <img
                                src={option.icon}
                                alt={option.label}
                                className="h-full w-full object-contain p-[1px]"
                              />
                            ) : (
                              <span>{option.label.slice(0, 1).toUpperCase()}</span>
                            )}
                          </span>
                          <span className="truncate">{option.label}</span>
                        </span>
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
              </div>

              {!worldImportMode ? (
                <div className="content-topbar-search gap-2">
                  <label className="search-field min-w-0 flex-1">
                    <Search className="search-field-icon" size={16} />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void searchProjects();
                        }
                      }}
                      type="text"
                      placeholder={searchPlaceholder}
                      aria-label={searchPlaceholder}
                      className="ui-input"
                    />
                  </label>
                  <Button
                    variant="secondary"
                    size="md"
                    className="shrink-0 gap-2 !rounded-[8px]"
                    disabled={loading}
                    onClick={() => void searchProjects()}
                  >
                    <Search size={15} />
                    {t("content.search")}
                  </Button>
                </div>
              ) : (
                <div className="content-topbar-search">
                  <p className="section-subtitle !mt-0">{t("content.selectZipFile")}</p>
                </div>
              )}
            </div>
          </Card>

          {(worldImportMode || filteredUpdatableItems.length > 0) && (
            <div className="mb-5 flex flex-wrap justify-end gap-2">
              {worldImportMode && (
                <Button variant="primary" size="md" className="!rounded-[10px] gap-2" disabled={busy || importingWorld || !currentInstance} onClick={() => void handleWorldImport()}>
                  <Download size={16} />
                  {importingWorld ? t("content.importingWorld") : t("content.selectZipFile")}
                </Button>
              )}

              {filteredUpdatableItems.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="!rounded-[10px] gap-2 border-amber-500/25 bg-amber-500/8 text-amber-200 hover:bg-amber-500/12"
                  disabled={busy || batchUpdating || checkingUpdates}
                  onClick={() => void updateAllProjects()}
                >
                  <Download size={14} />
                  {t("content.updateAll")}
                  <span className="badge badge-warning normal-case tracking-normal">{filteredUpdatableItems.length}</span>
                </Button>
              )}
            </div>
          )}

          {error && (
            <div className="notice notice-danger mb-5">
              <X size={16} className="mt-0.5 shrink-0 text-[var(--accent-danger)]" />
              <div>
                <p className="notice-text !mt-0">{error}</p>
              </div>
            </div>
          )}

          {modpackProgress && installingProjectId === modpackProgress.projectKey && (
            <Card variant="frost" className="page-card page-card-compact mb-5 rounded-[10px]" interactive={false}>
              <div className="flex items-center gap-3">
                <Layers size={16} className="shrink-0 text-[var(--text-secondary)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="badge badge-accent normal-case tracking-normal">
                      {t(MODPACK_STAGE_LABEL_KEYS[modpackProgress.stage] ?? "content.modpack.stage.files")}
                    </span>
                    <p className="truncate text-xs text-[var(--text-secondary)]">
                      {t("content.modpack.stageProgress", {
                        stage: t(MODPACK_STAGE_LABEL_KEYS[modpackProgress.stage] ?? "content.modpack.stage.files")
                      })}
                    </p>
                  </div>
                  <div className="progressTrack">
                    <div
                      className="progressFill"
                      style={{ width: `${modpackProgress.percent ?? (modpackProgress.total > 0 ? Math.round((modpackProgress.current / modpackProgress.total) * 100) : 0)}%` }}
                    />
                  </div>
                </div>
                {modpackProgress.total > 0 && (
                  <span className="shrink-0 text-xs text-[var(--text-muted)] text-data">
                    {modpackProgress.percent != null ? `${modpackProgress.percent}%` : `${modpackProgress.current}/${modpackProgress.total}`}
                  </span>
                )}
              </div>
            </Card>
          )}

          {rightTab === "search" ? (
            loading ? (
              <ResultSkeletonList />
            ) : !hasSearched ? (
              <div className="empty-state">
                <PackageOpen size={40} className="empty-state-icon" />
                <p className="empty-state-title">{t("content.searchResults")}</p>
                <p className="empty-state-text">{t("content.searchHint")}</p>
              </div>
            ) : results.length === 0 ? (
              <div className="empty-state">
                <Search size={40} className="empty-state-icon" />
                <p className="empty-state-title">{t("content.noSearchResults")}</p>
                <p className="empty-state-text">{t("content.noSearchResultsHint")}</p>
              </div>
            ) : (
              <div className="surface-list">
                {results.map((item) => {
                  const updateState = updateMap.get(`${item.source}:${item.projectType}:${item.projectId}`);
                  const canUpdate = updateState?.status === "update-available";
                  const isInstalled = installedMap.has(`${item.source}:${item.projectType}:${item.projectId}`);
                  const itemKey = `${item.source}:${item.projectType}:${item.projectId}`;
                  const actionBusy = busy || Boolean(installingProjectId) || Boolean(uninstallingProjectId);
                  const installProgress = contentInstallProgress?.projectKey === itemKey ? contentInstallProgress : null;
                  return (
                    <Card key={itemKey} variant="frost" className={`page-card page-card-compact rounded-[10px] ${isInstalled ? "border-[rgba(var(--accent-rgb),0.28)]" : ""}`} interactive={false}>
                      <div className="flex gap-4">
                        <div className="icon-tile h-14 w-14 rounded-[8px]">
                          {item.iconUrl ? <img src={item.iconUrl} alt={item.title} className="h-full w-full object-cover" /> : <Archive size={18} />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{item.title}</p>
                            {isInstalled && <span className={`badge ${canUpdate ? "badge-warning" : "badge-success"} normal-case tracking-normal`}>{canUpdate ? t("content.updateAvailableBadge") : t("content.installedBadge")}</span>}
                          </div>
                          <p className="mt-1 text-xs text-[var(--text-muted)]">{item.author}</p>
                          <p className="mt-2 line-clamp-2 text-sm text-[var(--text-secondary)]">{item.description || t("content.noDescription")}</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <span className="badge badge-muted normal-case tracking-normal">{contentSourceLabel(item.source, t)}</span>
                            <span className="badge badge-muted normal-case tracking-normal">{contentTypeLabel(item.projectType, t)}</span>
                            {item.downloads > 0 && (
                              <span className="badge badge-muted normal-case tracking-normal" title={t("content.downloads")}>
                                <Download size={11} />
                                <span className="text-data">{formatCompactCount(item.downloads)}</span>
                              </span>
                            )}
                            {item.latestGameVersion && (
                              <span className="badge badge-muted normal-case tracking-normal" title={t("content.latestGameVersion")}>
                                <span className="text-data">{item.latestGameVersion}</span>
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center">
                          <Button
                            variant={isInstalled && !canUpdate ? "outline" : "primary"}
                            size="sm"
                            className="content-download-button !rounded-[10px] gap-2"
                            disabled={actionBusy}
                            launchProgress={Boolean(installProgress)}
                            launchProgressPercent={installProgress?.percent ?? null}
                            onClick={() => void installProject({ source: item.source as OnlineContentSource, projectId: item.projectId, projectType: item.projectType, title: item.title })}
                          >
                            <Download size={15} />
                            {installProgress
                              ? `${installProgress.percent ?? 0}%`
                              : isInstalled && canUpdate
                                ? t("content.update")
                                : isInstalled
                                  ? t("content.reinstall")
                                  : t("content.install")}
                          </Button>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )
          ) : filteredInstalledItems.length > 0 ? (
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="section-subtitle !mt-0">
                  {t("content.installedSectionTitle")}
                  {" · "}
                  <span className="text-data">{t("content.installedCount", { count: filteredInstalledItems.length })}</span>
                </p>
                {checkingUpdates && (
                  <span className="badge badge-muted normal-case tracking-normal">{t("content.checkingUpdates")}</span>
                )}
              </div>
              <div className="surface-list">
                {sortedInstalledItems.map((item) => {
                  const updateState = updateMap.get(`${item.source}:${item.contentType}:${item.projectId}`);
                  const canUpdate = updateState?.status === "update-available";
                  const supportsOnlineUpdate = item.source !== "local";
                  const itemKey = `${item.source}:${item.contentType}:${item.projectId}`;
                  const isItemBusy = busy || Boolean(installingProjectId) || Boolean(uninstallingProjectId);
                  const installProgress = contentInstallProgress?.projectKey === itemKey ? contentInstallProgress : null;
                  const installedDate = formatInstalledDate(item.installedAtEpochSec);
                  const typeIcon = CONTENT_TYPES.find((entry) => entry.id === item.contentType)?.icon ?? <Archive size={16} />;
                  return (
                    <div key={itemKey} className={`surface-list-item ${canUpdate ? "is-warning" : ""}`}>
                      <div className="icon-tile h-11 w-11 rounded-[8px]">{typeIcon}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{item.projectTitle}</p>
                          {canUpdate ? (
                            <span className="badge badge-warning normal-case tracking-normal">{t("content.updateAvailableBadge")}</span>
                          ) : (
                            supportsOnlineUpdate &&
                            updateState?.status === "up-to-date" && (
                              <span className="badge badge-success normal-case tracking-normal">{t("content.upToDateBadge")}</span>
                            )
                          )}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                          <span className="text-data">{item.versionNumber}</span>
                          {canUpdate && updateState?.latestVersionNumber && (
                            <>
                              <span aria-hidden="true">→</span>
                              <span className="badge badge-warning normal-case tracking-normal">
                                <span className="text-data">{updateState.latestVersionNumber}</span>
                              </span>
                            </>
                          )}
                          <span className="badge badge-muted normal-case tracking-normal">
                            {item.source === "local" ? t("content.source.imported") : contentSourceLabel(item.source, t)}
                          </span>
                          {installedDate && <span>{t("content.installedAt", { date: installedDate })}</span>}
                        </div>
                        <p className="text-data mt-1 truncate text-[11px] text-[var(--text-muted)]" title={item.fileName}>
                          {item.fileName}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {supportsOnlineUpdate && canUpdate && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="content-download-button !rounded-[10px] gap-2"
                            disabled={isItemBusy}
                            launchProgress={Boolean(installProgress)}
                            launchProgressPercent={installProgress?.percent ?? null}
                            onClick={() => void installProject({ source: item.source as OnlineContentSource, projectId: item.projectId, projectType: item.contentType, title: item.projectTitle })}
                          >
                            <Download size={12} />
                            {installProgress ? `${installProgress.percent ?? 0}%` : t("content.update")}
                          </Button>
                        )}
                        <button type="button" className="icon-button icon-button-danger" disabled={isItemBusy} onClick={() => setPendingUninstall(item)} aria-label={t("content.uninstall")} title={t("content.uninstall")}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <Archive size={40} className="empty-state-icon" />
              <p className="empty-state-title">{t("content.installed")}</p>
              <p className="empty-state-text">
                {modpackMode ? t("content.modpack.installedHint") : t("content.installedEmpty")}
              </p>
            </div>
          )}
        </div>
      </section>

      <UninstallConfirmDialog
        item={pendingUninstall}
        closing={uninstallDialogClosing}
        busy={busy || Boolean(uninstallingProjectId)}
        onCancel={closeUninstallDialog}
        onConfirm={confirmUninstall}
      />
    </div>
  );
}

export default memo(ContentPage);
