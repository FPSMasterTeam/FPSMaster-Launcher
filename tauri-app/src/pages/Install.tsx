import { Box, Layers, PenTool, Plus } from "lucide-react";
import { useMemo } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type { Loader } from "../types";

type InstallPageProps = {
  catalogLoading: boolean;
  catalogCount: number;
  majors: string[];
  major: string;
  grouped: Record<string, string[]>;
  showSnapshots: boolean;
  snapshots: string[];
  majorVersions: string[];
  installVersion: string;
  loader: Loader;
  loaderLoading: boolean;
  loaderOptions: string[];
  loaderVersion: string;
  installedVersions: string[];
  installDisabled: boolean;
  installButtonText: string;
  onSelectMajor: (major: string) => void;
  onToggleSnapshots: () => void;
  onSelectInstallVersion: (version: string) => void;
  onSelectLoader: (loader: Loader) => void;
  onSelectLoaderVersion: (version: string) => void;
  onInstall: () => void;
};

export default function InstallPage({
  catalogLoading,
  catalogCount,
  majors,
  major,
  grouped,
  showSnapshots,
  snapshots,
  majorVersions,
  installVersion,
  loader,
  loaderLoading,
  loaderOptions,
  loaderVersion,
  installedVersions,
  installDisabled,
  installButtonText,
  onSelectMajor,
  onToggleSnapshots,
  onSelectInstallVersion,
  onSelectLoader,
  onSelectLoaderVersion,
  onInstall
}: InstallPageProps) {
  const { t } = useI18n();
  const installedSet = useMemo(() => new Set(installedVersions), [installedVersions]);

  const loaderLabel = (value: Loader) => {
    if (value === "forge") return t("loader.forge");
    if (value === "fabric") return t("loader.fabric");
    return t("loader.vanilla");
  };

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[var(--text-primary)]">{t("install.title")}</h1>
          <p className="mt-1 text-[var(--text-secondary)]">{t("install.subtitle")}</p>
        </div>
        <Card variant="frost" className="rounded-full px-4 py-2 text-sm text-[var(--text-secondary)]">
          {catalogLoading ? t("install.syncing") : t("install.versionCount", { count: catalogCount })}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card as="section" variant="frost" className="rounded-2xl p-6">
          <div className="mb-5 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t("install.selectVersion")}</h3>
            <Card variant="soft" className="rounded-lg p-1">
              <button
                onClick={() => {
                  if (showSnapshots) onToggleSnapshots();
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  !showSnapshots
                    ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
                type="button"
              >
                {t("install.releases")}
              </button>
              <button
                onClick={() => {
                  if (!showSnapshots) onToggleSnapshots();
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  showSnapshots
                    ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
                type="button"
              >
                {t("install.snapshots")}
              </button>
            </Card>
          </div>

          {!showSnapshots && (
            <>
              <div className="mb-4 flex flex-wrap gap-2">
                {majors.map((item) => (
                  <button
                    key={item}
                    onClick={() => onSelectMajor(item)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                      major === item
                        ? "border-[var(--mc-grass)]/55 bg-[var(--mc-grass)]/12 text-[var(--text-primary)]"
                        : "border-[var(--border-medium)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                    type="button"
                  >
                    {item} <span className="opacity-70">({grouped[item].length})</span>
                  </button>
                ))}
              </div>
              <div className="flex max-h-72 flex-wrap gap-2 overflow-y-auto pr-1">
                {majorVersions.map((version) => (
                  <VersionChip
                    key={version}
                    version={version}
                    active={installVersion === version}
                    installed={installedSet.has(version)}
                    onClick={() => onSelectInstallVersion(version)}
                    installedLabel={t("install.installed")}
                  />
                ))}
              </div>
            </>
          )}

          {showSnapshots && (
            <div className="flex max-h-72 flex-wrap gap-2 overflow-y-auto pr-1">
              {snapshots.map((version) => (
                <VersionChip
                  key={version}
                  version={version}
                  active={installVersion === version}
                  installed={installedSet.has(version)}
                  onClick={() => onSelectInstallVersion(version)}
                  installedLabel={t("install.installed")}
                />
              ))}
            </div>
          )}
        </Card>

        <Card as="section" variant="strong" className="rounded-2xl p-6">
          <h3 className="mb-5 text-lg font-semibold text-[var(--text-primary)]">{t("install.modloader")}</h3>

          <div className="mb-6 grid grid-cols-3 gap-3">
            {[
              { id: "vanilla", name: t("loader.vanilla"), icon: Box, tone: "text-[var(--text-secondary)]" },
              { id: "forge", name: t("loader.forge"), icon: Layers, tone: "text-amber-400" },
              { id: "fabric", name: t("loader.fabric"), icon: PenTool, tone: "text-cyan-400" }
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => onSelectLoader(item.id as Loader)}
                className={`flex h-28 flex-col items-center justify-center gap-2 rounded-xl border transition-all duration-[var(--duration-normal)] ${
                  loader === item.id
                    ? "border-[var(--mc-grass)]/50 bg-[var(--mc-grass)]/10"
                    : "border-[var(--border-subtle)] bg-[var(--linear-card-bg)] hover:border-[var(--border-medium)]"
                }`}
                type="button"
              >
                <item.icon size={24} className={item.tone} />
                <span
                  className={`text-sm font-medium ${
                    loader === item.id ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
                  }`}
                >
                  {item.name}
                </span>
              </button>
            ))}
          </div>

          {loader !== "vanilla" && (
            <div className="mb-6">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {loaderLoading
                  ? t("install.loadingLoaderVersions", { loader: loaderLabel(loader) })
                  : t("install.selectLoaderVersion", { loader: loaderLabel(loader) })}
              </p>
              <Card variant="soft" className="flex max-h-44 flex-wrap gap-2 overflow-y-auto rounded-xl p-2">
                {loaderOptions.map((version) => (
                  <button
                    key={version}
                    onClick={() => onSelectLoaderVersion(version)}
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      loaderVersion === version
                        ? "border border-[var(--mc-grass)]/45 bg-[var(--mc-grass)]/12 text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)]"
                    }`}
                    type="button"
                  >
                    {version}
                  </button>
                ))}
                {!loaderLoading && loaderOptions.length === 0 && (
                  <p className="px-1 py-2 text-sm text-[var(--text-muted)]">
                    {t("install.noLoaderVersionsSelected", { loader: loaderLabel(loader) })}
                  </p>
                )}
              </Card>
            </div>
          )}

          <Card variant="soft" className="mb-6 rounded-xl p-4 text-sm">
            <p className="mb-1 text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)]">{t("install.versionLabel")}</span>{" "}
              <span className="text-[var(--text-primary)]">{installVersion || "-"}</span>
            </p>
            <p className="text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)]">{t("install.loaderLabel")}</span>{" "}
              <span className="text-[var(--text-primary)]">
                {loader === "vanilla"
                  ? t("loader.vanilla")
                  : `${loaderLabel(loader)} ${loaderVersion || t("install.notSelected")}`}
              </span>
            </p>
          </Card>

          <Button
            variant="primary"
            size="xl"
            fullWidth
            className="w-full justify-center gap-2"
            disabled={installDisabled}
            onClick={onInstall}
          >
            <Plus size={18} />
            {installButtonText}
          </Button>
        </Card>
      </div>
    </div>
  );
}

function VersionChip({
  version,
  active,
  installed,
  onClick,
  installedLabel
}: {
  version: string;
  active: boolean;
  installed: boolean;
  onClick: () => void;
  installedLabel: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`linear-float rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-[var(--mc-grass)]/55 bg-[var(--mc-grass)]/12 text-[var(--text-primary)]"
          : "border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-medium)] hover:text-[var(--text-primary)]"
      }`}
      type="button"
    >
      <span>{version}</span>
      {installed && (
        <span className="ml-2 rounded-md border border-[var(--mc-grass)]/35 bg-[var(--mc-grass)]/8 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--mc-grass)]">
          {installedLabel}
        </span>
      )}
    </button>
  );
}
