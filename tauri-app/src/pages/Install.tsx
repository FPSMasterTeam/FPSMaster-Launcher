import { Box, Eye, Layers, PenTool, Plus } from "lucide-react";
import { memo, useMemo } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type { Loader, OptiFineVersion } from "../types";

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
  optiFineEnabled: boolean;
  optiFineLoading: boolean;
  optiFineOptions: OptiFineVersion[];
  optiFineVersion: string;
  optiFineDisabledReason: string;
  installedVersions: string[];
  installDisabled: boolean;
  installButtonText: string;
  onSelectMajor: (major: string) => void;
  onToggleSnapshots: () => void;
  onSelectInstallVersion: (version: string) => void;
  onSelectLoader: (loader: Loader) => void;
  onSelectLoaderVersion: (version: string) => void;
  onToggleOptiFine: () => void;
  onSelectOptiFineVersion: (version: string) => void;
  onInstall: () => void;
};

function InstallPage({
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
  optiFineEnabled,
  optiFineLoading,
  optiFineOptions,
  optiFineVersion,
  optiFineDisabledReason,
  installedVersions,
  installDisabled,
  installButtonText,
  onSelectMajor,
  onToggleSnapshots,
  onSelectInstallVersion,
  onSelectLoader,
  onSelectLoaderVersion,
  onToggleOptiFine,
  onSelectOptiFineVersion,
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
    <div className="page-shell">
      <header className="page-header mb-6">
        <div className="page-header-main">
          <p className="page-eyebrow">{t("nav.myGames")}</p>
          <h1 className="page-title">{t("install.title")}</h1>
          <p className="page-subtitle">{t("install.subtitle")}</p>
        </div>
        <Card variant="frost" className="page-card page-card-compact rounded-full px-4 py-2 text-sm text-[var(--text-secondary)]" interactive={false}>
          {catalogLoading ? t("install.syncing") : t("install.versionCount", { count: catalogCount })}
        </Card>
      </header>

      <div className="page-grid page-grid-two">
        <Card as="section" variant="frost" className="page-card" interactive={false}>
          <div className="section-header">
            <div className="section-header-main">
              <h2 className="section-title">{t("install.selectVersion")}</h2>
              <p className="section-subtitle">{showSnapshots ? t("install.snapshots") : t("install.releases")}</p>
            </div>
            <Card variant="soft" className="segment-control rounded-[18px] p-1" interactive={false}>
              <button
                onClick={() => {
                  if (showSnapshots) onToggleSnapshots();
                }}
                className={`segment-chip ${!showSnapshots ? "is-active" : ""}`}
                type="button"
              >
                {t("install.releases")}
              </button>
              <button
                onClick={() => {
                  if (!showSnapshots) onToggleSnapshots();
                }}
                className={`segment-chip ${showSnapshots ? "is-active" : ""}`}
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
                    className={`badge min-h-11 rounded-2xl px-4 py-2 text-sm normal-case tracking-normal ${
                      major === item
                        ? "badge-accent text-[var(--text-primary)]"
                        : "badge-muted hover:border-[var(--border-medium)] hover:text-[var(--text-primary)]"
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

        <Card as="section" variant="strong" className="page-card" interactive={false}>
          <div className="section-header">
            <div className="section-header-main">
              <h2 className="section-title">{t("install.modloader")}</h2>
              <p className="section-subtitle">{t("install.loaderLabel")}</p>
            </div>
          </div>

          <div className="mb-6 grid grid-cols-3 gap-3">
            {[
              { id: "vanilla", name: t("loader.vanilla"), icon: Box, tone: "text-[var(--text-secondary)]" },
              { id: "forge", name: t("loader.forge"), icon: Layers, tone: "text-amber-400" },
              { id: "fabric", name: t("loader.fabric"), icon: PenTool, tone: "text-cyan-400" }
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => onSelectLoader(item.id as Loader)}
                className={`surface-panel min-h-28 rounded-[20px] px-2 py-3 transition-all duration-[var(--duration-normal)] ${
                  loader === item.id
                    ? "border-[rgba(var(--accent-rgb),0.3)] bg-[rgba(var(--accent-rgb),0.1)]"
                    : "hover:border-[var(--border-medium)] hover:bg-[rgba(255,255,255,0.05)]"
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
              <p className="field-label !mb-2">
                {loaderLoading
                  ? t("install.loadingLoaderVersions", { loader: loaderLabel(loader) })
                  : t("install.selectLoaderVersion", { loader: loaderLabel(loader) })}
              </p>
              <Card variant="soft" className="surface-panel surface-panel-soft flex max-h-[320px] flex-wrap content-start gap-2 overflow-y-auto rounded-[18px] p-2 pr-3" interactive={false}>
                {loaderOptions.map((version) => (
                  <button
                    key={version}
                    onClick={() => onSelectLoaderVersion(version)}
                    className={`badge min-h-11 rounded-2xl px-4 py-2 text-sm normal-case tracking-normal ${
                      loaderVersion === version
                        ? "badge-accent text-[var(--text-primary)]"
                        : "badge-muted hover:border-[var(--border-medium)] hover:text-[var(--text-primary)]"
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

          <div className="mb-6">
            <div className="section-header !mb-3">
              <div className="section-header-main">
                <h2 className="section-title">{t("install.optifine")}</h2>
                <p className="section-subtitle">{t("install.optifineSubtitle")}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onToggleOptiFine}
              disabled={Boolean(optiFineDisabledReason)}
              className={`surface-panel flex w-full items-center justify-between gap-3 rounded-[20px] px-4 py-4 text-left transition-all duration-[var(--duration-normal)] ${
                optiFineEnabled
                  ? "border-[rgba(var(--accent-rgb),0.3)] bg-[rgba(var(--accent-rgb),0.1)]"
                  : "hover:border-[var(--border-medium)] hover:bg-[rgba(255,255,255,0.05)]"
              } ${optiFineDisabledReason ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <span className="flex items-center gap-3">
                <Eye size={22} className="text-lime-300" />
                <span>
                  <span className="block text-sm font-semibold text-[var(--text-primary)]">{t("loader.optifine")}</span>
                  <span className="block text-xs text-[var(--text-muted)]">
                    {optiFineDisabledReason || t("install.optifineHint")}
                  </span>
                </span>
              </span>
              <span className={`badge rounded-full px-3 py-1 text-xs ${optiFineEnabled ? "badge-accent" : "badge-muted"}`}>
                {optiFineEnabled ? t("install.enabled") : t("install.disabled")}
              </span>
            </button>
          </div>

          {optiFineEnabled && (
            <div className="mb-6">
              <p className="field-label !mb-2">
                {optiFineLoading
                  ? t("install.loadingLoaderVersions", { loader: t("loader.optifine") })
                  : t("install.selectLoaderVersion", { loader: t("loader.optifine") })}
              </p>
              <Card variant="soft" className="surface-panel surface-panel-soft flex max-h-44 flex-wrap gap-2 overflow-y-auto rounded-[18px] p-2" interactive={false}>
                {optiFineOptions.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => onSelectOptiFineVersion(item.version)}
                    disabled={item.compatibility === "incompatible"}
                    title={item.incompatibilityReason ?? undefined}
                    className={`badge min-h-11 rounded-2xl px-4 py-2 text-sm normal-case tracking-normal ${
                      optiFineVersion === item.version
                        ? "badge-accent text-[var(--text-primary)]"
                        : item.compatibility === "incompatible"
                          ? "badge-muted cursor-not-allowed opacity-50"
                          : "badge-muted hover:border-[var(--border-medium)] hover:text-[var(--text-primary)]"
                    }`}
                    type="button"
                  >
                    {item.version}
                  </button>
                ))}
                {!optiFineLoading && optiFineOptions.length === 0 && (
                  <p className="px-1 py-2 text-sm text-[var(--text-muted)]">
                    {t("install.noLoaderVersionsSelected", { loader: t("loader.optifine") })}
                  </p>
                )}
              </Card>
            </div>
          )}

          <Card variant="soft" className="surface-panel surface-panel-soft mb-6 rounded-[20px] p-4 text-sm" interactive={false}>
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
            {optiFineEnabled && (
              <p className="mt-1 text-[var(--text-secondary)]">
                <span className="text-[var(--text-muted)]">{t("loader.optifine")}</span>{" "}
                <span className="text-[var(--text-primary)]">{optiFineVersion || t("install.notSelected")}</span>
              </p>
            )}
          </Card>

          <Button variant="primary" size="xl" fullWidth className="w-full justify-center gap-2 !rounded-2xl" disabled={installDisabled} onClick={onInstall}>
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
      className={`linear-float badge min-h-11 rounded-2xl px-4 py-2 text-sm font-medium normal-case tracking-normal ${
        active
          ? "badge-accent text-[var(--text-primary)]"
          : "border-white/5 bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-white/10 hover:text-[var(--text-primary)]"
      }`}
      type="button"
    >
      <span>{version}</span>
      {installed && (
        <span className="badge badge-success ml-2 rounded-full px-2 py-1 text-[10px]">
          {installedLabel}
        </span>
      )}
    </button>
  );
}

export default memo(InstallPage);
