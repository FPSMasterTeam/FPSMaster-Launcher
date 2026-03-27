import { invoke } from "@tauri-apps/api/core";
import { Download, Layers3, Search, Sparkles, Trash2 } from "lucide-react";
import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type {
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

type ContentPageProps = {
  instances: Instance[];
  current: Instance | null;
  gameDir: string;
  curseforgeApiKey: string;
  busy: boolean;
  onSelectInstance: (id: string) => void;
  onStatusChange: (message: string) => void;
};

const CONTENT_TYPES: readonly ContentProjectType[] = ["mod", "resourcepack", "shader", "world"];

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
  const [results, setResults] = useState<ModrinthSearchResult[]>([]);
  const [installedItems, setInstalledItems] = useState<InstalledContentItem[]>([]);
  const [installedUpdates, setInstalledUpdates] = useState<InstalledContentUpdate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastInstallResult, setLastInstallResult] = useState<ModrinthInstallResult | null>(null);
  const worldFileInputRef = useRef<HTMLInputElement | null>(null);

  const currentInstance = current ?? instances[0] ?? null;
  const availableSources =
    contentType === "world"
      ? (["modrinth", "curseforge", "local"] as const satisfies readonly ContentSource[])
      : (["modrinth", "curseforge"] as const satisfies readonly OnlineContentSource[]);
  const worldImportMode = contentType === "world" && source === "local";
  const curseforgeNeedsKey = source === "curseforge" && !curseforgeApiKey.trim();
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
  const sourceNotice = worldImportMode
    ? t("content.localSourceNotice")
    : t("content.sourceNotice", { source: contentSourceLabel(source, t) });
  const contentTypeLabel = (value: ContentProjectType) => {
    if (value === "resourcepack") return t("content.type.resourcepack");
    if (value === "shader") return t("content.type.shader");
    if (value === "world") return t("content.type.world");
    return t("content.type.mod");
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
        setInstalledUpdates([]);
      } finally {
        setCheckingUpdates(false);
      }
    } catch {
      setInstalledItems([]);
      setInstalledUpdates([]);
      setCheckingUpdates(false);
    }
  }

  async function searchProjects() {
    if (!currentInstance) {
      setError(t("content.noInstance"));
      return;
    }
    if (worldImportMode || source === "local") {
      return;
    }
    if (curseforgeNeedsKey) {
      setError(t("content.curseforgeKeyRequired"));
      return;
    }
    const trimmedQuery = query.trim();

    setLoading(true);
    setHasSearched(true);
    setError(null);
    setLastInstallResult(null);
    onStatusChange(trimmedQuery ? t("content.searching") : t("content.loadingTrending"));
    try {
      await refreshInstalledState(currentInstance);
      const items =
        source === "curseforge"
          ? await invoke<ModrinthSearchResult[]>("curseforge_search_projects", {
              query: trimmedQuery,
              projectType: contentType,
              gameVersion: currentInstance.baseVersion,
              loader: currentInstance.loader,
              limit: 18,
              apiKey: curseforgeApiKey
            })
          : await invoke<ModrinthSearchResult[]>("modrinth_search_projects", {
              query: trimmedQuery,
              projectType: contentType,
              gameVersion: currentInstance.baseVersion,
              loader: currentInstance.loader,
              limit: 18
            });
      setResults(items);
      onStatusChange(
        trimmedQuery
          ? t("content.searchDone", { count: items.length })
          : t("content.trendingLoaded", { count: items.length })
      );
    } catch (invokeError) {
      const errorText = normalizeError(invokeError);
      setError(errorText);
      onStatusChange(t("app.status.failed", { error: errorText }));
    } finally {
      setLoading(false);
    }
  }

  async function installProject(item: {
    source: OnlineContentSource;
    projectId: string;
    projectType: ContentProjectType;
    title: string;
  }): Promise<boolean> {
    if (!currentInstance) {
      setError(t("content.noInstance"));
      return false;
    }

    const itemKey = `${item.source}:${item.projectType}:${item.projectId}`;
    const existingItem = installedMap.get(itemKey);
    const updateState = updateMap.get(itemKey);
    setInstallingProjectId(itemKey);
    setError(null);
    onStatusChange(
      t(
        updateState?.status === "update-available"
          ? "content.updating"
          : existingItem
            ? "content.reinstalling"
            : "content.installing",
        { title: item.title }
      )
    );
    try {
      const result =
        item.source === "curseforge"
          ? await invoke<ModrinthInstallResult>("install_curseforge_project", {
              gameDir,
              versionId: currentInstance.versionId,
              projectId: item.projectId,
              projectTitle: item.title,
              projectType: item.projectType,
              gameVersion: currentInstance.baseVersion,
              loader: currentInstance.loader,
              apiKey: curseforgeApiKey
            })
          : await invoke<ModrinthInstallResult>("install_modrinth_project", {
              gameDir,
              versionId: currentInstance.versionId,
              projectId: item.projectId,
              projectTitle: item.title,
              projectType: item.projectType,
              gameVersion: currentInstance.baseVersion,
              loader: currentInstance.loader
            });
      setLastInstallResult(result);
      await refreshInstalledState(currentInstance);
      onStatusChange(
        t(
          updateState?.status === "update-available"
            ? "content.updateDone"
            : existingItem
              ? "content.reinstallDone"
              : "content.installDone",
          { title: item.title, file: result.fileName }
        )
      );
      return true;
    } catch (invokeError) {
      const errorText = normalizeError(invokeError);
      setError(errorText);
      onStatusChange(t("app.status.failed", { error: errorText }));
      return false;
    } finally {
      setInstallingProjectId(null);
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
      if (
        lastInstallResult?.projectId === item.projectId &&
        lastInstallResult?.source === item.source
      ) {
        setLastInstallResult(null);
      }
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
      setLastInstallResult({
        source: "local",
        projectId: result.projectId,
        projectTitle: result.projectTitle,
        contentType: result.contentType,
        versionId: `world-import-${result.installedAtEpochSec}`,
        versionNumber: t("content.importedVersionLabel"),
        fileName: result.fileName,
        targetDir: result.installedPath,
        installedPath: result.installedPath,
        changelog: null
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
    if (contentType !== "world" && source === "local") {
      setSource("modrinth");
    }
  }, [contentType, source]);

  useEffect(() => {
    void refreshInstalledState(currentInstance);
  }, [currentInstance?.id, currentInstance?.versionId, gameDir, curseforgeApiKey]);

  useEffect(() => {
    setResults([]);
    setError(null);
    setLastInstallResult(null);
    setHasSearched(false);
  }, [currentInstance?.id, currentInstance?.versionId, contentType, source]);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5 xl:p-6">
      <header className="mb-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
            {t("nav.content")}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
            {t("content.title")}
          </h1>
          <p className="mt-1 text-[var(--text-secondary)]">{t("content.subtitle")}</p>
        </div>

        <Card variant="frost" className="rounded-2xl p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <Layers3 size={16} className="text-[var(--mc-grass)]" />
            {t("content.currentInstance")}
          </div>
          <select
            value={currentInstance?.id ?? ""}
            onChange={(event) => onSelectInstance(event.target.value)}
            className="mt-3 w-full rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
          >
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name}
              </option>
            ))}
          </select>
          {currentInstance ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <MetaBadge>{currentInstance.baseVersion}</MetaBadge>
              <MetaBadge>{loaderLabel(currentInstance.loader, t)}</MetaBadge>
              {currentInstance.launcherVersionType && (
                <MetaBadge>{currentInstance.launcherVersionType}</MetaBadge>
              )}
            </div>
          ) : (
            <p className="mt-2 text-xs text-[var(--accent-danger)]">{t("content.noInstance")}</p>
          )}
        </Card>
      </header>

      <Card variant="frost" className="rounded-2xl p-4 md:p-5">
        <div className="mb-3 flex flex-wrap gap-2">
          {CONTENT_TYPES.map((item) => (
            <button
              key={item}
              type="button"
              disabled={contentNavigationBusy}
              onClick={() => setContentType(item)}
              className={`rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                contentType === item
                  ? "border-[var(--mc-grass)]/50 bg-[var(--mc-grass)]/12 text-[var(--text-primary)]"
                  : "border-[var(--border-medium)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
              } disabled:cursor-not-allowed disabled:opacity-55`}
            >
              {contentTypeLabel(item)}
            </button>
          ))}
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
            {t("content.sourceLabel")}
          </span>
          {availableSources.map((item) => (
            <button
              key={item}
              type="button"
              disabled={contentNavigationBusy}
              onClick={() => setSource(item)}
              className={`rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                source === item
                  ? "border-[var(--mc-grass)]/50 bg-[var(--mc-grass)]/12 text-[var(--text-primary)]"
                  : "border-[var(--border-medium)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
              } disabled:cursor-not-allowed disabled:opacity-55`}
            >
              {contentSourceLabel(item, t)}
            </button>
          ))}
        </div>
        {curseforgeNeedsKey && !worldImportMode && (
          <Card variant="soft" className="mb-4 rounded-2xl border border-amber-500/30 p-4">
            <p className="text-sm font-medium text-amber-200">{t("content.curseforgeKeyRequired")}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">{t("content.curseforgeKeyHint")}</p>
          </Card>
        )}

        {worldImportMode ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
            <div>
              <p className="text-sm text-[var(--text-secondary)]">{t("content.worldImportHint")}</p>
            </div>
            <div className="flex items-center gap-3">
              <input
                ref={worldFileInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(event) => void handleWorldImport(event)}
              />
              <Button
                variant="primary"
                size="lg"
                className="gap-2"
                disabled={busy || importingWorld || !currentInstance}
                onClick={() => worldFileInputRef.current?.click()}
              >
                <Download size={16} />
                {importingWorld ? t("content.importingWorld") : t("content.importWorld")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
            <div>
              <label className="relative block">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                />
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
                  className="w-full rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] py-3 pl-10 pr-3 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
                />
              </label>
            </div>

            <Button
              variant="primary"
              size="lg"
              className="gap-2"
              disabled={loading || busy || !currentInstance || curseforgeNeedsKey}
              onClick={() => void searchProjects()}
            >
              <Search size={16} />
              {loading ? t("content.searching") : t("content.search")}
            </Button>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2 py-1">
            {t("content.compatibility", {
              version: currentInstance?.baseVersion ?? "-",
              loader: currentInstance ? loaderLabel(currentInstance.loader, t) : "-"
            })}
          </span>
          <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2 py-1">
            {t("content.resultsCount", { count: results.length })}
          </span>
          <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2 py-1">
            {t("content.installedCount", { count: filteredInstalledItems.length })}
          </span>
          <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2 py-1">
            {t("content.updateCount", { count: filteredAvailableUpdateCount })}
          </span>
          {checkingUpdates && (
            <span className="rounded-md border border-cyan-500/35 bg-cyan-500/10 px-2 py-1 text-cyan-300">
              {t("content.checkingUpdates")}
            </span>
          )}
          <span>{sourceNotice}</span>
        </div>
      </Card>

      {lastInstallResult && (
        <Card variant="soft" className="mt-4 rounded-2xl border border-[var(--mc-grass)]/25 p-4">
          <div className="flex items-start gap-3">
            <Sparkles size={18} className="mt-0.5 text-[var(--mc-grass)]" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                {t("content.lastInstallTitle", { title: lastInstallResult.projectTitle })}
              </p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {lastInstallResult.versionNumber}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <MetaBadge>{contentSourceLabel(lastInstallResult.source, t)}</MetaBadge>
                <MetaBadge>{contentTypeLabel(lastInstallResult.contentType)}</MetaBadge>
              </div>
              {lastInstallResult.changelog && (
                <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--text-secondary)]">
                  {lastInstallResult.changelog.replace(/\s+/g, " ").trim()}
                </p>
              )}
            </div>
          </div>
        </Card>
      )}

      {error && (
        <Card variant="soft" className="mt-4 rounded-2xl border border-[var(--accent-danger)]/35 p-4">
          <p className="text-sm text-[var(--accent-danger)]">{error}</p>
        </Card>
      )}

      {currentInstance && (
        <Card variant="frost" className="mt-4 rounded-2xl p-4 md:p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">
                {t("content.installedSectionTitle")}
              </h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {contentTypeLabel(contentType)} · {filteredInstalledItems.length}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {checkingUpdates && (
                <span className="text-xs text-[var(--text-muted)]">{t("content.checkingUpdates")}</span>
              )}
              {filteredAvailableUpdateCount > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-2"
                  disabled={busy || batchUpdating || checkingUpdates}
                  onClick={() => void updateAllProjects()}
                >
                  <Download size={14} />
                  {batchUpdating ? t("content.updatingButton") : t("content.updateAll")}
                </Button>
              )}
            </div>
          </div>

          {filteredInstalledItems.length > 0 ? (
            <div className="mt-4 space-y-3">
              {filteredInstalledItems.map((item) => {
                const updateState = updateMap.get(`${item.source}:${item.contentType}:${item.projectId}`);
                const canUpdate = updateState?.status === "update-available";
                const supportsOnlineUpdate = item.source !== "local";
                const itemKey = `${item.source}:${item.contentType}:${item.projectId}`;
                return (
                  <div
                    key={`${item.source}:${item.contentType}:${item.projectId}`}
                    className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-soft)] p-4"
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
                          {item.projectTitle}
                        </p>
                        <p className="mt-1 text-xs text-[var(--text-secondary)]">
                          {t("content.installedVersion", { version: item.versionNumber })}
                        </p>
                        {updateState?.latestVersionNumber && canUpdate && (
                          <p className="mt-1 text-xs text-[var(--text-muted)]">
                            {t("content.latestVersion", {
                              version: updateState.latestVersionNumber
                            })}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <MetaBadge>{contentTypeLabel(item.contentType)}</MetaBadge>
                          <MetaBadge>{contentSourceLabel(item.source, t)}</MetaBadge>
                          {renderUpdateStateBadge(updateState, t)}
                        </div>
                      </div>

                      <div className={`grid gap-2 ${supportsOnlineUpdate ? "grid-cols-2 md:min-w-[236px]" : "grid-cols-1 md:min-w-[120px]"}`}>
                        {supportsOnlineUpdate && (
                          <Button
                            variant={canUpdate ? "secondary" : "outline"}
                            size="sm"
                            className="gap-2"
                            disabled={
                              busy ||
                              batchUpdating ||
                              importingWorld ||
                              installingProjectId === itemKey ||
                              uninstallingProjectId === itemKey
                            }
                            onClick={() =>
                              void installProject({
                                source: item.source as OnlineContentSource,
                                projectId: item.projectId,
                                projectType: item.contentType,
                                title: item.projectTitle
                              })
                            }
                          >
                            <Download size={14} />
                            {installingProjectId === itemKey
                              ? canUpdate
                                ? t("content.updatingButton")
                                : t("content.installingButton")
                              : canUpdate
                                ? t("content.update")
                                : t("content.reinstall")}
                          </Button>
                        )}
                        <Button
                          variant="danger"
                          size="sm"
                          className="gap-2"
                          disabled={
                            busy ||
                            batchUpdating ||
                            importingWorld ||
                            installingProjectId === itemKey ||
                            uninstallingProjectId === itemKey
                          }
                          onClick={() => void uninstallProject(item)}
                        >
                          <Trash2 size={14} />
                          {uninstallingProjectId === itemKey
                            ? t("content.uninstallingButton")
                            : t("content.uninstall")}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 text-sm text-[var(--text-secondary)]">{t("content.installedEmpty")}</p>
          )}
        </Card>
      )}

      {worldImportMode ? (
        <section className="mt-5 pb-20">
          <Card variant="soft" className="rounded-2xl border border-dashed p-5">
            <p className="text-sm text-[var(--text-secondary)]">{t("content.worldImportEmpty")}</p>
            <p className="mt-2 text-xs text-[var(--text-muted)]">{t("content.worldImportHint")}</p>
          </Card>
        </section>
      ) : (
        <section className="mt-5 grid grid-cols-1 gap-4 pb-20 md:grid-cols-2 xl:grid-cols-3">
          {results.map((item) => {
          const installedItem = installedMap.get(`${item.source}:${item.projectType}:${item.projectId}`);
          const updateState = updateMap.get(`${item.source}:${item.projectType}:${item.projectId}`);
          const canUpdate = updateState?.status === "update-available";
          const isInstalled = Boolean(installedItem);
          const itemKey = `${item.source}:${item.projectType}:${item.projectId}`;
          const actionBusy =
            busy ||
            batchUpdating ||
            importingWorld ||
            !currentInstance ||
            installingProjectId === itemKey ||
            uninstallingProjectId === itemKey;
          return (
            <Card key={item.projectId} as="article" variant="frost" className="flex min-h-[280px] flex-col rounded-2xl p-4">
              <div className="flex items-start gap-3">
                <div className="h-12 w-12 overflow-hidden rounded-xl border border-[var(--border-medium)] bg-[var(--bg-elevated)]">
                  {item.iconUrl ? (
                    <img src={item.iconUrl} alt={item.title} className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-base font-semibold text-[var(--text-primary)]">
                        {item.title}
                      </h3>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">{item.author}</p>
                    </div>
                    <span className="shrink-0 rounded-md border border-[var(--border-medium)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                      {contentSourceLabel(item.source, t)}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {isInstalled && (
                      <span className="rounded-md border border-[var(--mc-grass)]/35 bg-[var(--mc-grass)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--mc-grass)]">
                        {t("content.installedBadge")}
                      </span>
                    )}
                    {renderUpdateStateBadge(updateState, t)}
                    {(item.displayCategories.length > 0 ? item.displayCategories : item.categories)
                      .slice(0, 4)
                      .map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md border border-[var(--border-medium)] bg-[var(--surface-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]"
                        >
                          {tag}
                        </span>
                      ))}
                  </div>
                </div>
              </div>

              <p className="mt-3 line-clamp-4 text-sm leading-6 text-[var(--text-secondary)]">
                {item.description || t("content.noDescription")}
              </p>

              <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-[var(--text-muted)]">
                <InfoPill label={t("content.downloads")} value={item.downloads.toLocaleString()} />
                <InfoPill
                  label={t("content.latestGameVersion")}
                  value={item.latestGameVersion ?? currentInstance?.baseVersion ?? "-"}
                />
              </div>
              {installedItem && (
                <div className="mt-3 space-y-1">
                  <p className="line-clamp-2 text-xs leading-5 text-[var(--text-muted)]">
                    {t("content.installedVersion", {
                      version: installedItem.versionNumber ?? "-"
                    })}
                  </p>
                  {updateState?.latestVersionNumber && canUpdate && (
                    <p className="line-clamp-2 text-xs leading-5 text-[var(--text-muted)]">
                      {t("content.latestVersion", {
                        version: updateState.latestVersionNumber
                      })}
                    </p>
                  )}
                </div>
              )}

              <div className="mt-auto pt-4">
                {installedItem ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="gap-2"
                      disabled={actionBusy}
                      onClick={() => void installProject(item)}
                    >
                      <Download size={14} />
                      {installingProjectId === itemKey
                        ? canUpdate
                          ? t("content.updatingButton")
                          : t("content.installingButton")
                        : canUpdate
                          ? t("content.update")
                          : t("content.reinstall")}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      className="gap-2"
                      disabled={actionBusy}
                      onClick={() => void uninstallProject(installedItem)}
                    >
                      <Trash2 size={14} />
                      {uninstallingProjectId === itemKey
                        ? t("content.uninstallingButton")
                        : t("content.uninstall")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full gap-2"
                    disabled={actionBusy}
                    onClick={() => void installProject(item)}
                  >
                    <Download size={14} />
                    {installingProjectId === itemKey
                      ? t("content.installingButton")
                      : t("content.install")}
                  </Button>
                )}
              </div>
            </Card>
          );
          })}

          {!loading && results.length === 0 && (
            <Card variant="soft" className="rounded-2xl border border-dashed p-5 md:col-span-2 xl:col-span-3">
              <p className="text-sm text-[var(--text-secondary)]">
                {contentType === "world" && source !== "local"
                  ? t("content.worldOnlineEmptyState")
                  : hasSearched
                    ? t("content.noSearchResults")
                  : t("content.emptyState")}
              </p>
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                {contentType === "world" && source !== "local"
                  ? t("content.worldOnlineHint")
                  : hasSearched
                    ? t("content.noSearchResultsHint")
                  : t("content.pendingNotice")}
              </p>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-[var(--text-primary)]">{value}</p>
    </div>
  );
}

function normalizeError(error: unknown): string {
  const raw = String(error ?? "");
  return raw.startsWith("Error: ") ? raw.slice("Error: ".length).trim() : raw.trim();
}

function loaderLabel(loader: Instance["loader"], t: ReturnType<typeof useI18n>["t"]): string {
  if (loader === "forge") return t("loader.forge");
  if (loader === "fabric") return t("loader.fabric");
  return t("loader.vanilla");
}

function contentSourceLabel(
  source: ContentSource,
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (source === "local") {
    return t("content.source.local");
  }
  if (source === "curseforge") {
    return t("content.source.curseforge");
  }
  return t("content.source.modrinth");
}

function renderUpdateStateBadge(
  updateState: InstalledContentUpdate | undefined,
  t: ReturnType<typeof useI18n>["t"]
) {
  if (!updateState) {
    return null;
  }

  const appearance =
    updateState.status === "update-available"
      ? "border-amber-500/35 bg-amber-500/10 text-amber-300"
      : updateState.status === "up-to-date"
        ? "border-[var(--mc-grass)]/35 bg-[var(--mc-grass)]/10 text-[var(--mc-grass)]"
        : updateState.status === "error"
          ? "border-[var(--accent-danger)]/35 bg-[var(--accent-danger)]/10 text-[var(--accent-danger)]"
          : "border-[var(--border-medium)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]";
  const label =
    updateState.status === "update-available"
      ? t("content.updateAvailableBadge")
      : updateState.status === "up-to-date"
        ? t("content.upToDateBadge")
        : updateState.status === "error"
          ? t("content.errorBadge")
          : t("content.unavailableBadge");

  return (
    <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase ${appearance}`}>
      {label}
    </span>
  );
}

function MetaBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-[var(--border-medium)] bg-[var(--bg-elevated)] px-2 py-1 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
      {children}
    </span>
  );
}
