import { AlertTriangle, Calendar, Check, ChevronRight, Gamepad2, Lock, Play, Search, Sparkles, Users, X } from "lucide-react";
import { createPortal } from "react-dom";
import { type ReactNode, useMemo, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type {
  DownloadedLauncherUpdate,
  Instance,
  LauncherAppUpdateInfo,
  LauncherUser,
  LauncherVersion,
  NewsItem,
  ServerItem,
  TelemetryOnlineSummary
} from "../types";
import { resolveInstanceIconPath } from "../utils/launcher";

type HomePageProps = {
  availableInstances: Instance[];
  launcherNews: NewsItem[];
  launcherServers: ServerItem[];
  launcherOnlineSummary: TelemetryOnlineSummary | null;
  launcherUpdate: LauncherAppUpdateInfo | null;
  launcherUpdateAvailable: boolean;
  launcherUpdateDownloading: boolean;
  launcherUpdateDownload: DownloadedLauncherUpdate | null;
  current: Instance | null;
  busy: boolean;
  launching: boolean;
  launchProgressPercent: number | null;
  launchProgressText: string;
  user: LauncherUser | null;
  onSelect: (id: string) => void;
  onLaunch: () => void;
  onOpenSettings: () => void;
};

function canAccessInstance(instance: Instance, user: LauncherUser | null): boolean {
  if (instance.launcherVersionType === "NOVA") {
    return Boolean(user?.novaBetaEligible);
  }
  return true;
}

export default function HomePage({
  availableInstances,
  launcherNews,
  launcherServers,
  launcherOnlineSummary,
  launcherUpdate,
  launcherUpdateAvailable,
  launcherUpdateDownloading,
  launcherUpdateDownload,
  current,
  busy,
  launching,
  launchProgressPercent,
  launchProgressText,
  user,
  onSelect,
  onLaunch,
  onOpenSettings
}: HomePageProps) {
  const { t } = useI18n();
  const selectedInstance = current ?? availableInstances[0] ?? null;
  const selectedInstanceIcon = selectedInstance ? resolveInstanceIconPath(selectedInstance) : null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerClosing, setPickerClosing] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [activeNews, setActiveNews] = useState<NewsItem | null>(null);
  const [newsClosing, setNewsClosing] = useState(false);

  const filteredInstances = useMemo(() => {
    const keyword = pickerQuery.trim().toLowerCase();
    if (keyword === "") return availableInstances;
    return availableInstances.filter((instance) => {
      return (
        instance.name.toLowerCase().includes(keyword) ||
        instance.versionId.toLowerCase().includes(keyword) ||
        instance.baseVersion.toLowerCase().includes(keyword) ||
        instance.loader.toLowerCase().includes(keyword)
      );
    });
  }, [availableInstances, pickerQuery]);
  const launcherUpdateDate = launcherUpdate?.publishedAt
    ? new Date(launcherUpdate.publishedAt).toLocaleDateString()
    : null;
  const selectedLoaderLabel = selectedInstance ? loaderLabel(selectedInstance.loader, t) : null;
  const launcherOnlineCount = launcherOnlineSummary?.launcher ?? null;
  const onlineBadges = launcherOnlineSummary
    ? [
        t("home.online.total", { count: launcherOnlineSummary.total }),
        t("home.online.launcher", { count: launcherOnlineSummary.launcher }),
        t("home.online.edge", { count: launcherOnlineSummary.edge }),
        t("home.online.nova", { count: launcherOnlineSummary.nova })
      ]
    : [];
  const activeNewsContent = (activeNews?.content ?? activeNews?.summary ?? "").trim();

  const closePicker = () => {
    setPickerClosing(true);
    setTimeout(() => {
      setPickerOpen(false);
      setPickerClosing(false);
    }, 180);
  };

  const closeNews = () => {
    setNewsClosing(true);
    setTimeout(() => {
      setActiveNews(null);
      setNewsClosing(false);
    }, 150);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 md:p-5 xl:p-6">
        <section className="mb-5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">FPSMaster Launcher</p>
            {typeof launcherOnlineCount === "number" && (
              <span className="rounded-md bg-[var(--mc-grass)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--mc-grass)]">
                {t("home.onlineTag", { count: launcherOnlineCount })}
              </span>
            )}
            {onlineBadges.slice(0, 3).map((badge) => (
              <span
                key={badge}
                className="rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]"
              >
                {badge}
              </span>
            ))}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)] md:text-3xl">{t("home.welcomeBack")}</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)] md:text-[15px]">{t("home.dashboardReady")}</p>
        </section>

        {launcherUpdate && launcherUpdateAvailable && (
          <section className="mb-4">
            <Card variant="frost" className="rounded-xl border border-amber-500/25 bg-amber-500/8 p-4 md:p-5" interactive={false}>
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                    <AlertTriangle size={16} className="text-amber-300" />
                    {launcherUpdate.mandatory
                      ? t("home.launcherUpdate.requiredTitle")
                      : t("home.launcherUpdate.availableTitle")}
                  </div>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {t("home.launcherUpdate.summary", { version: launcherUpdate.version })}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--text-muted)]">
                    <span>{t("settings.launcherUpdateTarget")}: {launcherUpdate.target}</span>
                    <span>{t("instances.packagePublishedAt")}: {launcherUpdateDate ?? "-"}</span>
                    {launcherUpdateDownload && <span>{t("settings.launcherUpdateDownloaded", { file: launcherUpdateDownload.fileName })}</span>}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={launcherUpdateDownloading}
                  onClick={onOpenSettings}
                >
                  {launcherUpdate.mandatory
                    ? t("home.launcherUpdate.requiredAction")
                    : t("home.launcherUpdate.availableAction")}
                </Button>
              </div>
            </Card>
          </section>
        )}

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.92fr)]">
          <div>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
                <Calendar size={16} className="text-[var(--mc-grass)]" />
                {t("home.latestNews")}
              </h2>
              <button
                className="text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                type="button"
                onClick={() => setActiveNews(launcherNews[0] ?? null)}
              >
                {t("home.viewAll")}
              </button>
            </div>
            {launcherNews.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {launcherNews.map((news) => (
                  <button
                    key={news.id ?? news.title}
                    type="button"
                    className="text-left"
                    onClick={() => setActiveNews(news)}
                  >
                    <Card as="article" variant="soft" className="group h-full rounded-xl p-4" interactive={false}>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <div className="inline-flex items-center rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                        {news.pinned ? t("home.news.pinnedTag") : t("home.news.tag")}
                      </div>
                      {news.publishedAt && (
                        <span className="text-[11px] text-[var(--text-muted)]">
                          {new Date(news.publishedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <h3 className="text-base font-semibold leading-tight text-[var(--text-primary)] transition-colors group-hover:text-[var(--mc-grass)]">
                      {news.title}
                    </h3>
                    <p className="mt-1.5 text-sm leading-6 text-[var(--text-secondary)]">
                      {news.summary}
                    </p>
                    <p className="mt-3 text-xs font-medium text-[var(--mc-grass)]">{t("home.news.open")}</p>
                    </Card>
                  </button>
                ))}
              </div>
            ) : (
              <Card variant="soft" className="rounded-xl border border-dashed p-5 text-sm text-[var(--text-secondary)]" interactive={false}>
                {t("home.dashboardReady")}
              </Card>
            )}
          </div>

          <div className="space-y-4">
            <Card variant="frost" className="rounded-xl p-3.5 md:p-4" interactive={false}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <Users size={16} className="text-[var(--mc-grass)]" />
                {t("home.topServers")}
              </h2>
              {launcherServers.length > 0 ? (
                <div className="space-y-1.5">
                  {launcherServers.map((server) => (
                    <button
                      key={server.id ?? server.address}
                      className="linear-float flex min-h-11 w-full cursor-pointer items-center rounded-lg border border-transparent px-2.5 py-2 text-left transition-all duration-[var(--duration-normal)] hover:border-white/5 hover:bg-[var(--surface-soft)]"
                      type="button"
                    >
                      <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-md bg-[var(--bg-elevated)] text-[10px] font-semibold uppercase text-[var(--text-muted)]">
                        {server.iconPath ? <img src={server.iconPath} alt={server.name} className="h-full w-full object-cover" /> : server.name.slice(0, 1)}
                      </div>
                      <div className="ml-2.5 min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{server.name}</p>
                        <p className="truncate text-[11px] text-[var(--text-muted)]">{server.address}</p>
                      </div>
                      <span className="rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                        {server.mode}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-white/5 px-3 py-4 text-center text-xs text-[var(--text-muted)]">
                  {t("home.dashboardReady")}
                </div>
              )}
              <button className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]" type="button">
                {t("home.moreServers")} <ChevronRight size={12} />
              </button>
            </Card>
          </div>
        </section>
      </div>

      <footer className="border-t border-white/5 bg-[var(--bg-secondary)]/86 px-4 py-3 backdrop-blur-xl md:px-5 xl:px-6">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(240px,300px)] md:items-center md:gap-4">
          <button
            className="group flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-xl border border-white/5 bg-[var(--surface-soft)] px-4 py-2 text-left transition-all hover:border-white/20 hover:bg-[var(--bg-elevated)] hover:shadow-lg"
            onClick={() => setPickerOpen(true)}
            type="button"
          >
            <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-xl border-2 border-[#25b87a]/30 bg-[var(--bg-elevated)] shadow-sm">
              {selectedInstanceIcon ? <img src={selectedInstanceIcon} alt={selectedInstance?.name ?? "instance"} className="h-full w-full object-cover" /> : null}
              {selectedInstance && !canAccessInstance(selectedInstance, user) && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                  <Lock size={12} className="text-white/70" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <p className={`truncate text-sm font-semibold ${selectedInstance && !canAccessInstance(selectedInstance, user) ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
                  {selectedInstance ? selectedInstance.name : t("home.noInstance")}
                </p>
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                  {selectedInstance && (
                    <>
                      <span className="rounded-md bg-[var(--mc-grass)]/10 px-1.5 py-0.5 font-semibold text-[var(--mc-grass)]">{selectedInstance.baseVersion}</span>
                      <span className={`rounded-md px-1.5 py-0.5 font-semibold ${
                        selectedInstance.loader === "forge"
                          ? "bg-amber-500/10 text-amber-400"
                          : selectedInstance.loader === "fabric"
                            ? "bg-cyan-500/10 text-cyan-400"
                            : "bg-white/10 text-[var(--text-secondary)]"
                      }`}>{selectedLoaderLabel}</span>
                      {selectedInstance.launcherVersionType && (
                        <span className="rounded-md bg-white/10 px-1.5 py-0.5 font-semibold text-[var(--text-secondary)]">{selectedInstance.launcherVersionType}</span>
                      )}
                    </>
                  )}
                  <ChevronRight size={14} className="text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-colors" />
                </div>
              </div>
            </div>
          </button>

          <div className="relative flex items-center">
            <Button
              variant="primary"
              size="lg"
              className="w-full justify-center"
              disabled={busy || !selectedInstance || !canAccessInstance(selectedInstance, user)}
              launchProgress={launching}
              launchProgressPercent={launchProgressPercent}
              onClick={onLaunch}
            >
              <span className="flex w-full flex-col items-center justify-center text-center leading-tight">
                <span className="flex items-center justify-center gap-2.5">
                  <Play fill="currentColor" size={16} />
                  {launching
                    ? `${t("home.launching")}${typeof launchProgressPercent === "number" ? ` ${launchProgressPercent}%` : ""}`
                    : t("home.launch")}
                </span>
                {launching && (
                  <span className="mt-1 text-[11px] font-medium text-white/85">
                    {launchProgressText || t("launch.progress.preparing")}
                  </span>
                )}
              </span>
            </Button>
          </div>
        </div>
      </footer>

      {(pickerOpen || pickerClosing) &&
        typeof document !== "undefined" &&
        createPortal(
          <div className={`fixed inset-0 z-[90] flex items-center justify-center bg-[var(--bg-primary)]/66 p-4 backdrop-blur-xl ${pickerClosing ? "modal-backdrop-animate-out" : "modal-backdrop-animate"}`}>
            <Card variant="strong" className={`${pickerClosing ? "modal-animate-out" : "modal-animate"} flex h-[78vh] w-full max-w-4xl min-h-[420px] max-h-[720px] flex-col rounded-2xl p-4 md:p-5`} interactive={false}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold text-[var(--text-primary)]">{t("home.instancePickerTitle")}</h3>
                  <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{t("home.instancePickerSubtitle")}</p>
                </div>
                <button
                  className="min-h-10 rounded-lg bg-[var(--surface-soft)] p-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                  onClick={closePicker}
                  type="button"
                  aria-label={t("home.instancePickerClose")}
                >
                  <X size={16} />
                </button>
              </div>

              <label className="relative mb-3 block">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={15} />
                <input
                  value={pickerQuery}
                  onChange={(event) => setPickerQuery(event.target.value)}
                  type="text"
                  className="min-h-10 w-full rounded-lg border border-white/5 bg-[var(--bg-secondary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
                  placeholder={t("instances.searchPlaceholder")}
                />
              </label>

              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <div className="space-y-4">
                  {/* FPSMaster Instances Section */}
                  {filteredInstances.filter(i => i.preset).length > 0 && (
                    <div>
                      <div className="mb-2 flex items-center gap-2 px-1">
                        <Sparkles size={14} className="text-[var(--mc-grass)]" />
                        <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--mc-grass)]">FPSMaster</h4>
                      </div>
                      <div className="space-y-2">
                        {filteredInstances.filter(i => i.preset).map((instance) => {
                          const active = selectedInstance?.id === instance.id;
                          const icon = resolveInstanceIconPath(instance);
                          const canAccess = canAccessInstance(instance, user);
                          return (
                            <button
                              key={instance.id}
                              onClick={() => {
                                if (canAccess) {
                                  onSelect(instance.id);
                                  setPickerOpen(false);
                                }
                              }}
                              type="button"
                              disabled={!canAccess}
                              className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-4 py-2.5 text-left transition-all ${
                                !canAccess
                                  ? "cursor-not-allowed border-white/5 bg-[var(--surface-soft)] opacity-50"
                                  : active
                                    ? "cursor-pointer border-[#25b87a]/50 bg-[#25b87a]/12 shadow-[0_0_20px_rgba(37,184,122,0.15)]"
                                    : "cursor-pointer border-white/5 bg-[var(--surface-soft)] hover:border-[#25b87a]/30 hover:bg-[var(--bg-elevated)]"
                              }`}
                            >
                              <div className="relative h-11 w-11 overflow-hidden rounded-xl border-2 border-[#25b87a]/30 bg-[var(--bg-elevated)] shadow-sm">
                                {icon ? <img src={icon} alt={instance.name} className="h-full w-full object-cover" /> : null}
                                {!canAccess && (
                                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                                    <Lock size={14} className="text-white/70" />
                                  </div>
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className={`truncate text-base font-bold ${!canAccess ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
                                  {instance.name}
                                </p>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                                  <span className="rounded-md bg-[var(--mc-grass)]/10 px-2 py-0.5 font-semibold text-[var(--mc-grass)]">{instance.baseVersion}</span>
                                  <span className={`rounded-md px-2 py-0.5 font-semibold ${
                                    instance.loader === "forge"
                                      ? "bg-amber-500/10 text-amber-400"
                                      : instance.loader === "fabric"
                                        ? "bg-cyan-500/10 text-cyan-400"
                                        : "bg-white/10 text-[var(--text-secondary)]"
                                  }`}>{loaderLabel(instance.loader, t)}</span>
                                  {instance.launcherVersionType && (
                                    <span className="rounded-md bg-white/10 px-2 py-0.5 font-semibold text-[var(--text-secondary)]">{instance.launcherVersionType}</span>
                                  )}
                                </div>
                              </div>
                              {active && canAccess && <Check size={16} className="text-[var(--mc-grass)]" />}
                              {!canAccess && <Lock size={14} className="text-[var(--text-muted)]" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Other Instances Section */}
                  {filteredInstances.filter(i => !i.preset).length > 0 && (
                    <div>
                      <div className="mb-2 flex items-center gap-2 px-1">
                        <Gamepad2 size={14} className="text-[var(--text-muted)]" />
                        <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">其他实例</h4>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {filteredInstances.filter(i => !i.preset).map((instance) => {
                          const active = selectedInstance?.id === instance.id;
                          const icon = resolveInstanceIconPath(instance);
                          const canAccess = canAccessInstance(instance, user);
                          return (
                            <button
                              key={instance.id}
                              onClick={() => {
                                if (canAccess) {
                                  onSelect(instance.id);
                                  setPickerOpen(false);
                                }
                              }}
                              type="button"
                              disabled={!canAccess}
                              className={`flex min-h-14 w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-all ${
                                !canAccess
                                  ? "cursor-not-allowed border-white/5 bg-[var(--surface-soft)] opacity-50"
                                  : active
                                    ? "cursor-pointer border-[rgba(var(--accent-rgb),0.36)] bg-[rgba(var(--accent-rgb),0.14)]"
                                    : "cursor-pointer border-white/5 bg-[var(--surface-soft)] hover:border-white/20 hover:bg-[var(--bg-elevated)]"
                              }`}
                            >
                              <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-white/5 bg-[var(--bg-elevated)]">
                                {icon ? <img src={icon} alt={instance.name} className="h-full w-full object-cover" /> : null}
                                {!canAccess && (
                                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                                    <Lock size={12} className="text-white/70" />
                                  </div>
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className={`truncate text-sm font-semibold ${!canAccess ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
                                  {instance.name}
                                </p>
                                <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-[var(--text-muted)]">
                                  <span>{instance.baseVersion}</span>
                                  <span>·</span>
                                  <span className={instance.loader === "forge" ? "text-amber-400" : instance.loader === "fabric" ? "text-cyan-400" : ""}>
                                    {loaderLabel(instance.loader, t)}
                                  </span>
                                  {instance.launcherVersionType && (
                                    <>
                                      <span>·</span>
                                      <span>{instance.launcherVersionType}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                              {active && canAccess && <Check size={14} className="text-[var(--mc-grass)] shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                {filteredInstances.length === 0 && (
                  <p className="pt-3 text-sm text-[var(--text-muted)]">{t("home.noInstance")}</p>
                )}
              </div>
            </Card>
          </div>,
          document.body
        )}

      {(activeNews || newsClosing) &&
        typeof document !== "undefined" &&
        createPortal(
          <div className={`fixed inset-0 z-[92] flex items-center justify-center bg-[var(--bg-primary)]/72 p-4 backdrop-blur-xl ${newsClosing ? "modal-backdrop-animate-out" : "modal-backdrop-animate"}`}>
            <Card variant="strong" className={`${newsClosing ? "modal-animate-out" : "modal-animate"} flex h-[78vh] w-full max-w-3xl min-h-[380px] max-h-[760px] flex-col rounded-2xl p-4 md:p-5`} interactive={false}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">{t("home.news.dialogTitle")}</p>
                  <h3 className="mt-1 text-xl font-semibold text-[var(--text-primary)]">{activeNews.title}</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                    {activeNews.publishedAt && <span>{new Date(activeNews.publishedAt).toLocaleString()}</span>}
                    {activeNews.author && <span>{t("home.news.author")} · {activeNews.author}</span>}
                    {activeNews.category && <span>{activeNews.category}</span>}
                  </div>
                </div>
                <button
                  className="min-h-10 rounded-lg bg-[var(--surface-soft)] p-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                  onClick={closeNews}
                  type="button"
                  aria-label={t("home.news.dialogClose")}
                >
                  <X size={16} />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-[var(--surface-soft)] p-4">
                <p className="text-sm leading-7 whitespace-pre-wrap text-[var(--text-secondary)]">
                  {activeNewsContent || t("home.news.dialogEmpty")}
                </p>
              </div>
            </Card>
          </div>,
          document.body
        )}
    </div>
  );
}

function MetaBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
      {children}
    </span>
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
