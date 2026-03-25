import { Calendar, Check, ChevronRight, Download, Play, Search, Users, X } from "lucide-react";
import { createPortal } from "react-dom";
import { type ReactNode, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Button from "../components/Button";
import Card from "../components/Card";
import { RECOMMENDED_SERVERS } from "../constants";
import { useI18n } from "../i18n";
import type { Instance, LauncherDashboard, NewsItem, PresetPackageStatus, TelemetryOnlineSummary } from "../types";
import { resolveInstanceIconPath } from "../utils/launcher";

type HomePageProps = {
  availableInstances: Instance[];
  launcherNews: NewsItem[];
  launcherDashboard: LauncherDashboard | null;
  launcherOnlineSummary: TelemetryOnlineSummary | null;
  current: Instance | null;
  busy: boolean;
  launching: boolean;
  launchProgressPercent: number | null;
  launchProgressText: string;
  presetPackageStatus?: PresetPackageStatus;
  onSelect: (id: string) => void;
  onLaunch: () => void;
  onSyncPresetPackage: () => void;
};

export default function HomePage({
  availableInstances,
  launcherNews,
  launcherDashboard,
  launcherOnlineSummary,
  current,
  busy,
  launching,
  launchProgressPercent,
  launchProgressText,
  presetPackageStatus,
  onSelect,
  onLaunch,
  onSyncPresetPackage
}: HomePageProps) {
  const { t } = useI18n();
  const selectedInstance = current ?? availableInstances[0] ?? null;
  const selectedInstanceIcon = selectedInstance ? resolveInstanceIconPath(selectedInstance) : null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [activeNews, setActiveNews] = useState<NewsItem | null>(null);

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
  const playtimeChartData = useMemo(
    () =>
      launcherDashboard?.weeklyPlaytime.points.map((point) => ({
        name: point.date.slice(5),
        hours: Number(point.playHours.toFixed(2))
      })) ?? [],
    [launcherDashboard]
  );
  const profileUser = launcherDashboard?.user ?? null;
  const profileStats = launcherDashboard?.stats ?? null;
  const membershipText = profileUser?.membershipExpiresAt
    ? new Date(profileUser.membershipExpiresAt).toLocaleDateString()
    : t("home.profile.membershipInactive");
  const expText =
    typeof profileUser?.experience === "number" && typeof profileUser?.nextLevelNeed === "number"
      ? `${profileUser.experience}/${profileUser.nextLevelNeed}`
      : "--/--";
  const presetStatusText = presetPackageStatus ? describePresetPackageStatus(presetPackageStatus, t) : null;
  const presetStatusTone = presetPackageStatus ? resolvePresetStatusTone(presetPackageStatus.state) : "";
  const presetChangelog = presetPackageStatus?.changelog ? summarizeChangelog(presetPackageStatus.changelog) : null;
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 md:p-5 xl:p-6">
        <section className="mb-5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">FPSMaster Launcher</p>
            {typeof launcherOnlineCount === "number" && (
              <span className="rounded-md border border-[var(--mc-grass)]/35 bg-[var(--mc-grass)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--mc-grass)]">
                {t("home.onlineTag", { count: launcherOnlineCount })}
              </span>
            )}
            {onlineBadges.slice(0, 3).map((badge) => (
              <span
                key={badge}
                className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]"
              >
                {badge}
              </span>
            ))}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)] md:text-3xl">{t("home.welcomeBack")}</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)] md:text-[15px]">{t("home.dashboardReady")}</p>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.92fr)]">
          <div>
            <Card variant="frost" className="mb-4 rounded-xl p-4 md:p-5">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                    {t("home.profile.title")}
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-[var(--border-medium)] bg-[var(--bg-elevated)]">
                      {profileUser?.avatarUrl ? (
                        <img src={profileUser.avatarUrl} alt={profileUser.username ?? "avatar"} className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-lg font-semibold text-[var(--text-primary)]">
                          {(profileUser?.username ?? "?").slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold text-[var(--text-primary)]">
                        {profileUser?.username ?? t("nav.player")}
                      </h2>
                      <p className="truncate text-sm text-[var(--text-secondary)]">
                        {profileUser?.customTitle || t("home.profile.noTitle")}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <ProfileMetric label={t("home.profile.wallet")} value={profileUser?.walletBalance ?? "--"} />
                    <ProfileMetric label={t("home.profile.membership")} value={membershipText} />
                    <ProfileMetric label={t("home.profile.sessions")} value={String(profileStats?.playSessionCount ?? 0)} />
                    <ProfileMetric label={t("home.profile.exp")} value={expText} />
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("home.profile.playtime")}</h2>
                    <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] font-semibold text-[var(--text-secondary)]">
                      {t("home.profile.totalHours", { hours: profileStats?.totalPlayHours ?? 0 })}
                    </span>
                  </div>
                  <Card variant="soft" className="h-44 rounded-2xl p-2" interactive={false}>
                    {playtimeChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={playtimeChartData}>
                          <defs>
                            <linearGradient id="homePlaytimeGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="var(--mc-grass)" stopOpacity={0.26} />
                              <stop offset="95%" stopColor="var(--mc-grass)" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                          <XAxis dataKey="name" tick={{ fill: "var(--text-muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
                          <YAxis hide domain={[0, "dataMax + 1"]} />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "var(--bg-tertiary)",
                              borderColor: "var(--border-medium)",
                              borderRadius: "12px"
                            }}
                            formatter={(value: number) => [`${value}h`, t("home.profile.playtime")]}
                            labelStyle={{ color: "var(--text-secondary)" }}
                          />
                          <Area type="monotone" dataKey="hours" stroke="var(--mc-grass)" strokeWidth={1.8} fillOpacity={1} fill="url(#homePlaytimeGradient)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                        {t("home.profile.noStats")}
                      </div>
                    )}
                  </Card>
                </div>
              </div>
            </Card>

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
                    <Card as="article" variant="soft" className="group h-full rounded-xl p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <div className="inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
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
              <Card variant="soft" className="rounded-xl border border-dashed p-5 text-sm text-[var(--text-secondary)]">
                {t("home.dashboardReady")}
              </Card>
            )}
          </div>

          <div className="space-y-4">
            {selectedInstance?.preset && (
              <Card variant="frost" className="rounded-xl p-3.5 md:p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                      <Download size={16} className="text-[var(--mc-grass)]" />
                      {t("home.presetPackageTitle")}
                    </h2>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">{selectedInstance.name}</p>
                  </div>
                  {presetPackageStatus && (
                    <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${presetStatusTone}`}>
                      {presetStatusLabel(presetPackageStatus.state, t)}
                    </span>
                  )}
                  <Button
                    variant={
                      presetPackageStatus?.state === "update-available" ||
                      presetPackageStatus?.state === "missing" ||
                      presetPackageStatus?.state === "error"
                        ? "secondary"
                        : "outline"
                    }
                    size="sm"
                    onClick={onSyncPresetPackage}
                    disabled={busy}
                  >
                    {t("instances.syncPackage")}
                  </Button>
                </div>
                <p className="mt-3 text-sm text-[var(--text-secondary)]">
                  {presetStatusText ?? t("instances.packageMissing")}
                </p>
                {presetPackageStatus && (
                  <div className="mt-3 space-y-2">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <PresetMeta
                        label={t("instances.packageInstalledVersion")}
                        value={presetPackageStatus.installedVersionTag ?? "-"}
                      />
                      <PresetMeta
                        label={t("instances.packageTargetVersion")}
                        value={presetPackageStatus.targetVersionTag ?? presetPackageStatus.versionTag ?? "-"}
                      />
                    </div>
                    {presetChangelog && (
                      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                          {t("instances.packageChangelog")}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{presetChangelog}</p>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )}

            <Card variant="frost" className="rounded-xl p-3.5 md:p-4">
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <Users size={16} className="text-[var(--mc-grass)]" />
                {t("home.topServers")}
              </h2>
              <div className="space-y-1.5">
                {RECOMMENDED_SERVERS.map((server) => (
                  <button
                    key={server.address}
                    className="linear-float flex min-h-11 w-full cursor-pointer items-center rounded-lg border border-transparent px-2.5 py-2 text-left transition-all duration-[var(--duration-normal)] hover:border-[var(--border-subtle)] hover:bg-[var(--surface-soft)]"
                    type="button"
                  >
                    <div className="h-8 w-8 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
                      {server.iconPath ? <img src={server.iconPath} alt={server.name} className="h-full w-full object-cover" /> : null}
                    </div>
                    <div className="ml-2.5 min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{server.name}</p>
                      <p className="truncate text-[11px] text-[var(--text-muted)]">{server.address}</p>
                    </div>
                    <span className="rounded-md border border-[var(--border-medium)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                      {server.mode}
                    </span>
                  </button>
                ))}
              </div>
              <button className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]" type="button">
                {t("home.moreServers")} <ChevronRight size={12} />
              </button>
            </Card>
          </div>
        </section>
      </div>

      <footer className="border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/78 px-4 py-2.5 backdrop-blur-xl md:px-5 xl:px-6">
        <div className="grid gap-2.5 md:grid-cols-[minmax(0,1fr)_minmax(220px,280px)] md:items-center md:gap-4">
          <button
            className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-3 py-2 text-left transition-colors hover:border-[var(--border-medium)]"
            onClick={() => setPickerOpen(true)}
            type="button"
          >
            <div className="h-9 w-9 overflow-hidden rounded-lg border border-[var(--border-medium)] bg-[var(--bg-elevated)]">
              {selectedInstanceIcon ? <img src={selectedInstanceIcon} alt={selectedInstance?.name ?? "instance"} className="h-full w-full object-cover" /> : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-[var(--text-muted)]">{t("home.selectedInstance")}</p>
              <div className="flex items-center gap-1">
                <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{selectedInstance ? selectedInstance.name : t("home.noInstance")}</p>
                <ChevronRight size={14} className="text-[var(--text-muted)]" />
              </div>
              {selectedInstance && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <MetaBadge>{selectedInstance.baseVersion}</MetaBadge>
                  <MetaBadge>{selectedLoaderLabel}</MetaBadge>
                  {selectedInstance.launcherVersionType && <MetaBadge>{selectedInstance.launcherVersionType}</MetaBadge>}
                </div>
              )}
            </div>
          </button>

          <div className="relative flex items-center">
            <Button
              variant="primary"
              size="lg"
              className="w-full justify-center"
              disabled={busy || !selectedInstance}
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

      {pickerOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[var(--bg-primary)]/66 p-4 backdrop-blur-xl">
            <Card variant="strong" className="flex h-[78vh] w-full max-w-4xl min-h-[420px] max-h-[720px] flex-col rounded-2xl p-4 md:p-5" interactive={false}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold text-[var(--text-primary)]">{t("home.instancePickerTitle")}</h3>
                  <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{t("home.instancePickerSubtitle")}</p>
                </div>
                <button
                  className="min-h-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-soft)] p-2 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                  onClick={() => setPickerOpen(false)}
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
                  className="min-h-10 w-full rounded-lg border border-[var(--border-medium)] bg-[var(--bg-secondary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
                  placeholder={t("instances.searchPlaceholder")}
                />
              </label>

              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <div className="space-y-2">
                  {filteredInstances.map((instance) => {
                    const active = selectedInstance?.id === instance.id;
                    const icon = resolveInstanceIconPath(instance);
                    return (
                      <button
                        key={instance.id}
                        onClick={() => {
                          onSelect(instance.id);
                          setPickerOpen(false);
                        }}
                        type="button"
                        className={`flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                          active
                            ? "border-[rgba(var(--accent-rgb),0.36)] bg-[rgba(var(--accent-rgb),0.14)]"
                            : "border-[var(--border-subtle)] bg-[var(--surface-soft)] hover:border-[var(--border-medium)]"
                        }`}
                      >
                        <div className="h-9 w-9 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
                          {icon ? <img src={icon} alt={instance.name} className="h-full w-full object-cover" /> : null}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{instance.name}</p>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            <MetaBadge>{instance.baseVersion}</MetaBadge>
                            <MetaBadge>{loaderLabel(instance.loader, t)}</MetaBadge>
                            {instance.launcherVersionType && <MetaBadge>{instance.launcherVersionType}</MetaBadge>}
                          </div>
                        </div>
                        {active && <Check size={14} className="text-[var(--mc-grass)]" />}
                      </button>
                    );
                  })}
                </div>
                {filteredInstances.length === 0 && (
                  <p className="pt-3 text-sm text-[var(--text-muted)]">{t("home.noInstance")}</p>
                )}
              </div>

              <div className="mt-3 flex items-center justify-end gap-3">
                <Button variant="ghost" size="sm" onClick={() => setPickerOpen(false)}>
                  {t("home.instancePickerClose")}
                </Button>
              </div>
            </Card>
          </div>,
          document.body
        )}

      {activeNews &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[92] flex items-center justify-center bg-[var(--bg-primary)]/72 p-4 backdrop-blur-xl">
            <Card variant="strong" className="flex h-[78vh] w-full max-w-3xl min-h-[380px] max-h-[760px] flex-col rounded-2xl p-4 md:p-5" interactive={false}>
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
                  className="min-h-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-soft)] p-2 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                  onClick={() => setActiveNews(null)}
                  type="button"
                  aria-label={t("home.news.dialogClose")}
                >
                  <X size={16} />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-soft)] p-4">
                <p className="text-sm leading-7 whitespace-pre-wrap text-[var(--text-secondary)]">
                  {activeNewsContent || t("home.news.dialogEmpty")}
                </p>
              </div>

              <div className="mt-3 flex items-center justify-end">
                <Button variant="ghost" size="sm" onClick={() => setActiveNews(null)}>
                  {t("home.news.dialogClose")}
                </Button>
              </div>
            </Card>
          </div>,
          document.body
        )}
    </div>
  );
}

function ProfileMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-[var(--text-primary)]">{value}</p>
    </div>
  );
}

function MetaBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-[var(--border-medium)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
      {children}
    </span>
  );
}

function PresetMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-[var(--text-primary)]">{value}</p>
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
  return t("instances.packageMissing");
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
  return "border-[var(--border-medium)] bg-[var(--surface-soft)] text-[var(--text-secondary)]";
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
  return t("instances.status.missing");
}

function summarizeChangelog(changelog: string): string {
  const compact = changelog.replace(/\s+/g, " ").trim();
  if (compact.length <= 140) {
    return compact;
  }
  return `${compact.slice(0, 137)}...`;
}
