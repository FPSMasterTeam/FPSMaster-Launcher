import { Calendar, Check, ChevronRight, Download, Play, Search, Users, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Button from "../components/Button";
import Card from "../components/Card";
import { RECOMMENDED_SERVERS } from "../constants";
import { useI18n } from "../i18n";
import type { Instance, LauncherDashboard, NewsItem, PresetPackageStatus } from "../types";
import { resolveInstanceIconPath } from "../utils/launcher";

type HomePageProps = {
  availableInstances: Instance[];
  launcherNews: NewsItem[];
  launcherDashboard: LauncherDashboard | null;
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 md:p-5 xl:p-6">
        <section className="mb-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">FPSMaster Launcher</p>
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
              <button className="text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]" type="button">
                {t("home.viewAll")}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {launcherNews.map((news) => (
                <Card as="article" key={news.id ?? news.title} variant="soft" className="group rounded-xl p-4">
                  <div className="mb-2 inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    {news.pinned ? t("home.news.pinnedTag") : t("home.news.tag")}
                  </div>
                  <h3 className="text-base font-semibold leading-tight text-[var(--text-primary)] transition-colors group-hover:text-[var(--mc-grass)]">
                    {news.title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-6 text-[var(--text-secondary)]">
                    {news.summary}
                  </p>
                </Card>
              ))}
            </div>
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
                  <Button
                    variant={
                      presetPackageStatus?.state === "update-available" || presetPackageStatus?.state === "missing"
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
                  {presetPackageStatus?.state === "ready"
                    ? t("instances.packageReady", { version: presetPackageStatus.versionTag ?? "-" })
                    : presetPackageStatus?.state === "update-available"
                      ? t("instances.packageUpdateAvailable", { version: presetPackageStatus.versionTag ?? "-" })
                      : presetPackageStatus?.state === "checking"
                        ? t("instances.packageChecking")
                        : t("instances.packageMissing")}
                </p>
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
                          <p className="truncate font-mono text-[11px] text-[var(--text-muted)]">{instance.versionId}</p>
                        </div>
                        <div className="hidden text-right sm:block">
                          <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{t("instances.base")}</p>
                          <p className="text-xs text-[var(--text-secondary)]">{instance.baseVersion}</p>
                        </div>
                        <span className="rounded-md border border-[var(--border-medium)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                          {instance.loader}
                        </span>
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
