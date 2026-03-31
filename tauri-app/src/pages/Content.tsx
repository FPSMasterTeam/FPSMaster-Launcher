import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Archive, Box, Download, File, Globe, HardDriveDownload, PackageCheck, Palette, Search, Sparkles, Trash2, X } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import Select from "../components/Select";
import modrinthIcon from "../assets/icons/modrinth.ico";
import curseforgeIcon from "../assets/icons/curseforge.ico";
import { useI18n } from "../i18n";
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
import { resolveInstanceIconPath } from "../utils/launcher";

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

function contentTypeLabel(value: ContentProjectType, t: ReturnType<typeof useI18n>["t"]): string {
  if (value === "resourcepack") return t("content.type.resourcepack");
  if (value === "shader") return t("content.type.shader");
  if (value === "world") return t("content.type.world");
  return t("content.type.mod");
}

function contentSourceLabel(value: ContentSource, t: ReturnType<typeof useI18n>["t"]): string {
  if (value === "modrinth") return t("content.source.modrinth");
  if (value === "curseforge") return t("content.source.curseforge");
  return t("content.source.local");
}

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

  async function fetchProjects(queryValue: string): Promise<ModrinthSearchResult[]> {
    if (!currentInstance) return [];
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
    if (!currentInstance || worldImportMode) return;
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
    if (!currentInstance) return;
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

  async function handleWorldImport(event: ChangeEvent<HTMLInputElement>) {
    if (!currentInstance) {
      setError(t("content.noInstance"));
      return;
    }
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
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
    return normalized;
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
          <Card variant="frost" className="page-card rounded-[22px]" interactive={false}>
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
          <Card variant="frost" className="page-card page-card-compact mb-4 rounded-[22px]" interactive={false}>
            <div className="content-topbar-card">
              <div className="content-topbar-instance">
                <Select value={currentInstance?.id ?? ""} onValueChange={onSelectInstance}>
                  <Select.Trigger unstyled className="content-topbar-select" aria-label={t("content.selectInstance")}>
                    {currentInstance ? (
                      <span className="content-topbar-select-value">
                        <span className="content-instance-icon">
                          {currentInstanceIcon ? <img src={currentInstanceIcon} alt={currentInstance.name} className="h-full w-full object-contain p-[1px]" /> : <span>{currentInstance.name.slice(0, 1).toUpperCase()}</span>}
                        </span>
                        <span className="truncate">{currentInstance.name}</span>
                      </span>
                    ) : (
                      <Select.Value placeholder={t("content.selectInstance")} />
                    )}
                  </Select.Trigger>
                  <Select.Content>
                    {instances.map((instance) => {
                      const instanceIcon = resolveInstanceIconPath(instance);
                      return (
                        <Select.Item key={instance.id} value={instance.id}>
                          <span className="flex min-w-0 items-center gap-3">
                            <span className="content-instance-icon">
                              {instanceIcon ? <img src={instanceIcon} alt={instance.name} className="h-full w-full object-contain p-[1px]" /> : <span>{instance.name.slice(0, 1).toUpperCase()}</span>}
                            </span>
                            <span className="truncate">{instance.name}</span>
                          </span>
                        </Select.Item>
                      );
                    })}
                  </Select.Content>
                </Select>
              </div>

              {!worldImportMode ? (
                <div className="content-topbar-search">
                  <label className="search-field">
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
                      className="ui-input"
                    />
                  </label>
                </div>
              ) : (
                <div className="content-topbar-search">
                  <p className="section-subtitle !mt-0">{t("content.selectZipFile")}</p>
                </div>
              )}
            </div>
          </Card>

          <input ref={worldFileInputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => void handleWorldImport(event)} />

          {(worldImportMode || filteredUpdatableItems.length > 0) && (
            <div className="mb-5 flex flex-wrap justify-end gap-2">
              {worldImportMode && (
                <Button variant="primary" size="md" className="!rounded-2xl gap-2" disabled={busy || importingWorld || !currentInstance} onClick={() => worldFileInputRef.current?.click()}>
                  <Download size={16} />
                  {importingWorld ? t("content.importingWorld") : t("content.selectZipFile")}
                </Button>
              )}

              {filteredUpdatableItems.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="!rounded-2xl gap-2 border-amber-500/25 bg-amber-500/8 text-amber-200 hover:bg-amber-500/12"
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

          {rightTab === "search" ? (
            !hasSearched || loading ? (
              <div className="empty-state">
                <Sparkles size={40} className="empty-state-icon" />
                <p className="empty-state-title">{loading && !query.trim() ? t("content.loadingTrending") : t("content.searchResults")}</p>
                <p className="empty-state-text">{loading && !query.trim() ? t("content.loadingTrending") : t("content.searchHint")}</p>
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
                  const actionBusy = busy || installingProjectId === itemKey;
                  const installProgress = contentInstallProgress?.projectKey === itemKey ? contentInstallProgress : null;
                  return (
                    <Card key={itemKey} variant="frost" className={`page-card page-card-compact rounded-[20px] ${isInstalled ? "border-[rgba(var(--accent-rgb),0.28)]" : ""}`} interactive={false}>
                      <div className="flex gap-4">
                        <div className="icon-tile h-14 w-14 rounded-[18px]">
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
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center">
                          <Button
                            variant={isInstalled && !canUpdate ? "outline" : "primary"}
                            size="sm"
                            className="content-download-button !rounded-2xl gap-2"
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
            <div className="surface-list">
              {filteredInstalledItems.map((item) => {
                const updateState = updateMap.get(`${item.source}:${item.contentType}:${item.projectId}`);
                const canUpdate = updateState?.status === "update-available";
                const supportsOnlineUpdate = item.source !== "local";
                const itemKey = `${item.source}:${item.contentType}:${item.projectId}`;
                const isItemBusy = installingProjectId === itemKey || uninstallingProjectId === itemKey;
                const installProgress = contentInstallProgress?.projectKey === itemKey ? contentInstallProgress : null;
                return (
                  <div key={itemKey} className={`surface-list-item ${canUpdate ? "is-warning" : ""}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{item.projectTitle}</p>
                        {canUpdate && <span className="badge badge-warning normal-case tracking-normal">{t("content.update")}</span>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                        <span>{item.versionNumber}</span>
                        {canUpdate && updateState?.latestVersionNumber && <span className="badge badge-warning normal-case tracking-normal">{updateState.latestVersionNumber}</span>}
                        <span className="badge badge-muted normal-case tracking-normal">{contentSourceLabel(item.source, t)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {supportsOnlineUpdate && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="content-download-button !rounded-2xl gap-2"
                          disabled={isItemBusy}
                          launchProgress={Boolean(installProgress)}
                          launchProgressPercent={installProgress?.percent ?? null}
                          onClick={() => void installProject({ source: item.source as OnlineContentSource, projectId: item.projectId, projectType: item.contentType, title: item.projectTitle })}
                        >
                          <Download size={12} />
                          {installProgress ? `${installProgress.percent ?? 0}%` : t("content.update")}
                        </Button>
                      )}
                      <button type="button" className="icon-button icon-button-danger" disabled={isItemBusy} onClick={() => void uninstallProject(item)} aria-label={t("content.uninstall")} title={t("content.uninstall")}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <Archive size={40} className="empty-state-icon" />
              <p className="empty-state-title">{t("content.installed")}</p>
              <p className="empty-state-text">{t("content.installedEmpty")}</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
