import { AlertTriangle, Lock, Package, Play, Plus, Puzzle, Search, Settings } from "lucide-react";
import { memo, useMemo, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { NOVA_DEFAULT_GAME_VERSION } from "../constants";
import { useI18n } from "../i18n";
import {
  buildNovaEffectiveInstance,
  isNovaTestingGameVersion,
  listNovaVersionTargets
} from "../lib/novaTargets";
import type {
  Instance,
  LauncherUser,
  LauncherVersion,
  LauncherVersionMap,
  PresetPackageStatus
} from "../types";
import { resolveInstanceIconPath } from "../utils/launcher";

type InstanceScope = "ALL" | "EDGE" | "NOVA" | "VANILLA" | "EXTREME";
type InstanceCategory = Exclude<InstanceScope, "ALL">;

type GridTarget = {
  key: string;
  category: InstanceCategory;
  instance: Instance;
  gameVersion?: string;
  catalogVersion?: LauncherVersion | null;
  label: string;
  subtitle: string;
};

type InstancesPageProps = {
  instances: Instance[];
  launcherVersions: LauncherVersionMap;
  novaGameVersions: Record<string, LauncherVersion>;
  selectedNovaGameVersion: string;
  onSelectNovaGameVersion: (gameVersion: string) => void;
  busy: boolean;
  launchingInstanceId: string | null;
  launchProgressPercent: number | null;
  launchProgressText: string;
  user: LauncherUser | null;
  presetPackageStatuses: Record<string, PresetPackageStatus | undefined>;
  selectedInstanceId: string | null;
  onDelete: (id: string) => void;
  onGoInstall: () => void;
  onLaunchInstance: (id: string, gameVersion?: string) => void;
  onOpenInstanceSettings: (id: string, gameVersion?: string) => void;
  onOpenInstanceContent: (id: string, gameVersion?: string) => void;
};

const SCOPES: InstanceScope[] = ["ALL", "EDGE", "NOVA", "EXTREME", "VANILLA"];

function canAccessInstance(_instance: Instance, _user: LauncherUser | null): boolean {
  // All client instances (Edge/Nova/Extreme) are open to every user. Channel-level entitlements
  // Catalog entitlement is enforced by the backend (product groups / rollout). Beta and
  // release client channels are open to every authenticated account.
  // returns the versions a user may access from /launcher/versions/available.
  return true;
}

function InstancesPage({
  instances,
  launcherVersions,
  novaGameVersions,
  selectedNovaGameVersion,
  onSelectNovaGameVersion,
  busy,
  launchingInstanceId,
  launchProgressPercent,
  launchProgressText,
  user,
  presetPackageStatuses,
  selectedInstanceId,
  onDelete,
  onGoInstall,
  onLaunchInstance,
  onOpenInstanceSettings,
  onOpenInstanceContent
}: InstancesPageProps) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeScope, setActiveScope] = useState<InstanceScope>("ALL");
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);

  const edgePreset = useMemo(
    () => instances.find((item) => item.preset && item.launcherVersionType === "EDGE") ?? null,
    [instances]
  );
  const novaPreset = useMemo(
    () => instances.find((item) => item.preset && item.launcherVersionType === "NOVA") ?? null,
    [instances]
  );
  const extremePreset = useMemo(
    () => instances.find((item) => item.preset && item.launcherVersionType === "EXTREME") ?? null,
    [instances]
  );
  const vanillaInstances = useMemo(() => instances.filter((item) => !item.preset), [instances]);

  const allTargets = useMemo(() => {
    const targets: GridTarget[] = [];

    if (edgePreset) {
      targets.push({
        key: edgePreset.id,
        category: "EDGE",
        instance: edgePreset,
        label: "Edge",
        subtitle: `${edgePreset.baseVersion} · ${loaderLabel(edgePreset.loader, t)}`
      });
    }

    if (novaPreset) {
      for (const { gameVersion, catalogVersion } of listNovaVersionTargets(
        novaGameVersions,
        selectedNovaGameVersion
      )) {
        const effective = buildNovaEffectiveInstance(novaPreset, gameVersion);
        targets.push({
          key: `nova:${gameVersion}`,
          category: "NOVA",
          instance: effective,
          gameVersion,
          catalogVersion,
          label: `Nova ${gameVersion}`,
          subtitle: catalogVersion?.versionName ?? gameVersion
        });
      }
    }

    if (extremePreset) {
      targets.push({
        key: extremePreset.id,
        category: "EXTREME",
        instance: extremePreset,
        label: "Extreme",
        subtitle: extremePreset.baseVersion
      });
    }

    for (const instance of vanillaInstances) {
      targets.push({
        key: instance.id,
        category: "VANILLA",
        instance,
        label: instance.name,
        subtitle: `${instance.baseVersion} · ${loaderLabel(instance.loader, t)}`
      });
    }

    return targets;
  }, [
    edgePreset,
    novaPreset,
    extremePreset,
    vanillaInstances,
    novaGameVersions,
    selectedNovaGameVersion,
    t
  ]);

  const scopeCounts = useMemo(() => {
    const counts: Record<InstanceScope, number> = {
      ALL: allTargets.length,
      EDGE: 0,
      NOVA: 0,
      EXTREME: 0,
      VANILLA: 0
    };
    for (const target of allTargets) {
      counts[target.category] += 1;
    }
    return counts;
  }, [allTargets]);

  const scopedTargets = useMemo(() => {
    if (activeScope === "ALL") return allTargets;
    return allTargets.filter((target) => target.category === activeScope);
  }, [allTargets, activeScope]);

  const filteredTargets = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    if (keyword === "") return scopedTargets;
    return scopedTargets.filter(
      (target) =>
        target.label.toLowerCase().includes(keyword) ||
        target.subtitle.toLowerCase().includes(keyword) ||
        target.instance.versionId.toLowerCase().includes(keyword) ||
        target.instance.baseVersion.toLowerCase().includes(keyword) ||
        (target.gameVersion ?? "").toLowerCase().includes(keyword)
    );
  }, [scopedTargets, searchQuery]);

  const resolvedSelectedKey = useMemo(() => {
    if (selectedTargetKey && filteredTargets.some((item) => item.key === selectedTargetKey)) {
      return selectedTargetKey;
    }
    const novaKey = `nova:${selectedNovaGameVersion}`;
    if (
      (activeScope === "ALL" || activeScope === "NOVA") &&
      filteredTargets.some((item) => item.key === novaKey) &&
      selectedInstanceId &&
      novaPreset?.id === selectedInstanceId
    ) {
      return novaKey;
    }
    if (selectedInstanceId && filteredTargets.some((item) => item.key === selectedInstanceId)) {
      return selectedInstanceId;
    }
    return filteredTargets[0]?.key ?? null;
  }, [
    selectedTargetKey,
    filteredTargets,
    activeScope,
    selectedNovaGameVersion,
    selectedInstanceId,
    novaPreset?.id
  ]);

  const selectedTarget =
    filteredTargets.find((item) => item.key === resolvedSelectedKey) ?? filteredTargets[0] ?? null;

  function selectTarget(target: GridTarget) {
    setSelectedTargetKey(target.key);
    if (target.category === "NOVA" && target.gameVersion) {
      onSelectNovaGameVersion(target.gameVersion);
    }
  }

  function scopeLabel(scope: InstanceScope): string {
    if (scope === "ALL") return t("instances.scope.all");
    if (scope === "EDGE") return t("instances.category.edge");
    if (scope === "NOVA") return t("instances.category.nova");
    if (scope === "VANILLA") return t("instances.category.vanilla");
    return t("instances.category.extreme");
  }

  function categoryLabel(category: InstanceCategory): string {
    return scopeLabel(category);
  }

  // Nova statuses are keyed per game version (`nova:<gv>` — same as target.key);
  // other presets keep the plain instance-id key.
  function presetStatusFor(target: GridTarget): PresetPackageStatus | undefined {
    return target.category === "NOVA"
      ? presetPackageStatuses[target.key]
      : presetPackageStatuses[target.instance.id];
  }

  const selectedIcon = selectedTarget ? resolveInstanceIconPath(selectedTarget.instance) : null;
  const selectedPresetStatus = selectedTarget ? presetStatusFor(selectedTarget) : undefined;
  const selectedCanAccess = selectedTarget
    ? canAccessInstance(selectedTarget.instance, user)
    : false;
  const selectedIsLaunching =
    Boolean(selectedTarget) && busy && launchingInstanceId === selectedTarget!.instance.id;
  const selectedIsTesting =
    selectedTarget?.category === "NOVA" &&
    Boolean(selectedTarget.gameVersion) &&
    isNovaTestingGameVersion(selectedTarget.gameVersion!);
  const selectedCatalogRelease =
    selectedTarget?.catalogVersion ??
    (selectedTarget?.category === "EDGE"
      ? launcherVersions.EDGE
      : selectedTarget?.category === "EXTREME"
        ? launcherVersions.EXTREME
        : null);

  return (
    <div className="page-shell">
      <header className="page-header mb-6">
        <div className="page-header-main">
          <p className="page-eyebrow">{t("nav.myGames")}</p>
          <h1 className="page-title">{t("instances.title")}</h1>
          <p className="page-subtitle">{t("instances.subtitle")}</p>
        </div>
        <div className="page-header-actions">
          <Button variant="primary" size="lg" className="gap-2 !rounded-[10px]" onClick={onGoInstall}>
            <Plus size={16} />
            {t("instances.createInstall")}
          </Button>
        </div>
      </header>

      <div className="instances-toolbar mb-5">
        <div className="instances-scope-tabs" role="tablist" aria-label={t("instances.scope.label")}>
          {SCOPES.map((scope) => (
            <button
              key={scope}
              type="button"
              role="tab"
              aria-selected={activeScope === scope}
              className={`instances-scope-tab ${activeScope === scope ? "is-active" : ""}`}
              onClick={() => {
                setActiveScope(scope);
                setSelectedTargetKey(null);
              }}
            >
              {scopeLabel(scope)}
              <span className="instances-scope-tab-count">{scopeCounts[scope]}</span>
            </button>
          ))}
        </div>

        <div className="search-field instances-toolbar-search">
          <Search className="search-field-icon" size={18} />
          <input
            type="text"
            placeholder={t("instances.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="ui-input"
          />
        </div>
      </div>

      <div className="instances-layout">
        <section className="instances-list-pane">
          {filteredTargets.length > 0 ? (
            <div className="instances-list">
              {filteredTargets.map((target) => {
                const icon = resolveInstanceIconPath(target.instance);
                const active = target.key === resolvedSelectedKey;
                const canAccess = canAccessInstance(target.instance, user);
                const presetStatus = presetStatusFor(target);
                const launching = busy && launchingInstanceId === target.instance.id;
                const testing =
                  target.category === "NOVA" &&
                  Boolean(target.gameVersion) &&
                  isNovaTestingGameVersion(target.gameVersion!);

                return (
                  <div
                    key={target.key}
                    role="button"
                    tabIndex={0}
                    className={`instances-row ${active ? "is-active" : ""} ${!canAccess ? "is-locked" : ""}`}
                    onClick={() => selectTarget(target)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectTarget(target);
                      }
                    }}
                  >
                    <div className="instances-row-icon">
                      {icon ? (
                        <img src={icon} alt="" />
                      ) : (
                        <Package size={20} />
                      )}
                      {!canAccess && (
                        <span className="instances-row-lock">
                          <Lock size={12} />
                        </span>
                      )}
                    </div>

                    <div className="instances-row-main">
                      <div className="instances-row-title-line">
                        <span className="instances-row-title">{target.label}</span>
                        {testing && (
                          <span className="badge badge-warning shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px]">
                            {t("home.novaTestingBadge")}
                          </span>
                        )}
                        {target.category !== "VANILLA" &&
                          presetStatus &&
                          (presetStatus.state === "update-available" ||
                            presetStatus.state === "missing") &&
                          canAccess && (
                            <span className="badge badge-warning shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px]">
                              {t("instances.status.updateAvailable")}
                            </span>
                          )}
                        {target.category !== "VANILLA" &&
                          presetStatus?.state === "needs-repair" &&
                          canAccess && (
                            <span className="badge badge-danger shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px]">
                              {t("instances.status.needsRepair")}
                            </span>
                          )}
                      </div>
                      <p className="instances-row-sub">
                        {launching
                          ? typeof launchProgressPercent === "number"
                            ? `${launchProgressText || t("launch.progress.preparing")} · ${launchProgressPercent}%`
                            : launchProgressText || t("launch.progress.preparing")
                          : target.subtitle}
                      </p>
                    </div>

                    <button
                      type="button"
                      className="instances-row-play"
                      disabled={busy || !canAccess}
                      onClick={(event) => {
                        event.stopPropagation();
                        onLaunchInstance(target.instance.id, target.gameVersion);
                      }}
                      title={t("instances.play")}
                    >
                      <Play size={14} fill="currentColor" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state py-16">
              <Package size={48} className="empty-state-icon" />
              <p className="empty-state-title">
                {activeScope === "VANILLA" ? t("instances.vanillaEmpty") : t("instances.noInstances")}
              </p>
              <p className="empty-state-text">
                {activeScope === "VANILLA"
                  ? t("instances.vanillaEmptyHint")
                  : t("instances.noInstancesHint")}
              </p>
              {(activeScope === "VANILLA" || activeScope === "ALL") && (
                <Button
                  variant="primary"
                  size="md"
                  className="mt-4 gap-2 !rounded-[10px]"
                  onClick={onGoInstall}
                >
                  <Plus size={16} />
                  {t("instances.createInstall")}
                </Button>
              )}
            </div>
          )}
        </section>

        <aside className="instances-detail-pane">
          {selectedTarget ? (
            <Card
              variant="frost"
              className="instances-detail-card page-card rounded-[14px]"
              interactive={false}
            >
              <div className="instances-detail-head">
                <div className="instances-detail-icon">
                  {selectedIcon ? (
                    <img src={selectedIcon} alt="" />
                  ) : (
                    <Package size={24} />
                  )}
                </div>
                <div className="instances-detail-head-main">
                  <p className="instances-detail-kicker">
                    {categoryLabel(selectedTarget.category)}
                  </p>
                  <h3 className="instances-detail-title">{selectedTarget.label}</h3>
                </div>
              </div>

              <p className="instances-detail-desc">
                {selectedTarget.category === "NOVA"
                  ? t("instances.detail.novaDesc", {
                      version: selectedTarget.gameVersion ?? NOVA_DEFAULT_GAME_VERSION
                    })
                  : selectedTarget.category === "VANILLA"
                    ? t("instances.detail.vanillaDesc")
                    : t("instances.detail.presetDesc", {
                        name: categoryLabel(selectedTarget.category)
                      })}
              </p>

              {selectedIsTesting && (
                <p className="mt-3 inline-flex items-start gap-1.5 text-xs font-medium text-[var(--warning-text)]">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  {t("home.novaTestingWarning", {
                    version: selectedTarget.gameVersion ?? selectedNovaGameVersion
                  })}
                </p>
              )}

              <div className="instances-detail-meta mt-4">
                <MetaChip
                  label={t("instances.detail.gameVersion")}
                  value={selectedTarget.instance.baseVersion}
                />
                <MetaChip
                  label={t("instances.detail.loader")}
                  value={loaderLabel(selectedTarget.instance.loader, t)}
                />
                {selectedTarget.category !== "VANILLA" && selectedPresetStatus && (
                  <MetaChip
                    label={t("instances.detail.package")}
                    value={presetStatusLabel(selectedPresetStatus.state, t)}
                    tone={resolvePresetStatusTone(selectedPresetStatus.state)}
                  />
                )}
                {selectedCatalogRelease?.channel && (
                  <MetaChip
                    label={t("instances.packageChannel")}
                    value={selectedCatalogRelease.channel}
                  />
                )}
              </div>

              {selectedCatalogRelease?.versionName && (
                <p className="mt-3 text-xs text-[var(--text-muted)]">
                  {t("instances.detail.release", {
                    version: selectedCatalogRelease.versionName
                  })}
                </p>
              )}

              {selectedIsLaunching && (
                <p className="mt-3 text-center text-[11px] text-[var(--text-muted)]">
                  {launchProgressText || t("launch.progress.preparing")}
                </p>
              )}

              <div className="instances-detail-actions">
                <button
                  type="button"
                  className="instances-detail-icon-btn"
                  disabled={!selectedCanAccess}
                  onClick={() =>
                    onOpenInstanceSettings(
                      selectedTarget.instance.id,
                      selectedTarget.gameVersion
                    )
                  }
                  title={t("instances.settings")}
                >
                  <Settings size={16} />
                </button>
                <button
                  type="button"
                  className="instances-detail-icon-btn"
                  disabled={!selectedCanAccess || selectedTarget.category === "EXTREME"}
                  onClick={() =>
                    onOpenInstanceContent(
                      selectedTarget.instance.id,
                      selectedTarget.gameVersion
                    )
                  }
                  title={t("instances.manageContent")}
                >
                  <Puzzle size={16} />
                </button>
                <Button
                  variant="primary"
                  size="lg"
                  className="instances-detail-launch gap-2"
                  launchProgress={selectedIsLaunching}
                  launchProgressPercent={selectedIsLaunching ? launchProgressPercent : null}
                  disabled={busy || !selectedCanAccess}
                  onClick={() =>
                    onLaunchInstance(selectedTarget.instance.id, selectedTarget.gameVersion)
                  }
                >
                  <Play size={16} fill="currentColor" />
                  {selectedIsLaunching && typeof launchProgressPercent === "number"
                    ? `${launchProgressPercent}%`
                    : t("instances.play")}
                </Button>
              </div>

              {selectedTarget.category === "VANILLA" && (
                <button
                  type="button"
                  className="mt-3 w-full text-center text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--accent-danger)]"
                  onClick={() => onDelete(selectedTarget.instance.id)}
                >
                  {t("instances.delete")}
                </button>
              )}
            </Card>
          ) : (
            <Card
              variant="frost"
              className="instances-detail-card page-card rounded-[14px]"
              interactive={false}
            >
              <p className="text-sm text-[var(--text-muted)]">{t("instances.detail.empty")}</p>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

function MetaChip({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="instances-meta-chip">
      <p className="instances-meta-label">{label}</p>
      <p className={`instances-meta-value ${tone ?? ""}`}>{value}</p>
    </div>
  );
}

function loaderLabel(
  loader: Instance["loader"],
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (loader === "forge") return t("loader.forge");
  if (loader === "fabric") return t("loader.fabric");
  return t("loader.vanilla");
}

function presetStatusLabel(
  state: PresetPackageStatus["state"],
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (state === "ready") return t("instances.status.ready");
  if (state === "update-available") return t("instances.status.updateAvailable");
  if (state === "needs-repair") return t("instances.status.needsRepair");
  if (state === "syncing") return t("instances.status.syncing");
  if (state === "checking") return t("instances.status.checking");
  if (state === "error") return t("instances.status.error");
  if (state === "pending-release") return t("instances.status.pendingRelease");
  if (state === "beta") return t("instances.status.beta");
  return t("instances.status.missing");
}

function resolvePresetStatusTone(state: PresetPackageStatus["state"]): string {
  if (state === "ready") return "text-[#25b87a]";
  if (state === "update-available") return "text-amber-300";
  if (state === "needs-repair" || state === "error") return "text-[var(--accent-danger)]";
  if (state === "syncing" || state === "checking") return "text-cyan-300";
  if (state === "pending-release") return "text-violet-300";
  return "text-[var(--text-secondary)]";
}

export default memo(InstancesPage);
