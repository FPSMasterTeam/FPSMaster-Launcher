import { Archive, Copy, Download, Plus, Search, Settings, Play, Trash2 } from "lucide-react";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type { Instance, LauncherVersion, PresetPackageStatus } from "../types";
import { resolveInstanceIconPath } from "../utils/launcher";

type InstancesPageProps = {
  instances: Instance[];
  launcherVersions: Record<"EDGE" | "NOVA", LauncherVersion | null>;
  busy: boolean;
  launchingInstanceId: string | null;
  launchProgressPercent: number | null;
  launchProgressText: string;
  presetPackageStatuses: Record<string, PresetPackageStatus | undefined>;
  onDelete: (id: string) => void;
  onDuplicateInstance: (id: string) => void;
  onExportInstance: (id: string) => void;
  onImportInstance: (file: File) => void;
  onGoInstall: () => void;
  onLaunchInstance: (id: string) => void;
  onOpenInstanceSettings: (id: string) => void;
  onSyncPresetPackage: (id: string) => void;
};

export default function InstancesPage({
  instances,
  launcherVersions,
  busy,
  launchingInstanceId,
  launchProgressPercent,
  launchProgressText,
  presetPackageStatuses,
  onDelete,
  onDuplicateInstance,
  onExportInstance,
  onImportInstance,
  onGoInstall,
  onLaunchInstance,
  onOpenInstanceSettings,
  onSyncPresetPackage
}: InstancesPageProps) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const filteredInstances = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    if (keyword === "") return instances;
    return instances.filter(
      (instance) =>
        instance.name.toLowerCase().includes(keyword) ||
        instance.versionId.toLowerCase().includes(keyword) ||
        instance.baseVersion.toLowerCase().includes(keyword)
    );
  }, [instances, searchQuery]);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5 xl:p-6">
      <header className="mb-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">{t("nav.myGames")}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
            {t("instances.title")}
          </h1>
          <p className="mt-1 text-[var(--text-secondary)]">{t("instances.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <Card as="span" variant="frost" className="inline-flex rounded-full px-3 py-1.5 text-xs text-[var(--text-secondary)]">
            {t("instances.count", { count: filteredInstances.length })}
          </Card>
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => handleImportChange(event, onImportInstance)}
          />
          <Button
            variant="secondary"
            size="lg"
            className="gap-2"
            disabled={busy}
            onClick={() => importInputRef.current?.click()}
          >
            <Download size={16} />
            {t("instances.import")}
          </Button>
          <Button variant="primary" size="lg" className="gap-2" onClick={onGoInstall}>
            <Plus size={16} />
            {t("instances.createInstall")}
          </Button>
        </div>
      </header>

      <Card as="label" variant="soft" className="relative mb-5 block rounded-2xl px-3 py-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={18} />
        <input
          type="text"
          placeholder={t("instances.searchPlaceholder")}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="w-full rounded-xl border border-[var(--border-medium)] bg-transparent py-3 pl-11 pr-4 text-[var(--text-primary)] transition-colors focus:border-[var(--mc-grass)]/45 focus:outline-none"
        />
      </Card>

      <section className="grid grid-cols-1 gap-4 pb-20 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {filteredInstances.map((instance) => {
          const icon = resolveInstanceIconPath(instance);
          const presetStatus = presetPackageStatuses[instance.id];
          const recommendedVersion = instance.launcherVersionType
            ? launcherVersions[instance.launcherVersionType]
            : null;
          const loaderTone =
            instance.loader === "forge"
              ? "text-amber-400 border-amber-500/35 bg-amber-500/8"
              : instance.loader === "fabric"
                ? "text-cyan-400 border-cyan-500/35 bg-cyan-500/8"
                : "text-[var(--text-secondary)] border-[var(--border-medium)] bg-[var(--bg-elevated)]";

          return (
            <Card as="article" key={instance.id} variant="frost" className="flex min-h-[272px] flex-col rounded-2xl p-4 md:p-5">
              <div className="mb-4 flex items-start gap-4">
                <div className="relative shrink-0">
                  <div className="h-12 w-12 overflow-hidden rounded-xl border border-[var(--border-medium)] bg-[var(--bg-elevated)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                    {icon ? <img src={icon} alt={instance.name} className="h-full w-full object-cover" /> : null}
                  </div>
                  {instance.preset && (
                    <div className="absolute -bottom-1 -right-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]">
                      FPS
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-base font-semibold text-[var(--text-primary)]">{instance.name}</h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className="rounded-md border border-[var(--border-medium)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                      {instance.baseVersion}
                    </span>
                    <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase ${loaderTone}`}>
                      {loaderLabel(instance.loader, t)}
                    </span>
                    {instance.launcherVersionType && (
                      <span className="rounded-md border border-[var(--border-medium)] bg-[var(--surface-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                        {instance.launcherVersionType}
                      </span>
                    )}
                    {instance.preset && (
                      <span className="rounded-md border border-[var(--border-medium)] bg-[var(--surface-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                        {t("instances.preset")}
                      </span>
                    )}
                  </div>
                  {instance.loaderVersion && (
                    <p className="mt-2 truncate text-xs text-[var(--text-secondary)]">
                      <span className="text-[var(--text-muted)]">{t("install.loaderLabel")}</span>
                      {loaderLabel(instance.loader, t)} {instance.loaderVersion}
                    </p>
                  )}
                  {instance.preset && presetStatus && (
                    <div className="mt-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-soft)] p-3 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase ${resolvePresetStatusTone(presetStatus.state)}`}>
                          {presetStatusLabel(presetStatus.state, t)}
                        </span>
                        {presetStatus.targetVersionTag && (
                          <span className="truncate text-[10px] text-[var(--text-muted)]">
                            {t("instances.packageTargetVersion")}: {presetStatus.targetVersionTag}
                          </span>
                        )}
                      </div>
                      <p className="line-clamp-2 text-[11px] leading-5 text-[var(--text-muted)]">
                        {describePresetPackageStatus(presetStatus, t)}
                      </p>
                      {recommendedVersion && (
                        <div className="grid grid-cols-2 gap-2 pt-1">
                          <MiniMeta
                            label={t("instances.packageChannel")}
                            value={recommendedVersion.channel || "-"}
                          />
                          <MiniMeta
                            label={t("instances.packagePublishedAt")}
                            value={formatDate(recommendedVersion.createdAt)}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-auto">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full gap-1"
                    fullWidth
                    launchProgress={busy && launchingInstanceId === instance.id}
                    launchProgressPercent={busy && launchingInstanceId === instance.id ? launchProgressPercent : null}
                    disabled={busy}
                    onClick={() => onLaunchInstance(instance.id)}
                  >
                    <Play size={13} fill="currentColor" />
                    {busy && launchingInstanceId === instance.id && typeof launchProgressPercent === "number"
                      ? `${t("home.launching")} ${launchProgressPercent}%`
                      : t("instances.play")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full gap-1"
                    fullWidth
                    onClick={() => onOpenInstanceSettings(instance.id)}
                  >
                    <Settings size={13} />
                    {t("instances.settings")}
                  </Button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-1"
                    fullWidth
                    onClick={() => onDuplicateInstance(instance.id)}
                    disabled={busy}
                  >
                    <Copy size={13} />
                    {t("instances.copy")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-1"
                    fullWidth
                    onClick={() => onExportInstance(instance.id)}
                    disabled={busy}
                  >
                    <Archive size={13} />
                    {t("instances.export")}
                  </Button>
                </div>
                <div className={`mt-2 grid gap-2 ${instance.preset ? "grid-cols-2" : "grid-cols-1"}`}>
                  {instance.preset && (
                    <Button
                      variant={
                        presetStatus?.state === "update-available" ||
                        presetStatus?.state === "missing" ||
                        presetStatus?.state === "error"
                          ? "secondary"
                          : "outline"
                      }
                      size="sm"
                      className="w-full gap-1"
                      fullWidth
                      onClick={() => onSyncPresetPackage(instance.id)}
                      disabled={busy}
                    >
                      <Download size={13} />
                      {t("instances.syncPackage")}
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="sm"
                    className="w-full gap-1"
                    fullWidth
                    onClick={() => onDelete(instance.id)}
                    disabled={instance.preset}
                  >
                    <Trash2 size={13} />
                    {t("instances.delete")}
                  </Button>
                </div>
                {busy && launchingInstanceId === instance.id && (
                  <p className="mt-1.5 truncate text-[11px] text-[var(--text-muted)]">{launchProgressText || t("launch.progress.preparing")}</p>
                )}
              </div>
            </Card>
          );
        })}
      </section>
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

function handleImportChange(
  event: ChangeEvent<HTMLInputElement>,
  onImportInstance: (file: File) => void
) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) {
    return;
  }
  onImportInstance(file);
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
  if (state === "syncing") return t("instances.status.syncing");
  if (state === "checking") return t("instances.status.checking");
  if (state === "error") return t("instances.status.error");
  if (state === "pending-release") return t("instances.status.pendingRelease");
  if (state === "beta") return t("instances.status.beta");
  return t("instances.status.missing");
}

function resolvePresetStatusTone(state: PresetPackageStatus["state"]): string {
  if (state === "ready") {
    return "border-[var(--mc-grass)]/35 bg-[var(--mc-grass)]/10 text-[var(--mc-grass)]";
  }
  if (state === "update-available") {
    return "border-amber-500/35 bg-amber-500/10 text-amber-300";
  }
  if (state === "syncing" || state === "checking") {
    return "border-cyan-500/35 bg-cyan-500/10 text-cyan-300";
  }
  if (state === "error") {
    return "border-[var(--accent-danger)]/35 bg-[var(--accent-danger)]/10 text-[var(--accent-danger)]";
  }
  if (state === "pending-release") {
    return "border-violet-500/35 bg-violet-500/10 text-violet-300";
  }
  if (state === "beta") {
    return "border-[var(--border-medium)] bg-[var(--surface-soft)] text-[var(--text-secondary)]";
  }
  return "border-[var(--border-medium)] bg-[var(--surface-soft)] text-[var(--text-secondary)]";
}
