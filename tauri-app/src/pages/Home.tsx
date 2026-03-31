import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronRight,
  Gamepad2,
  Lock,
  Play,
  Search,
  Sparkles,
  Users,
  X
} from "lucide-react";
import { createPortal } from "react-dom";
import { useMemo, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type {
  DownloadedLauncherUpdate,
  Instance,
  LauncherAppUpdateInfo,
  LauncherUser,
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

  const presetInstances = filteredInstances.filter((instance) => instance.preset);
  const customInstances = filteredInstances.filter((instance) => !instance.preset);
  const launcherUpdateDate = launcherUpdate?.publishedAt
    ? new Date(launcherUpdate.publishedAt).toLocaleDateString()
    : null;
  const selectedLoaderLabel = selectedInstance ? loaderLabel(selectedInstance.loader, t) : null;
  const launcherOnlineCount = launcherOnlineSummary?.launcher ?? null;
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
      <div className="page-shell flex-1">
        <header className="page-header mb-6">
          <div className="page-header-main">
            <div className="flex flex-wrap items-center gap-2">
              <p className="page-eyebrow">FPSMaster Launcher</p>
              {typeof launcherOnlineCount === "number" && (
                <span className="badge badge-accent">
                  {t("home.onlineTag", { count: launcherOnlineCount })}
                </span>
              )}
            </div>
            <h1 className="page-title">{t("home.welcomeBack")}</h1>
            <p className="page-subtitle">{t("home.dashboardReady")}</p>
          </div>
        </header>

        {launcherUpdate && launcherUpdateAvailable && (
          <section className="mb-5">
            <Card variant="frost" className="page-card rounded-[22px]" interactive={false}>
              <div className="notice notice-warning">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-300" />
                <div className="min-w-0 flex-1">
                  <p className="notice-title">
                    {launcherUpdate.mandatory
                      ? t("home.launcherUpdate.requiredTitle")
                      : t("home.launcherUpdate.availableTitle")}
                  </p>
                  <p className="notice-text">
                    {t("home.launcherUpdate.summary", { version: launcherUpdate.version })}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="badge badge-warning normal-case tracking-normal">
                      {t("settings.launcherUpdateTarget")}: {launcherUpdate.target}
                    </span>
                    <span className="badge badge-muted normal-case tracking-normal">
                      {t("instances.packagePublishedAt")}: {launcherUpdateDate ?? "-"}
                    </span>
                    {launcherUpdateDownload && (
                      <span className="badge badge-muted normal-case tracking-normal">
                        {t("settings.launcherUpdateDownloaded", { file: launcherUpdateDownload.fileName })}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={launcherUpdateDownloading}
                  onClick={onOpenSettings}
                  className="shrink-0"
                >
                  {launcherUpdate.mandatory
                    ? t("home.launcherUpdate.requiredAction")
                    : t("home.launcherUpdate.availableAction")}
                </Button>
              </div>
            </Card>
          </section>
        )}

        <section className="page-grid page-grid-two">
          <Card variant="frost" className="page-card page-card-roomy rounded-[22px]" interactive={false}>
            <div className="section-header">
              <div className="section-header-main">
                <h2 className="section-title flex items-center gap-2">
                  <Calendar size={18} className="text-[var(--mc-grass)]" />
                  {t("home.latestNews")}
                </h2>
                <p className="section-subtitle">{t("home.news.source")}</p>
              </div>
              <div className="section-toolbar">
                <button
                  className="segment-chip px-4 !min-h-10"
                  type="button"
                  onClick={() => setActiveNews(launcherNews[0] ?? null)}
                >
                  {t("home.viewAll")}
                </button>
              </div>
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
                    <Card
                      as="article"
                      variant="soft"
                      className="page-card page-card-compact h-full rounded-[20px]"
                      interactive={false}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`badge ${news.pinned ? "badge-accent" : "badge-muted"}`}>
                          {news.pinned ? t("home.news.pinnedTag") : t("home.news.tag")}
                        </span>
                        {news.publishedAt && (
                          <span className="text-xs text-[var(--text-muted)]">
                            {new Date(news.publishedAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <h3 className="mt-3 text-base font-semibold leading-tight text-[var(--text-primary)]">
                        {news.title}
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                        {news.summary}
                      </p>
                      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--mc-grass)]">
                        {t("home.news.open")}
                      </p>
                    </Card>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <Calendar size={42} className="empty-state-icon" />
                <p className="empty-state-title">{t("home.latestNews")}</p>
                <p className="empty-state-text">{t("home.dashboardReady")}</p>
              </div>
            )}
          </Card>

          <Card variant="frost" className="page-card page-card-roomy rounded-[22px]" interactive={false}>
            <div className="section-header">
              <div className="section-header-main">
                <h2 className="section-title flex items-center gap-2">
                  <Users size={18} className="text-[var(--mc-grass)]" />
                  {t("home.topServers")}
                </h2>
                <p className="section-subtitle">{t("home.moreServers")}</p>
              </div>
            </div>
            {launcherServers.length > 0 ? (
              <div className="surface-list">
                {launcherServers.map((server) => (
                  <button
                    key={server.id ?? server.address}
                    className="surface-list-item w-full text-left"
                    type="button"
                  >
                    <div className="icon-tile h-10 w-10 rounded-[14px]">
                      {server.iconPath ? (
                        <img src={server.iconPath} alt={server.name} className="h-full w-full object-cover" />
                      ) : (
                        server.name.slice(0, 1)
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{server.name}</p>
                      <p className="truncate text-xs text-[var(--text-muted)]">{server.address}</p>
                    </div>
                    <span className="badge badge-muted">{server.mode}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state min-h-[180px]">
                <Users size={40} className="empty-state-icon" />
                <p className="empty-state-title">{t("home.topServers")}</p>
                <p className="empty-state-text">{t("home.dashboardReady")}</p>
              </div>
            )}
          </Card>
        </section>
      </div>

      <footer className="sticky-footer-bar px-4 py-3 md:px-5 xl:px-6">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(260px,320px)] md:items-stretch md:gap-4">
          <button
            className="surface-list-item group min-h-[56px] w-full rounded-[18px] text-left"
            onClick={() => setPickerOpen(true)}
            type="button"
          >
            <div className="icon-tile relative h-8 w-8 rounded-[12px] border-[rgba(var(--accent-rgb),0.24)]">
              {selectedInstanceIcon ? (
                <img src={selectedInstanceIcon} alt={selectedInstance?.name ?? "instance"} className="h-full w-full object-cover" />
              ) : null}
              {selectedInstance && !canAccessInstance(selectedInstance, user) && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                  <Lock size={14} className="text-white/70" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className={`truncate text-sm font-semibold ${selectedInstance && !canAccessInstance(selectedInstance, user) ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
                {selectedInstance ? selectedInstance.name : t("home.noInstance")}
              </p>
              {selectedInstance && (
                <p className="truncate text-[11px] text-[var(--text-muted)]">
                  {[selectedInstance.baseVersion, selectedLoaderLabel, selectedInstance.launcherVersionType]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </div>
            <ChevronRight size={16} className="shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-primary)]" />
          </button>

          <Button
            variant="primary"
            size="lg"
            className="min-h-[56px] w-full justify-center !rounded-[18px]"
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
      </footer>

      {(pickerOpen || pickerClosing) &&
        typeof document !== "undefined" &&
        createPortal(
          <div className={`modal-shell ${pickerClosing ? "modal-backdrop-animate-out" : "modal-backdrop-animate"}`}>
            <Card
              variant="strong"
              className={`${pickerClosing ? "modal-animate-out" : "modal-animate"} modal-card page-card w-full max-w-4xl`}
              interactive={false}
            >
              <div className="modal-header">
                <div>
                  <p className="page-eyebrow">{t("home.selectedInstance")}</p>
                  <h3 className="page-title !mt-1 !text-[30px]">{t("home.instancePickerTitle")}</h3>
                  <p className="page-subtitle !mt-2">{t("home.instancePickerSubtitle")}</p>
                </div>
                <button
                  className="modal-close"
                  onClick={closePicker}
                  type="button"
                  aria-label={t("home.instancePickerClose")}
                >
                  <X size={16} />
                </button>
              </div>

              <label className="search-field mb-4 block">
                <Search className="search-field-icon" size={16} />
                <input
                  value={pickerQuery}
                  onChange={(event) => setPickerQuery(event.target.value)}
                  type="text"
                  className="ui-input"
                  placeholder={t("instances.searchPlaceholder")}
                />
              </label>

              <div className="modal-body pr-1">
                <div className="page-stack">
                  {presetInstances.length > 0 && (
                    <div>
                      <div className="mb-3 flex items-center gap-2 px-1">
                        <Sparkles size={16} className="text-[var(--mc-grass)]" />
                        <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--mc-grass)]">FPSMaster</h4>
                        <span className="badge badge-accent normal-case tracking-normal">{presetInstances.length}</span>
                      </div>
                      <div className="surface-list">
                        {presetInstances.map((instance) => (
                          <InstanceSelectRow
                            key={instance.id}
                            instance={instance}
                            active={selectedInstance?.id === instance.id}
                            selectable={canAccessInstance(instance, user)}
                            user={user}
                            t={t}
                            onSelect={() => {
                              onSelect(instance.id);
                              setPickerOpen(false);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {customInstances.length > 0 && (
                    <div>
                      <div className="mb-3 flex items-center gap-2 px-1">
                        <Gamepad2 size={16} className="text-[var(--text-secondary)]" />
                        <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary)]">
                          {t("nav.myGames")}
                        </h4>
                        <span className="badge badge-muted normal-case tracking-normal">{customInstances.length}</span>
                      </div>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        {customInstances.map((instance) => (
                          <InstanceSelectRow
                            key={instance.id}
                            instance={instance}
                            active={selectedInstance?.id === instance.id}
                            selectable={canAccessInstance(instance, user)}
                            user={user}
                            compact
                            t={t}
                            onSelect={() => {
                              onSelect(instance.id);
                              setPickerOpen(false);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {filteredInstances.length === 0 && (
                  <div className="empty-state mt-2 min-h-[180px]">
                    <Search size={38} className="empty-state-icon" />
                    <p className="empty-state-title">{t("home.noInstance")}</p>
                    <p className="empty-state-text">{t("instances.searchPlaceholder")}</p>
                  </div>
                )}
              </div>
            </Card>
          </div>,
          document.body
        )}

      {(activeNews || newsClosing) &&
        typeof document !== "undefined" &&
        activeNews &&
        createPortal(
          <div className={`modal-shell ${newsClosing ? "modal-backdrop-animate-out" : "modal-backdrop-animate"}`} onClick={closeNews}>
            <Card
              variant="strong"
              className={`${newsClosing ? "modal-animate-out" : "modal-animate"} modal-card page-card w-full max-w-3xl`}
              interactive={false}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <div className="min-w-0">
                  <p className="page-eyebrow">{t("home.news.dialogTitle")}</p>
                  <h3 className="page-title !mt-1 !text-[28px]">{activeNews.title}</h3>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                    {activeNews.publishedAt && <span>{new Date(activeNews.publishedAt).toLocaleString()}</span>}
                    {activeNews.author && <span>{t("home.news.author")} · {activeNews.author}</span>}
                    {activeNews.category && <span className="badge badge-muted normal-case tracking-normal">{activeNews.category}</span>}
                  </div>
                </div>
                <button
                  className="modal-close"
                  onClick={closeNews}
                  type="button"
                  aria-label={t("home.news.dialogClose")}
                >
                  <X size={16} />
                </button>
              </div>

              <div className="modal-body">
                <div className="surface-panel surface-panel-soft rounded-[20px] p-4">
                  <p className="text-sm leading-7 whitespace-pre-wrap text-[var(--text-secondary)]">
                    {activeNewsContent || t("home.news.dialogEmpty")}
                  </p>
                </div>
              </div>
            </Card>
          </div>,
          document.body
        )}
    </div>
  );
}

function InstanceSelectRow({
  instance,
  active,
  selectable,
  user,
  compact = false,
  t,
  onSelect
}: {
  instance: Instance;
  active: boolean;
  selectable: boolean;
  user: LauncherUser | null;
  compact?: boolean;
  t: ReturnType<typeof useI18n>["t"];
  onSelect: () => void;
}) {
  const icon = resolveInstanceIconPath(instance);

  return (
    <button
      onClick={() => {
        if (selectable) {
          onSelect();
        }
      }}
      type="button"
      disabled={!selectable}
      className={`surface-list-item w-full text-left ${active ? "is-active" : ""} ${!selectable ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <div className={`icon-tile relative ${compact ? "h-10 w-10 rounded-[14px]" : ""}`}>
        {icon ? <img src={icon} alt={instance.name} className="h-full w-full object-cover" /> : null}
        {!selectable && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Lock size={compact ? 12 : 14} className="text-white/70" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate ${compact ? "text-sm" : "text-base"} font-semibold ${!selectable ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
          {instance.name}
        </p>
        {compact ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
            <span>{instance.baseVersion}</span>
            <span>·</span>
            <span>{loaderLabel(instance.loader, t)}</span>
            {instance.launcherVersionType && (
              <>
                <span>·</span>
                <span>{instance.launcherVersionType}</span>
              </>
            )}
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="badge badge-accent normal-case tracking-normal">{instance.baseVersion}</span>
            <span className={`badge normal-case tracking-normal ${
              instance.loader === "forge"
                ? "badge-warning"
                : instance.loader === "fabric"
                  ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
                  : "badge-muted"
            }`}>
              {loaderLabel(instance.loader, t)}
            </span>
            {instance.launcherVersionType && (
              <span className="badge badge-muted normal-case tracking-normal">{instance.launcherVersionType}</span>
            )}
          </div>
        )}
      </div>
      {active && selectable && <Check size={compact ? 14 : 16} className="shrink-0 text-[var(--mc-grass)]" />}
      {!selectable && <Lock size={compact ? 12 : 14} className="shrink-0 text-[var(--text-muted)]" />}
    </button>
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
