import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Download, Search, Sparkles, Trash2, Globe, Box, Palette, File, Archive, X, List, ChevronRight } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import Select from "../components/Select";
import { useI18n } from "../i18n";
import modrinthIcon from "../assets/icons/modrinth.ico";
import curseforgeIcon from "../assets/icons/curseforge.ico";
import { resolveInstanceIconPath } from "../utils/launcher";
import type {
  ContentInstallProgressEvent,
  ContentProjectType,
  ContentSource,
  InstalledContentItem,
  InstalledContentUpdate,
  Instance,
  ModrinthInstallResult,
  ModrinthSearchResult,
  OnlineContentSource,
  WorldInstallResult
} from "../types";

type RightTab = "search" | "installed";

type ContentPageProps = {
  instances: Instance[];
  current: Instance | null;
  gameDir: string;
  curseforgeApiKey: string;
  busy: boolean;
  onSelectInstance: (id: string) => void;
  onStatusChange: (message: string) => void;
};

const CONTENT_TYPES: readonly { id: ContentProjectType; icon: React.ReactNode }[] = [
  { id: "mod", icon: <Box size={16} /> },
  { id: "resourcepack", icon: <Palette size={16} /> },
  { id: "shader", icon: <File size={16} /> },
  { id: "world", icon: <Globe size={16} /> }
];

export default function ContentPage({
  instances,
  current,
  gameDir,
  curseforgeApiKey,
  busy,
  onSelectInstance,
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
  const worldFileInputRef = useRef<HTMLInputElement | null>(null);

  const currentInstance = current ?? instances[0] ?? null;
  const currentInstanceIcon = currentInstance ? resolveInstanceIconPath(currentInstance) : null;
  const availableSources =
    contentType === "world"
      ? (["modrinth", "curseforge", "local"] as const satisfies readonly ContentSource[])
      : (["modrinth", "curseforge"] as const satisfies readonly OnlineContentSource[]);
  const worldImportMode = contentType === "world" && source === "local";
  const contentNavigationBusy =
    loading ||
    batchUpdating ||
    importingWorld ||
    Boolean(installingProjectId) ||
    Boolean(uninstallingProjectId);
  const searchPlaceholder = worldImportMode
    ? t("content.worldSearchUnavailable")
    : contentType === "world"
      ? t("content.worldSearchPlaceholder")
      : t("content.searchPlaceholder");

  const contentTypeLabel = (value: ContentProjectType) => {
    if (value === "resourcepack") return t("content.type.resourcepack");
    if (value === "shader") return t("content.type.shader");
    if (value === "world") return t("content.type.world");
    return t("content.type.mod");
  };

  const contentSourceLabel = (value: ContentSource, tFn: ReturnType<typeof useI18n>["t"]) => {
    if (value === "modrinth") return tFn("content.source.modrinth");
    if (value === "curseforge") return tFn("content.source.curseforge");
    return tFn("content.source.local");
  };

  const installedMap = useMemo(() => {
    const map = new Map<string, InstalledContentItem>();
    for (const item of installedItems) {
      map.set(`${item.source}:${item.contentType}:${item.projectId}`, item);
    }
    return map;
  }, [installedItems]);

  const updateMap = useMemo(() => {
    const map = new Map<string, InstalledContentUpdate>();
    for (const item of installedUpdates) {
      map.set(`${item.source}:${item.contentType}:${item.projectId}`, item);
    }
    return map;
  }, [installedUpdates]);

  const filteredInstalledItems = useMemo(
    () => installedItems.filter((item) => item.contentType === contentType),
    [installedItems, contentType]
  );

  const filteredAvailableUpdateCount = useMemo(
    () =>
      filteredInstalledItems.filter(
        (item) =>
          updateMap.get(`${item.source}:${item.contentType}:${item.projectId}`)?.status ===
          "update-available"
      ).length,
    [filteredInstalledItems, updateMap]
  );

  const filteredUpdatableItems = useMemo(
    () =>
      filteredInstalledItems.filter(
        (item) =>
          updateMap.get(`${item.source}:${item.contentType}:${item.projectId}`)?.status ===
          "update-available"
      ),
    [filteredInstalledItems, updateMap]
  );

  async function fetchProjects(queryValue: string): Promise<ModrinthSearchResult[]> {
    if (!currentInstance) {
      return [];
    }

    if (source === "modrinth") {
      return invoke<ModrinthSearchResult[]>("modrinth_search_projects", {
        query: queryValue,
        projectType: contentType,
        gameVersion: currentInstance.baseVersion,
        loader: currentInstance.loader
      });
    }

    if (source === "curseforge") {
      return invoke<ModrinthSearchResult[]>("curseforge_search_projects", {
        query: queryValue,
        projectType: contentType,
        gameVersion: currentInstance.baseVersion,
        loader: currentInstance.loader,
        apiKey: curseforgeApiKey
      });
    }

    return [];
  }

  async function loadTrendingProjects() {
    if (!currentInstance || worldImportMode) {
      return;
    }

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
      const errorText = normalizeError(invokeError);
      setError(errorText);
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
      // Ignore errors
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function searchProjects() {
    if (!currentInstance) {
      return;
    }

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
      const errorText = normalizeError(invokeError);
      setError(errorText);
    } finally {
      setLoading(false);
    }
  }

  async function installProject(params: {
    source: OnlineContentSource;
    projectId: string;
    projectType: string;
    title: string;
  }): Promise<boolean> {
    if (!currentInstance) {
      setError(t("content.noInstance"));
      return false;
    }

    const projectKey = `${params.source}:${params.projectType}:${params.projectId}`;
    setInstallingProjectId(projectKey);
    setContentInstallProgress({
      projectKey,
      downloadedBytes: 0,
      totalBytes: null,
      percent: null
    });
    setError(null);
    onStatusChange(t("content.installing", { title: params.title }));

    try {
      const command =
        params.source === "curseforge" ? "install_curseforge_project" : "install_modrinth_project";
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

  async function uninstallProject(item: InstalledContentItem) {
    if (!currentInstance) {
      setError(t("content.noInstance"));
      return;
    }

    setUninstallingProjectId(`${item.source}:${item.contentType}:${item.projectId}`);
    setError(null);
    onStatusChange(t("content.uninstalling", { title: item.projectTitle }));
    try {
      await invoke<InstalledContentItem>("uninstall_installed_content", {
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
    if (!currentInstance || filteredUpdatableItems.length === 0) {
      return;
    }

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
        if (!success) {
          return;
        }
      }
      onStatusChange(t("content.updateAllDone", { count: filteredUpdatableItems.length }));
    } finally {
      setBatchUpdating(false);
    }
  }

  async function handleWorldImport(event: ChangeEvent<HTMLInputElement>) {
    if (!currentInstance) {
      setError(t("content.noInstance"));
      return;
    }

    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError(t("content.worldZipRequired"));
      return;
    }

    setImportingWorld(true);
    setError(null);
    onStatusChange(t("content.importingWorld"));
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const result = await invoke<WorldInstallResult>("import_world_archive", {
        gameDir,
        versionId: currentInstance.versionId,
        archiveName: file.name,
        archiveData: bytes
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
    setHasSearched(false);
    setRightTab("search");
  }, [currentInstance?.id, currentInstance?.versionId, contentType, source]);

  useEffect(() => {
    void refreshInstalledState(currentInstance);
  }, [currentInstance]);

  useEffect(() => {
    if (!currentInstance || worldImportMode || query.trim()) {
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
      if (cancelled) return;
      setContentInstallProgress(event.payload);
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

  const loaderLabel = (loader: Instance["loader"], tFn: ReturnType<typeof useI18n>["t"]): string => {
    if (loader === "forge") return tFn("loader.forge");
    if (loader === "fabric") return tFn("loader.fabric");
    return tFn("loader.vanilla");
  };

  function normalizeError(error: unknown): string {
    const raw = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
    const normalized = raw.trim();
    const currentVersion = currentInstance?.baseVersion?.trim();
    const currentLoader = currentInstance ? loaderLabel(currentInstance.loader, t) : null;

    if (/CurseForge download URL lookup failed with HTTP 403/i.test(normalized)) {
      return t("content.error.curseforgeDistributionBlocked");
    }

    if (/No compatible CurseForge file found for the current instance/i.test(normalized)) {
      if (currentVersion && currentLoader) {
        return t("content.error.curseforgeNoCompatibleFileDetailed", {
          version: currentVersion,
          loader: currentLoader
        });
      }
      return t("content.error.curseforgeNoCompatibleFile");
    }

    if (/CurseForge file does not expose a usable download URL/i.test(normalized)) {
      return t("content.error.curseforgeNoDownloadUrl");
    }

    if (/CurseForge project id cannot be empty/i.test(normalized)) {
      return t("content.error.curseforgeMissingProjectId");
    }

    return normalized;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Compact Header with Content Types */}
      <header className="flex shrink-0 flex-col border-b border-white/5 bg-[var(--bg-secondary)]/50">
        {/* Top Row: Title and Instance Selector */}
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">{t("content.title")}</h1>
            {currentInstance && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                <span className="rounded-full border border-[rgba(255,255,255,0.08)] bg-[var(--bg-elevated)] px-2.5 py-1">
                  {currentInstance.baseVersion}
                </span>
                <span className="rounded-full border border-[rgba(255,255,255,0.08)] bg-[var(--bg-elevated)] px-2.5 py-1">
                  {loaderLabel(currentInstance.loader, t)}
                </span>
              </div>
            )}
          </div>

          {/* Instance Selector */}
          <div className="flex w-full max-w-[300px] shrink-0 flex-col gap-1.5">
            <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              {t("content.selectInstance")}
            </span>
            <Select value={currentInstance?.id ?? ""} onValueChange={onSelectInstance}>
              <Select.Trigger className="h-12 w-full rounded-2xl border-[rgba(255,255,255,0.08)] bg-[rgba(18,22,28,0.9)] px-4 text-sm shadow-[0_12px_28px_rgba(0,0,0,0.18)]">
                {currentInstance ? (
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--surface-soft)] text-xs font-semibold text-[var(--text-primary)]">
                      {currentInstanceIcon ? (
                        <img
                          src={currentInstanceIcon}
                          alt={currentInstance.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span>{currentInstance.name.slice(0, 1).toUpperCase()}</span>
                      )}
                    </span>
                    <span className="truncate">{currentInstance.name}</span>
                  </span>
                ) : (
                  <Select.Value placeholder={t("content.selectInstance")} className="truncate block max-w-full" />
                )}
              </Select.Trigger>
              <Select.Content>
                {instances.map((instance) => {
                  const instanceIcon = resolveInstanceIconPath(instance);
                  return (
                  <Select.Item key={instance.id} value={instance.id}>
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--surface-soft)] text-xs font-semibold text-[var(--text-primary)]">
                        {instanceIcon ? (
                          <img
                            src={instanceIcon}
                            alt={instance.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span>{instance.name.slice(0, 1).toUpperCase()}</span>
                        )}
                      </span>
                      <span className="truncate">{instance.name}</span>
                    </span>
                  </Select.Item>
                  );
                })}
              </Select.Content>
            </Select>
          </div>
        </div>

        {/* Bottom Row: Content Types and Source Selection */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 px-5 py-3">
          {/* Content Types */}
          <div className="flex flex-wrap items-center gap-1 rounded-3xl border border-white/5 bg-[var(--surface-soft)]/80 p-1.5">
            {CONTENT_TYPES.map((item) => {
              const isActive = contentType === item.id;
              const count = installedItems.filter(i => i.contentType === item.id).length;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={contentNavigationBusy}
                  onClick={() => {
                    setContentType(item.id);
                    setRightTab("search");
                  }}
                  className={`flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition-colors ${
                    isActive
                      ? "bg-[var(--mc-grass)] text-white shadow-[0_10px_24px_rgba(37,184,122,0.22)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                  title={contentTypeLabel(item.id)}
                >
                  <span className={isActive ? "text-white" : "text-[var(--mc-grass)]"}>{item.icon}</span>
                  <span className="hidden sm:inline">{contentTypeLabel(item.id)}</span>
                  {count > 0 && (
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${isActive ? "bg-white/20 text-white" : "bg-[var(--bg-elevated)] text-[var(--text-muted)]"}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Source Selection with Icons */}
          <div className="flex items-center gap-2">
            {availableSources.map((item) => {
              const isActive = source === item;
              const iconSrc = item === "modrinth" ? modrinthIcon : item === "curseforge" ? curseforgeIcon : null;
              return (
                <button
                  key={item}
                  type="button"
                  disabled={contentNavigationBusy}
                  onClick={() => setSource(item)}
                  className={`group relative flex h-11 w-11 items-center justify-center rounded-2xl border transition-colors ${
                    isActive
                      ? "border-[#25b87a]/40 bg-[#25b87a]/10 text-[var(--text-primary)] shadow-[0_10px_24px_rgba(37,184,122,0.12)]"
                      : "border-white/5 text-[var(--text-secondary)] hover:border-white/10"
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                  aria-label={contentSourceLabel(item, t)}
                  title={contentSourceLabel(item, t)}
                >
                  {iconSrc ? (
                    <img src={iconSrc} alt={item} className="h-4 w-4" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {/* Right Content Area - Full Width */}
        <main className="flex-1 overflow-y-auto bg-[var(--bg-primary)]">
          <div className="p-5">
            {/* Warning Messages */}
            {error && (
              <div className="mb-5 rounded-2xl bg-[var(--accent-danger)]/10 border border-[var(--accent-danger)]/5 p-3.5">
                <div className="flex items-start gap-3">
                  <X size={16} className="mt-0.5 text-[var(--accent-danger)] shrink-0" />
                  <p className="text-sm text-[var(--accent-danger)]">{error}</p>
                </div>
              </div>
            )}

            {/* Tab Navigation */}
            <div className="mb-5 flex flex-wrap items-center gap-2.5 border-b border-white/5 pb-2.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRightTab("search")}
                  className={`flex items-center gap-2 rounded-2xl px-3 py-1.5 text-sm font-medium transition-colors ${
                    rightTab === "search"
                      ? "bg-[var(--mc-grass)] text-white shadow-[0_8px_18px_rgba(37,184,122,0.14)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-soft)]"
                  }`}
                >
                  <Search size={14} />
                  {t("content.search")}
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab("installed")}
                  className={`flex items-center gap-2 rounded-2xl px-3 py-1.5 text-sm font-medium transition-colors ${
                    rightTab === "installed"
                      ? "bg-[var(--mc-grass)] text-white shadow-[0_8px_18px_rgba(37,184,122,0.14)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-soft)]"
                  }`}
                >
                  <List size={14} />
                  {t("content.installed")}
                  {filteredInstalledItems.length > 0 && (
                    <span className={`rounded-full px-1.5 py-0.5 text-xs ${
                      rightTab === "installed" ? "bg-white/20 text-white" : "bg-[var(--bg-elevated)] text-[var(--text-muted)]"
                    }`}>
                      {filteredInstalledItems.length}
                    </span>
                  )}
                </button>
              </div>

              {!worldImportMode ? (
                <div className="ml-auto flex min-w-[280px] flex-1 items-stretch justify-end gap-2">
                  <label className="relative flex h-10 w-full max-w-[420px]">
                    <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
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
                      className="h-full w-full rounded-2xl border border-white/10 bg-[var(--bg-secondary)] py-0 pl-9 pr-4 text-sm text-[var(--text-primary)] transition-colors focus:border-[var(--mc-grass)]/45 focus:outline-none"
                    />
                  </label>
                  <Button
                    variant="primary"
                    size="sm"
                    className="h-10 min-w-[46px] shrink-0 self-stretch rounded-2xl px-0"
                    disabled={loading || busy || !currentInstance}
                    title={loading ? t("content.searching") : t("content.search")}
                    onClick={() => {
                      void searchProjects();
                      setRightTab("search");
                    }}
                  >
                    <Search size={15} />
                  </Button>
                </div>
              ) : (
                <div className="ml-auto">
                  <input
                    ref={worldFileInputRef}
                    type="file"
                    accept=".zip,application/zip"
                    className="hidden"
                    onChange={(event) => void handleWorldImport(event)}
                  />
                  <Button
                    variant="primary"
                    size="md"
                    className="h-11 rounded-2xl gap-2"
                    disabled={busy || importingWorld || !currentInstance}
                    onClick={() => worldFileInputRef.current?.click()}
                  >
                    <Download size={16} />
                    {importingWorld ? t("content.importingWorld") : t("content.selectZipFile")}
                  </Button>
                </div>
              )}

              {filteredAvailableUpdateCount > 0 && (
                <button
                  type="button"
                  disabled={busy || batchUpdating || checkingUpdates}
                  onClick={() => void updateAllProjects()}
                  className="flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-sm font-medium text-amber-200 hover:bg-amber-500/10 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Download size={14} />
                  <span>{t("content.updates")}</span>
                  <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-xs font-semibold text-amber-400">
                    {filteredAvailableUpdateCount}
                  </span>
                </button>
              )}
            </div>

            {/* Tab Content */}
            {rightTab === "search" ? (
              <div>
                {!hasSearched || loading ? (
                  <Card variant="frost" className="rounded-2xl p-10 text-center" interactive={false}>
                    <Sparkles size={40} className="mx-auto mb-4 text-[var(--text-muted)]" />
                    <p className="text-base text-[var(--text-muted)]">
                      {loading && !query.trim() ? t("content.loadingTrending") : t("content.searchHint")}
                    </p>
                  </Card>
                ) : error ? (
                  <Card variant="frost" className="rounded-2xl p-10 text-center" interactive={false}>
                    <X size={40} className="mx-auto mb-4 text-[var(--accent-danger)]" />
                    <p className="text-base text-[var(--accent-danger)]">{error}</p>
                  </Card>
                ) : results.length === 0 ? (
                  <Card variant="frost" className="rounded-2xl p-10 text-center" interactive={false}>
                    <Search size={40} className="mx-auto mb-4 text-[var(--text-muted)]" />
                    <p className="text-base text-[var(--text-muted)]">{t("content.noResults")}</p>
                  </Card>
                ) : (
                  <div className="grid grid-cols-1 gap-3">
                    {results.map((item) => {
                      const installedItem = installedMap.get(`${item.source}:${item.projectType}:${item.projectId}`);
                      const updateState = updateMap.get(`${item.source}:${item.projectType}:${item.projectId}`);
                      const canUpdate = updateState?.status === "update-available";
                      const isInstalled = Boolean(installedItem);
                      const itemKey = `${item.source}:${item.projectType}:${item.projectId}`;
                      const actionBusy = busy || installingProjectId === itemKey;
                      const installProgress =
                        contentInstallProgress?.projectKey === itemKey ? contentInstallProgress : null;

                      return (
                        <Card
                          key={itemKey}
                          variant="frost"
                          className={`group rounded-2xl p-4 transition-all hover:border-white/10 ${isInstalled ? "border-[#25b87a]/30" : ""}`}
                          interactive={false}
                        >
                          <div className="flex gap-3">
                            <img
                              src={item.iconUrl || "https://placeholder.com/48x48"}
                              alt={item.title}
                              className="h-14 w-14 shrink-0 rounded-lg bg-[var(--bg-elevated)] object-cover"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-[var(--text-primary)]">{item.title}</p>
                              <p className="text-xs text-[var(--text-muted)]">{item.author}</p>
                              <p className="mt-1 line-clamp-2 text-xs text-[var(--text-secondary)]">{item.description}</p>
                            </div>
                            <Button
                                variant={isInstalled && !canUpdate ? "outline" : "minecraft-success"}
                                size="sm"
                                className="h-11 w-11 rounded-2xl px-0 shadow-none"
                                disabled={actionBusy}
                                launchProgress={Boolean(installProgress)}
                                launchProgressPercent={installProgress?.percent ?? null}
                                title={
                                  isInstalled && canUpdate
                                    ? t("content.update")
                                    : isInstalled
                                      ? t("content.reinstall")
                                      : t("content.install")
                                }
                                onClick={() =>
                                  void installProject({
                                    source: item.source as OnlineContentSource,
                                    projectId: item.projectId,
                                    projectType: item.projectType,
                                    title: item.title
                                  })
                                }
                              >
                                {installingProjectId === itemKey
                                  ? installProgress?.percent != null
                                    ? `${installProgress.percent}%`
                                    : <Download size={15} />
                                  : <Download size={15} />}
                              </Button>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div>
                {filteredInstalledItems.length > 0 ? (
                  <div className="grid grid-cols-1 gap-2">
                    {filteredInstalledItems.map((item) => {
                      const updateState = updateMap.get(`${item.source}:${item.contentType}:${item.projectId}`);
                      const canUpdate = updateState?.status === "update-available";
                      const supportsOnlineUpdate = item.source !== "local";
                      const itemKey = `${item.source}:${item.contentType}:${item.projectId}`;
                      const isItemBusy = installingProjectId === itemKey || uninstallingProjectId === itemKey;
                      const installProgress =
                        contentInstallProgress?.projectKey === itemKey ? contentInstallProgress : null;

                      return (
                        <div
                          key={itemKey}
                          className={`group flex items-center gap-3 rounded-2xl border px-4 py-3.5 transition-colors ${
                            canUpdate
                              ? "border-amber-500/30 bg-amber-500/5"
                              : "border-white/5 bg-[var(--surface-soft)] hover:border-white/10"
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium text-[var(--text-primary)]">{item.projectTitle}</p>
                              {canUpdate && (
                                <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
                                  {t("content.update")}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-xs text-[var(--text-muted)]">
                              <span>{item.versionNumber}</span>
                              {canUpdate && updateState?.latestVersionNumber && (
                                <>
                                  <ChevronRight size={12} className="text-amber-400" />
                                  <span className="text-amber-400">{updateState.latestVersionNumber}</span>
                                </>
                              )}
                              <span>·</span>
                              <span>{contentSourceLabel(item.source, t)}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {supportsOnlineUpdate && (
                              <Button
                                variant="secondary"
                                size="sm"
                                className="h-10 w-10 rounded-2xl px-0"
                                disabled={isItemBusy}
                                launchProgress={Boolean(installProgress)}
                                launchProgressPercent={installProgress?.percent ?? null}
                                onClick={() =>
                                  void installProject({
                                    source: item.source as OnlineContentSource,
                                    projectId: item.projectId,
                                    projectType: item.contentType,
                                    title: item.projectTitle
                                  })
                                }
                              >
                                {installProgress?.percent != null ? `${installProgress.percent}%` : <Download size={12} />}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-10 w-10 rounded-2xl px-0 text-[var(--text-muted)] hover:text-[var(--accent-danger)]"
                              disabled={isItemBusy}
                              onClick={() => void uninstallProject(item)}
                            >
                              <Trash2 size={12} />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <Card variant="frost" className="rounded-2xl p-10 text-center" interactive={false}>
                    <Archive size={40} className="mx-auto mb-4 text-[var(--text-muted)]" />
                    <p className="text-base text-[var(--text-muted)]">{t("content.installedEmpty")}</p>
                  </Card>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
