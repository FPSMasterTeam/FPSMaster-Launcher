import { Lock, Plus, Search, Settings, Play, Swords, Gamepad2 } from "lucide-react";
import { memo, useMemo, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type { Instance, LauncherUser, LauncherVersion, PresetPackageStatus } from "../types";
import { resolveInstanceIconPath } from "../utils/launcher";

type InstancesPageProps = {
  instances: Instance[];
  launcherVersions: Record<"EDGE" | "NOVA", LauncherVersion | null>;
  busy: boolean;
  launchingInstanceId: string | null;
  launchProgressPercent: number | null;
  launchProgressText: string;
  user: LauncherUser | null;
  presetPackageStatuses: Record<string, PresetPackageStatus | undefined>;
  onDelete: (id: string) => void;
  onGoInstall: () => void;
  onLaunchInstance: (id: string) => void;
  onOpenInstanceSettings: (id: string) => void;
};

function canAccessInstance(_instance: Instance, _user: LauncherUser | null): boolean {
  // All client instances (Edge/Nova/Extreme) are open to every user. Channel-level entitlements
  // (e.g. nova/extreme beta & nightly require sponsor) are enforced by the backend, which only
  // returns the versions a user may access from /launcher/versions/available.
  return true;
}

function InstancesPage({
  instances,
  launcherVersions,
  busy,
  launchingInstanceId,
  launchProgressPercent,
  launchProgressText,
  user,
  presetPackageStatuses,
  onDelete,
  onGoInstall,
  onLaunchInstance,
  onOpenInstanceSettings
}: InstancesPageProps) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredInstances = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    let result = instances;
    if (keyword !== "") {
      result = instances.filter(
        (instance) =>
          instance.name.toLowerCase().includes(keyword) ||
          instance.versionId.toLowerCase().includes(keyword) ||
          instance.baseVersion.toLowerCase().includes(keyword)
      );
    }
    return result;
  }, [instances, searchQuery]);

  // Split into FPSMaster and regular instances
  const fpsMasterInstances = useMemo(
    () => filteredInstances.filter((i) => i.preset),
    [filteredInstances]
  );
  const regularInstances = useMemo(
    () => filteredInstances.filter((i) => !i.preset),
    [filteredInstances]
  );

  function renderInstanceCard(instance: Instance) {
    const icon = resolveInstanceIconPath(instance);
    const presetStatus = presetPackageStatuses[instance.id];
    const canAccess = canAccessInstance(instance, user);

    return (
      <Card as="article" key={instance.id} variant="frost" className={`page-card page-card-compact flex flex-col rounded-[10px] ${!canAccess ? "opacity-60" : ""}`} interactive={false}>
        <div className="flex items-center gap-3">
          <div className="relative shrink-0">
            <div className="h-14 w-14 overflow-hidden rounded-[8px] border border-white/5 bg-[var(--bg-elevated)]">
              {icon ? <img src={icon} alt={instance.name} className="h-full w-full object-cover" /> : null}
              {!canAccess && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                  <Lock size={14} className="text-white/70" />
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className={`truncate text-base font-semibold ${!canAccess ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
                {instance.name}
              </h3>
              {!canAccess && <Lock size={12} className="text-[var(--text-muted)] shrink-0" />}
              {instance.preset && presetStatus && (presetStatus.state === "update-available" || presetStatus.state === "missing") && canAccess && (
                <span className="badge badge-warning shrink-0 rounded-[5px] px-2 py-1 text-[10px]">
                  {t("instances.status.updateAvailable")}
                </span>
              )}
              {instance.preset && presetStatus && presetStatus.state === "needs-repair" && canAccess && (
                <span className="badge shrink-0 rounded-[5px] border-[#ff6b8f]/25 bg-[#ff6b8f]/10 px-2 py-1 text-[10px] text-[#ff6b8f]">
                  {t("instances.status.needsRepair")}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="badge badge-muted text-data rounded-[5px] px-2 py-1 text-[10px]">
                {instance.baseVersion}
              </span>
              <span className={`badge rounded-[5px] px-2 py-1 text-[10px] ${
                instance.loader === "forge"
                  ? "badge-warning text-amber-400"
                  : instance.loader === "fabric"
                    ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
                    : "badge-muted"
              }`}>
                {loaderLabel(instance.loader, t)}
              </span>
              {!instance.preset && instance.launcherVersionType && (
                <span className="text-data text-[var(--text-muted)]">{instance.launcherVersionType}</span>
              )}
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              className="gap-1"
              launchProgress={busy && launchingInstanceId === instance.id}
              launchProgressPercent={busy && launchingInstanceId === instance.id ? launchProgressPercent : null}
              disabled={busy || !canAccess}
              onClick={() => onLaunchInstance(instance.id)}
            >
              <Play size={14} fill="currentColor" />
              {busy && launchingInstanceId === instance.id && typeof launchProgressPercent === "number"
                ? `${launchProgressPercent}%`
                : t("instances.play")}
            </Button>
            <button
              className="shrink-0 rounded-lg p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              onClick={() => onOpenInstanceSettings(instance.id)}
              disabled={!canAccess}
              title={t("instances.settings")}
            >
              <Settings size={16} />
            </button>
          </div>
        </div>
        {busy && launchingInstanceId === instance.id && (
          <p className="mt-2 text-center text-[11px] text-[var(--text-muted)]">{launchProgressText || t("launch.progress.preparing")}</p>
        )}
      </Card>
    );
  }

  return (
    <div className="page-shell">
      <header className="page-header mb-6">
        <div className="page-header-main">
          <p className="page-eyebrow">{t("nav.myGames")}</p>
          <h1 className="page-title">
            {t("instances.title")}
          </h1>
          <p className="page-subtitle">{t("instances.subtitle")}</p>
        </div>
        <div className="page-header-actions">
          <Card as="span" variant="frost" className="page-card page-card-compact inline-flex rounded-full px-3 py-1.5 text-xs text-[var(--text-secondary)]" interactive={false}>
            {t("instances.count", { count: filteredInstances.length })}
          </Card>
          <Button variant="primary" size="lg" className="gap-2 !rounded-[10px]" onClick={onGoInstall}>
            <Plus size={16} />
            {t("instances.createInstall")}
          </Button>
        </div>
      </header>

      <div className="search-field mb-5">
        <Search className="search-field-icon" size={18} />
        <input
          type="text"
          placeholder={t("instances.searchPlaceholder")}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="ui-input"
        />
      </div>

      {/* FPSMaster Instances Section */}
      {fpsMasterInstances.length > 0 && (
        <div className="mb-6">
          <div className="mb-3 flex items-center gap-2 px-1">
            <Swords size={16} className="text-[var(--mc-grass)]" />
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--mc-grass)]">FPSMaster</h2>
            <span className="badge badge-accent rounded-[5px] px-2 py-1 text-xs normal-case tracking-normal">
              {fpsMasterInstances.length}
            </span>
          </div>
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {fpsMasterInstances.map((instance) => renderInstanceCard(instance))}
          </section>
        </div>
      )}

      {/* Regular Instances Section */}
      {regularInstances.length > 0 && (
        <div className="mb-6">
          <div className="mb-3 flex items-center gap-2 px-1">
            <Gamepad2 size={16} className="text-[var(--text-secondary)]" />
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary)]">
              {t("nav.myGames")}
            </h2>
            <span className="badge badge-muted rounded-[5px] px-2 py-1 text-xs normal-case tracking-normal">
              {regularInstances.length}
            </span>
          </div>
          <section className="grid grid-cols-1 gap-4 pb-20 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {regularInstances.map((instance) => renderInstanceCard(instance))}
          </section>
        </div>
      )}

      {/* Empty state */}
      {filteredInstances.length === 0 && (
        <div className="empty-state py-20">
          <Gamepad2 size={48} className="empty-state-icon" />
          <p className="empty-state-title">{t("instances.noInstances")}</p>
          <p className="empty-state-text">{t("instances.noInstancesHint")}</p>
        </div>
      )}
    </div>
  );
}

function MiniMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 truncate text-[11px] font-medium text-[var(--text-secondary)]">{value}</p>
    </div>
  );
}

function formatDate(raw?: string | null): string {
  if (!raw) {
    return "-";
  }
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    return "-";
  }
  return value.toLocaleDateString();
}

function describePresetPackageStatus(
  status: PresetPackageStatus,
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (status.state === "ready") {
    return t("instances.packageReady", { version: status.versionTag ?? "-" });
  }
  if (status.state === "update-available") {
    return t("instances.packageUpdateAvailable", { version: status.targetVersionTag ?? status.versionTag ?? "-" });
  }
  if (status.state === "needs-repair") {
    return t("instances.packageNeedsRepair", { version: status.installedVersionTag ?? status.versionTag ?? "-" });
  }
  if (status.state === "syncing") {
    return t("instances.packageSyncing", { version: status.targetVersionTag ?? status.versionTag ?? "-" });
  }
  if (status.state === "checking") {
    return t("instances.packageChecking");
  }
  if (status.state === "error") {
    return t("instances.packageError", { error: status.lastError ?? "-" });
  }
  if (status.state === "pending-release") {
    return t("instances.packagePendingRelease");
  }
  if (status.state === "beta") {
    return t("instances.packageBetaOnly");
  }
  return t("instances.packageMissing");
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
  if (state === "ready") {
    return "border-[#25b87a]/25 bg-[#25b87a]/10 text-[#25b87a]";
  }
  if (state === "update-available") {
    return "border-amber-500/35 bg-amber-500/10 text-amber-300";
  }
  if (state === "needs-repair") {
    return "border-[#ff6b8f]/25 bg-[#ff6b8f]/10 text-[#ff6b8f]";
  }
  if (state === "syncing" || state === "checking") {
    return "border-cyan-500/35 bg-cyan-500/10 text-cyan-300";
  }
  if (state === "error") {
    return "border-[#ff6b8f]/25 bg-[#ff6b8f]/10 text-[#ff6b8f]";
  }
  if (state === "pending-release") {
    return "border-violet-500/35 bg-violet-500/10 text-violet-300";
  }
  if (state === "beta") {
    return "border-white/10 bg-[var(--surface-soft)] text-[var(--text-secondary)]";
  }
  return "border-white/10 bg-[var(--surface-soft)] text-[var(--text-secondary)]";
}

export default memo(InstancesPage);
