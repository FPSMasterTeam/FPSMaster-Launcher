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
    <div className="h-full overflow-y-auto p-4 md:p-5 xl:p-6">
      <header className="mb-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">{t("install.title")}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">{t("install.subtitle")}</h1>
        </div>
        <Card variant="frost" className="rounded-full px-4 py-2 text-sm text-[var(--text-secondary)]">
          {catalogLoading ? t("install.syncing") : t("install.versionCount", { count: catalogCount })}
        </Card>
      </header>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Card as="section" variant="frost" className="rounded-xl p-4 md:p-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t("install.selectVersion")}</h2>
            <Card variant="soft" className="flex rounded-xl p-1">
              <button
                onClick={() => {
                  if (showSnapshots) onToggleSnapshots();
                }}
                className={`min-h-11 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  !showSnapshots ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
                type="button"
              >
                {t("install.releases")}
              </button>
              <button
                onClick={() => {
                  if (!showSnapshots) onToggleSnapshots();
                }}
                className={`min-h-11 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  showSnapshots ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
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
                    className={`min-h-11 rounded-xl border px-3 py-1.5 text-sm transition-colors ${
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
              <div className="flex max-h-[360px] flex-wrap gap-2 overflow-y-auto pr-1">
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
            <div className="flex max-h-[360px] flex-wrap gap-2 overflow-y-auto pr-1">
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

        <Card as="section" variant="strong" className="rounded-xl p-4 md:p-5">
          <h2 className="mb-5 text-lg font-semibold text-[var(--text-primary)]">{t("install.modloader")}</h2>

          <div className="mb-6 grid grid-cols-3 gap-3">
            {[
              { id: "vanilla", name: t("loader.vanilla"), icon: Box, tone: "text-[var(--text-secondary)]" },
              { id: "forge", name: t("loader.forge"), icon: Layers, tone: "text-amber-400" },
              { id: "fabric", name: t("loader.fabric"), icon: PenTool, tone: "text-cyan-400" }
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => onSelectLoader(item.id as Loader)}
                className={`min-h-28 rounded-2xl border px-2 py-3 transition-all duration-[var(--duration-normal)] ${
                  loader === item.id
                    ? "border-[var(--mc-grass)]/50 bg-[var(--mc-grass)]/10"
                    : "border-[var(--border-subtle)] bg-[var(--linear-card-bg)] hover:border-[var(--border-medium)]"
                }`}
                type="button"
              >
                <div className="flex flex-col items-center justify-center gap-2">
                  <item.icon size={24} className={item.tone} />
                  <span className={`text-sm font-medium ${loader === item.id ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
                    {item.name}
                  </span>
                </div>
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
                    className={`min-h-11 rounded-lg px-3 py-1.5 text-sm transition-colors ${
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

          <Card variant="soft" className="mb-6 rounded-2xl p-4 text-sm" interactive={false}>
            <p className="mb-1 text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)]">{t("install.versionLabel")}</span>{" "}
              <span className="text-[var(--text-primary)]">{installVersion || "-"}</span>
            </p>
            <p className="text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)]">{t("install.loaderLabel")}</span>{" "}
              <span className="text-[var(--text-primary)]">
                {loader === "vanilla" ? t("loader.vanilla") : `${loaderLabel(loader)} ${loaderVersion || t("install.notSelected")}`}
              </span>
            </p>
          </Card>

          <Button variant="primary" size="xl" fullWidth className="w-full justify-center gap-2" disabled={installDisabled} onClick={onInstall}>
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
      className={`linear-float min-h-11 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
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
