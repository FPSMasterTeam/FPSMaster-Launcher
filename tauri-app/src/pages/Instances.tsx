import { Plus, Search, Settings, Play, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type { Instance } from "../types";
import { resolveInstanceIconPath } from "../utils/launcher";

type InstancesPageProps = {
  instances: Instance[];
  busy: boolean;
  launchingInstanceId: string | null;
  launchProgressPercent: number | null;
  launchProgressText: string;
  onDelete: (id: string) => void;
  onGoInstall: () => void;
  onLaunchInstance: (id: string) => void;
  onOpenInstanceSettings: (id: string) => void;
};

export default function InstancesPage({
  instances,
  busy,
  launchingInstanceId,
  launchProgressPercent,
  launchProgressText,
  onDelete,
  onGoInstall,
  onLaunchInstance,
  onOpenInstanceSettings
}: InstancesPageProps) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");

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
    <div className="h-full overflow-y-auto p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[var(--text-primary)]">
            {t("instances.title")}
          </h1>
          <p className="mt-1 text-[var(--text-secondary)]">{t("instances.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <Card
            as="span"
            variant="frost"
            className="hidden rounded-full px-3 py-1.5 text-xs text-[var(--text-secondary)] md:inline-flex"
          >
            {filteredInstances.length}
          </Card>
          <Button variant="primary" size="lg" className="gap-2" onClick={onGoInstall}>
            <Plus size={16} />
            {t("instances.createInstall")}
          </Button>
        </div>
      </div>

      <div className="mb-6">
        <Card as="label" variant="soft" className="relative block rounded-xl">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
            size={18}
          />
          <input
            type="text"
            placeholder={t("instances.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="w-full rounded-xl border border-[var(--border-medium)] bg-transparent py-3 pl-11 pr-4 text-[var(--text-primary)] transition-colors focus:border-[var(--mc-grass)]/45 focus:outline-none"
          />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 pb-20 md:grid-cols-2 xl:grid-cols-3">
        {filteredInstances.map((instance) => {
          const icon = resolveInstanceIconPath(instance);
          const loaderTone =
            instance.loader === "forge"
              ? "text-amber-400 border-amber-500/35 bg-amber-500/8"
              : instance.loader === "fabric"
                ? "text-cyan-400 border-cyan-500/35 bg-cyan-500/8"
                : "text-[var(--text-secondary)] border-[var(--border-medium)] bg-[var(--bg-elevated)]";

          return (
            <Card
              as="article"
              key={instance.id}
              variant="frost"
              className="flex flex-col rounded-2xl p-5"
            >
              <div className="mb-5 flex items-start gap-4">
                <div className="relative shrink-0">
                  <div className="h-12 w-12 overflow-hidden rounded-xl border border-[var(--border-medium)] bg-[var(--bg-elevated)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                    {icon ? (
                      <img src={icon} alt={instance.name} className="h-full w-full object-cover" />
                    ) : null}
                  </div>
                  {instance.preset && (
                    <div className="absolute -bottom-1 -right-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]">
                      FPS
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-base font-semibold text-[var(--text-primary)]">
                    {instance.name}
                  </h3>
                  <p className="mt-1 truncate font-mono text-xs text-[var(--text-muted)]">
                    {instance.versionId}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span
                      className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase ${loaderTone}`}
                    >
                      {instance.loader}
                    </span>
                    {instance.preset && (
                      <span className="rounded-md border border-[var(--border-medium)] bg-[var(--surface-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                        {t("instances.preset")}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <p className="mb-5 text-xs text-[var(--text-muted)]">
                {t("instances.base")}: {instance.baseVersion}
                {instance.loaderVersion ? `  |  loader ${instance.loaderVersion}` : ""}
              </p>

              <div className="mt-auto">
                <div className="grid grid-cols-3 gap-2">
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
                  <p className="mt-1.5 text-[11px] text-[var(--text-muted)] truncate">
                    {launchProgressText || t("launch.progress.preparing")}
                  </p>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
