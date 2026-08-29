import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Calendar,
  Check,
  ChevronRight,
  Clock,
  Gamepad2,
  Lock,
  Play,
  Search,
  Swords,
  TrendingUp,
  X,
  Zap
} from "lucide-react";
import { createPortal } from "react-dom";
import { memo, useMemo, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import LiquidGlass from "../components/LiquidGlass";
import { NOVA_DEFAULT_GAME_VERSION } from "../constants";
import MinecraftProfileCard from "../components/MinecraftProfileCard";
import ServerDialog from "../components/ServerDialog";
import { useI18n } from "../i18n";
import type {
  DownloadedLauncherUpdate,
  Instance,
  LauncherAppUpdateInfo,
  LauncherDashboard,
  LauncherVersion,
  MinecraftAccount,
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
  launcherDashboard: LauncherDashboard | null;
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
  novaGameVersions: Record<string, LauncherVersion>;
  selectedNovaGameVersion: string;
  onSelectNovaGameVersion: (gameVersion: string) => void;
  minecraftAccounts: MinecraftAccount[];
  currentMinecraftAccount: MinecraftAccount | null;
  minecraftAccountRequired: boolean;
  onSelect: (id: string) => void;
  onLaunch: () => void;
  onLaunchToServer: (serverAddress: string) => void;
  onOpenSettings: () => void;
  onOpenServers: () => void;
  onSelectMinecraftAccount: (accountId: string) => void;
  onAddOfflineMinecraftAccount: (username: string) => void;
  onSaveMicrosoftMinecraftAccount: (account: MinecraftAccount) => void;
  onDeleteMinecraftAccount: (accountId: string) => void;
};

function canAccessInstance(_instance: Instance, _user: LauncherUser | null): boolean {
  // All client instances (Edge/Nova/Extreme) are open to every user. Channel-level entitlements
  // Catalog entitlement is enforced by the backend (product groups / rollout). Beta and
  // release client channels are open to every authenticated account.
  // returns the versions a user may access from /launcher/versions/available.
  return true;
}

function HomePage({
  availableInstances,
  launcherNews,
  launcherServers,
  launcherOnlineSummary,
  launcherDashboard,
  launcherUpdate,
  launcherUpdateAvailable,
  launcherUpdateDownloading,
  launcherUpdateDownload,
  current,
  busy,
  launching,
  launchProgressPercent,
  user,
  novaGameVersions,
  selectedNovaGameVersion,
  onSelectNovaGameVersion,
  minecraftAccounts,
  currentMinecraftAccount,
  minecraftAccountRequired,
  onSelect,
  onLaunch,
  onLaunchToServer,
  onOpenSettings,
  onOpenServers,
  onSelectMinecraftAccount,
  onAddOfflineMinecraftAccount,
  onSaveMicrosoftMinecraftAccount,
  onDeleteMinecraftAccount
}: HomePageProps) {
  const { t } = useI18n();
  const selectedInstance = current ?? availableInstances[0] ?? null;
  const selectedInstanceIcon = selectedInstance ? resolveInstanceIconPath(selectedInstance) : null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerClosing, setPickerClosing] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [activeNews, setActiveNews] = useState<NewsItem | null>(null);
  const [newsClosing, setNewsClosing] = useState(false);
  const [activeServer, setActiveServer] = useState<ServerItem | null>(null);
  const [serverClosing, setServerClosing] = useState(false);

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

  const presetInstances = useMemo(
    () => filteredInstances.filter((instance) => instance.preset),
    [filteredInstances]
  );
  const customInstances = useMemo(
    () => filteredInstances.filter((instance) => !instance.preset),
    [filteredInstances]
  );
  // Nova is a single "region" preset that fans out into multiple selectable game versions.
  const novaPreset = useMemo(
    () => availableInstances.find((instance) => instance.preset && instance.launcherVersionType === "NOVA") ?? null,
    [availableInstances]
  );
  const presetRegions = useMemo(
    () => presetInstances.filter((instance) => instance.launcherVersionType !== "NOVA"),
    [presetInstances]
  );
  const novaVersionList = useMemo(() => {
    return Object.entries(novaGameVersions)
      .map(([gameVersion, version]) => ({ gameVersion, version }))
      .sort((a, b) => {
        if (Boolean(a.version.recommended) !== Boolean(b.version.recommended)) {
          return a.version.recommended ? -1 : 1;
        }
        return compareGameVersions(b.gameVersion, a.gameVersion);
      });
  }, [novaGameVersions]);
  const filteredNovaVersions = useMemo(() => {
    const keyword = pickerQuery.trim().toLowerCase();
    if (keyword === "") return novaVersionList;
    if ("nova".includes(keyword)) return novaVersionList;
    return novaVersionList.filter(({ gameVersion }) => gameVersion.toLowerCase().includes(keyword));
  }, [novaVersionList, pickerQuery]);
  // When the catalog hasn't loaded yet (or nothing matches an empty query), still offer the current
  // pick so Nova stays launchable — the launch flow refreshes the catalog on demand.
  const novaRows = useMemo(() => {
    if (filteredNovaVersions.length > 0) return filteredNovaVersions;
    if (pickerQuery.trim() === "" && novaPreset) {
      return [{ gameVersion: selectedNovaGameVersion, version: null as LauncherVersion | null }];
    }
    return [];
  }, [filteredNovaVersions, pickerQuery, novaPreset, selectedNovaGameVersion]);
  const launcherUpdateDate = launcherUpdate?.publishedAt
    ? new Date(launcherUpdate.publishedAt).toLocaleDateString()
    : null;
  const selectedLoaderLabel = selectedInstance ? loaderLabel(selectedInstance.loader, t) : null;
  // Nova shows the picked game version rather than the preset's fixed default baseVersion.
  const selectedBaseVersion = selectedInstance
    ? selectedInstance.launcherVersionType === "NOVA"
      ? selectedNovaGameVersion
      : selectedInstance.baseVersion
    : null;
  // Only the default game version (1.21.11) is full-featured; every other Nova version is testing.
  const novaSelectedIsTesting =
    selectedInstance?.launcherVersionType === "NOVA" && selectedNovaGameVersion !== NOVA_DEFAULT_GAME_VERSION;
  const activeNewsContent = (activeNews?.content ?? activeNews?.summary ?? "").trim();

  const instanceLaunchable = Boolean(selectedInstance) && canAccessInstance(selectedInstance as Instance, user);
  const quickJoinDisabled = busy || launching || !instanceLaunchable;
  const launchAsName = currentMinecraftAccount?.username ?? t("nav.player");
  const isOfflineAccount = !currentMinecraftAccount || currentMinecraftAccount.type === "offline";
  const quickServers = useMemo(() => launcherServers.slice(0, 10), [launcherServers]);

  const weeklyHours = launcherDashboard?.weeklyPlaytime?.totalHours ?? 0;
  const sessionCount = launcherDashboard?.stats?.playSessionCount ?? 0;
  const levelLabel = resolveHomeLevel(user);
  const experience = typeof user?.experience === "number" ? user.experience : null;
  const nextLevelNeed = typeof user?.nextLevelNeed === "number" ? user.nextLevelNeed : null;
  const expPercent =
    experience !== null && nextLevelNeed && nextLevelNeed > 0
      ? Math.min(100, Math.round((experience / nextLevelNeed) * 100))
      : null;
  const expText = experience !== null && nextLevelNeed ? `${experience}/${nextLevelNeed}` : null;

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

  const closeServer = () => {
    setServerClosing(true);
    setTimeout(() => {
      setActiveServer(null);
      setServerClosing(false);
    }, 150);
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="page-shell flex-1">
        <header className="page-header mb-6">
          <div className="page-header-main">
            <p className="page-eyebrow">{t("home.welcomeBack")}</p>
            <h1 className="page-title">{t("home.loadout.ready")}</h1>
            {launcherOnlineSummary && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="badge badge-accent">
                  {t("home.online.launcher", { count: launcherOnlineSummary.launcher })}
                </span>
                <span className="badge badge-muted">
                  {t("home.online.edge", { count: launcherOnlineSummary.edge })}
                </span>
                <span className="badge badge-muted">
                  {t("home.online.nova", { count: launcherOnlineSummary.nova })}
                </span>
              </div>
            )}
          </div>
          <div className="page-header-actions">
            <MinecraftProfileCard
              accounts={minecraftAccounts}
              currentAccount={currentMinecraftAccount}
              required={minecraftAccountRequired}
              onSelectAccount={onSelectMinecraftAccount}
              onAddOfflineAccount={onAddOfflineMinecraftAccount}
              onSaveMicrosoftAccount={onSaveMicrosoftMinecraftAccount}
              onDeleteAccount={onDeleteMinecraftAccount}
            />
          </div>
        </header>

        {launcherUpdate && launcherUpdateAvailable && (
          <section className="mb-5">
            <Card variant="frost" className="page-card rounded-[10px]" interactive={false}>
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

        <section className="mb-6">
          {/* The launch pad is the page's primary interactive surface: lensed
              Liquid Glass under the liquid profile (large plate — no warp). */}
          <LiquidGlass
            as="div"
            mode="standard"
            displacementScale={52}
            aberrationIntensity={1.8}
            className="home-launch-card"
          >
            <div className="home-launch-main">
              <div className="icon-tile relative h-16 w-16 rounded-[12px]">
                {selectedInstanceIcon ? (
                  <img
                    src={selectedInstanceIcon}
                    alt={selectedInstance?.name ?? "instance"}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <Gamepad2 size={24} className="text-[var(--text-muted)]" />
                )}
                {selectedInstance && !instanceLaunchable && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Lock size={16} className="text-white/70" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-lg font-bold leading-tight text-[var(--text-primary)]">
                  {selectedInstance ? selectedInstance.name : t("home.noInstance")}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {selectedInstance && (
                    <span className="text-data truncate text-xs text-[var(--text-secondary)]">
                      {[selectedBaseVersion, selectedLoaderLabel, selectedInstance.launcherVersionType]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                  <span className="text-xs text-[var(--text-muted)]">
                    {t("home.loadout.launchAs", { name: launchAsName })}
                  </span>
                  {isOfflineAccount && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--warning-text)]">
                      <AlertTriangle size={11} className="shrink-0" />
                      {t("home.loadout.offlineNote")}
                    </span>
                  )}
                  {novaSelectedIsTesting && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--warning-text)]">
                      <AlertTriangle size={11} className="shrink-0" />
                      {t("home.novaTestingWarning", { version: selectedNovaGameVersion })}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="home-launch-actions">
              <button
                type="button"
                className="home-launch-change segment-chip !min-h-9 shrink-0 px-4"
                onClick={() => setPickerOpen(true)}
              >
                {t("home.loadout.change")}
              </button>
              <Button
                variant="primary"
                size="md"
                className="cta-glow min-h-[46px] min-w-[164px] justify-center !rounded-[var(--radius-lg)]"
                disabled={busy || !selectedInstance || !instanceLaunchable}
                launchProgress={launching}
                launchProgressPercent={launchProgressPercent}
                liquidGlass
                onClick={onLaunch}
              >
                <span className="flex items-center justify-center gap-2">
                  <Play fill="currentColor" size={15} />
                  {launching
                    ? `${t("home.launching")}${typeof launchProgressPercent === "number" ? ` ${launchProgressPercent}%` : ""}`
                    : t("home.launch")}
                </span>
              </Button>
            </div>
          </LiquidGlass>
        </section>

        {quickServers.length > 0 && (
          <section className="mb-6">
            <div className="home-strip-label">
              <Zap size={13} className="text-[var(--mc-grass)]" />
              <span>{t("home.quickJoin")}</span>
            </div>
            <div className="home-server-strip">
              {quickServers.map((server) => (
                <button
                  key={server.id ?? server.address}
                  type="button"
                  className="home-server-icon"
                  disabled={quickJoinDisabled}
                  title={`${server.name} · ${server.address}`}
                  aria-label={server.name}
                  onClick={() => onLaunchToServer(server.address)}
                >
                  {server.iconPath ? (
                    <img src={server.iconPath} alt={server.name} />
                  ) : (
                    server.name.slice(0, 1)
                  )}
                </button>
              ))}
              <button
                type="button"
                className="home-server-more"
                onClick={onOpenServers}
                aria-label={t("home.viewAll")}
              >
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        )}

        {launcherDashboard && (
          <section className="mb-6">
            <div className="home-stats-row">
              <div className="home-stat">
                <p className="home-stat-label">
                  <Clock size={12} />
                  <span>{t("home.stats.weekly")}</span>
                </p>
                <p className="home-stat-value text-data">{weeklyHours.toFixed(1)}h</p>
              </div>
              <div className="home-stat">
                <p className="home-stat-label">
                  <BarChart3 size={12} />
                  <span>{t("home.profile.sessions")}</span>
                </p>
                <p className="home-stat-value text-data">{sessionCount}</p>
              </div>
              <div className="home-stat">
                <p className="home-stat-label">
                  <TrendingUp size={12} />
                  <span>{t("home.stats.level")}</span>
                </p>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="home-stat-value text-data">{levelLabel}</p>
                  {expText && (
                    <span className="text-data text-[11px] text-[var(--text-muted)]">{expText}</span>
                  )}
                </div>
                {expPercent !== null && (
                  <div className="home-level-bar mt-2">
                    <div className="home-level-bar-fill" style={{ width: `${expPercent}%` }} />
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        <section>
          <div className="section-header">
            <div className="section-header-main">
              <h2 className="section-title flex items-center gap-2">
                <Calendar size={18} className="text-[var(--mc-grass)]" />
                {t("home.latestNews")}
              </h2>
              <p className="section-subtitle">{t("home.news.source")}</p>
            </div>
            <div className="section-toolbar">
              <LiquidGlass
                as="button"
                type="button"
                mode="standard"
                displacementScale={22}
                aberrationIntensity={1.4}
                blur={6}
                interactive
                elastic
                className="segment-chip !min-h-9 px-4"
                disabled={launcherNews.length === 0}
                onClick={() => setActiveNews(launcherNews[0] ?? null)}
              >
                {t("home.viewAll")}
              </LiquidGlass>
            </div>
          </div>
          {launcherNews.length > 0 ? (
            <div className="grid gap-1">
              {launcherNews.slice(0, 5).map((news) => (
                <button
                  key={news.id ?? news.title}
                  type="button"
                  className="home-news-row"
                  onClick={() => setActiveNews(news)}
                >
                  <span className={`badge shrink-0 ${news.pinned ? "badge-accent" : "badge-muted"}`}>
                    {news.pinned ? t("home.news.pinnedTag") : t("home.news.tag")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">
                    {news.title}
                  </span>
                  {news.publishedAt && (
                    <span className="text-data shrink-0 text-xs text-[var(--text-muted)]">
                      {new Date(news.publishedAt).toLocaleDateString()}
                    </span>
                  )}
                  <ChevronRight size={15} className="shrink-0 text-[var(--text-muted)]" />
                </button>
              ))}
            </div>
          ) : (
            <div className="home-news-empty">
              <p className="text-sm text-[var(--text-secondary)]">{t("home.news.emptyTitle")}</p>
              <LiquidGlass
                as="button"
                type="button"
                mode="standard"
                displacementScale={20}
                aberrationIntensity={1.4}
                blur={6}
                interactive
                elastic
                className="home-news-empty-action"
                onClick={onOpenServers}
              >
                {t("home.news.emptyAction")}
                <ArrowRight size={14} />
              </LiquidGlass>
            </div>
          )}
        </section>
      </div>

      {(pickerOpen || pickerClosing) &&
        typeof document !== "undefined" &&
        createPortal(
          <div className={`modal-shell ${pickerClosing ? "modal-backdrop-animate-out" : "modal-backdrop-animate"}`}>
            <Card
              variant="strong"
              className={`${pickerClosing ? "modal-animate-out" : "modal-animate"} modal-card page-card w-full max-w-4xl`}
              interactive={false}
              liquidGlass
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
                  {/* Edge / Extreme — single-version product regions */}
                  {presetRegions.map((instance) => (
                    <div key={instance.id}>
                      <div className="mb-3 flex items-center gap-2 px-1">
                        <Swords size={16} className="text-[var(--mc-grass)]" />
                        <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--mc-grass)]">
                          {regionLabel(instance)}
                        </h4>
                      </div>
                      <div className="surface-list">
                        <InstanceSelectRow
                          instance={instance}
                          active={selectedInstance?.id === instance.id}
                          selectable={canAccessInstance(instance, user)}
                          t={t}
                          onSelect={() => {
                            onSelect(instance.id);
                            setPickerOpen(false);
                          }}
                        />
                      </div>
                    </div>
                  ))}

                  {/* Nova — multi game-version region */}
                  {novaPreset && novaRows.length > 0 && (
                    <div>
                      <div className="mb-3 flex items-center gap-2 px-1">
                        <Swords size={16} className="text-[var(--mc-grass)]" />
                        <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--mc-grass)]">Nova</h4>
                        <span className="badge badge-accent normal-case tracking-normal">{novaRows.length}</span>
                        <span className="text-xs text-[var(--text-muted)]">{t("home.novaSelectVersion")}</span>
                      </div>
                      <div className="mb-3 flex items-start gap-2 rounded-[8px] border border-amber-500/25 bg-amber-500/10 px-3 py-2">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />
                        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                          {t("home.novaFullFeatureNote")}
                        </p>
                      </div>
                      <div className="surface-list">
                        {novaRows.map(({ gameVersion, version }) => (
                          <NovaVersionRow
                            key={gameVersion}
                            gameVersion={gameVersion}
                            version={version}
                            active={selectedInstance?.id === novaPreset.id && selectedNovaGameVersion === gameVersion}
                            selectable={canAccessInstance(novaPreset, user)}
                            testing={gameVersion !== NOVA_DEFAULT_GAME_VERSION}
                            t={t}
                            onSelect={() => {
                              onSelect(novaPreset.id);
                              onSelectNovaGameVersion(gameVersion);
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

                {filteredInstances.length === 0 && novaRows.length === 0 && (
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
              liquidGlass
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
                <div className="surface-panel surface-panel-soft rounded-[10px] p-4">
                  <p className="text-sm leading-7 whitespace-pre-wrap text-[var(--text-secondary)]">
                    {activeNewsContent || t("home.news.dialogEmpty")}
                  </p>
                </div>
              </div>
            </Card>
          </div>,
          document.body
        )}

      <ServerDialog
        server={activeServer}
        closing={serverClosing}
        onClose={closeServer}
        onLaunch={() => {
          if (activeServer) {
            closeServer();
            onLaunchToServer(activeServer.address);
          }
        }}
        currentInstance={current}
        busy={busy}
        launching={launching}
        launchProgressPercent={launchProgressPercent}
      />
    </div>
  );
}

function InstanceSelectRow({
  instance,
  active,
  selectable,
  compact = false,
  t,
  onSelect
}: {
  instance: Instance;
  active: boolean;
  selectable: boolean;
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
      <div className={`icon-tile relative ${compact ? "h-10 w-10 rounded-[8px]" : ""}`}>
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

function NovaVersionRow({
  gameVersion,
  version,
  active,
  selectable,
  testing,
  t,
  onSelect
}: {
  gameVersion: string;
  version: LauncherVersion | null;
  active: boolean;
  selectable: boolean;
  testing: boolean;
  t: ReturnType<typeof useI18n>["t"];
  onSelect: () => void;
}) {
  return (
    <button
      onClick={() => {
        if (selectable) onSelect();
      }}
      type="button"
      disabled={!selectable}
      className={`surface-list-item w-full text-left ${active ? "is-active" : ""} ${!selectable ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <div className="icon-tile relative h-10 w-10 rounded-[8px]">
        <img src="/instance-icons/nova.png" alt={`Nova ${gameVersion}`} className="h-full w-full object-cover" />
        {!selectable && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Lock size={12} className="text-white/70" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-semibold ${!selectable ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
          {`Nova ${gameVersion}`}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="badge badge-accent normal-case tracking-normal">{gameVersion}</span>
          {version?.recommended && (
            <span className="badge badge-accent normal-case tracking-normal">{t("home.novaVersionRecommended")}</span>
          )}
          {testing && (
            <span className="badge badge-warning normal-case tracking-normal">{t("home.novaTestingBadge")}</span>
          )}
          {version?.channel && version.channel !== "RELEASE" && (
            <span className="badge badge-muted normal-case tracking-normal">{version.channel}</span>
          )}
        </div>
      </div>
      {active && selectable && <Check size={14} className="shrink-0 text-[var(--mc-grass)]" />}
      {!selectable && <Lock size={12} className="shrink-0 text-[var(--text-muted)]" />}
    </button>
  );
}

// Region heading for the single-version products in the launch picker.
function regionLabel(instance: Instance): string {
  if (instance.launcherVersionType === "EDGE") return "Edge";
  if (instance.launcherVersionType === "EXTREME") return "Extreme";
  if (instance.launcherVersionType === "NOVA") return "Nova";
  return instance.name;
}

// Numeric dotted-version comparison. Works across schemes (e.g. "26.2" > "1.21.11") since it
// compares the leading numeric segments left to right. Returns >0 when a is newer than b.
function compareGameVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const left = pa[i] ?? 0;
    const right = pb[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function resolveHomeLevel(user: LauncherUser | null): string {
  const dynamicLevel = user?.level ?? user?.userLevel ?? user?.membershipLevel;
  if (typeof dynamicLevel === "number" && Number.isFinite(dynamicLevel)) {
    return `Lv.${Math.max(0, Math.floor(dynamicLevel))}`;
  }
  if (typeof dynamicLevel === "string") {
    const normalized = dynamicLevel.trim();
    if (normalized) {
      return /^lv\.?/i.test(normalized) ? normalized : `Lv.${normalized}`;
    }
  }
  return "Lv.1";
}

function loaderLabel(
  loader: Instance["loader"],
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (loader === "forge") return t("loader.forge");
  if (loader === "fabric") return t("loader.fabric");
  return t("loader.vanilla");
}

export default memo(HomePage);
