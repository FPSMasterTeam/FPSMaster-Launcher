import { memo } from "react";
import { Award, BarChart3, Calendar, ChevronRight, Clock, Crown, CreditCard, ShieldCheck, Trophy, User } from "lucide-react";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type { LauncherDashboard } from "../types";

type AccountCenterPageProps = {
  launcherDashboard: LauncherDashboard | null;
};

function AccountCenterPage({ launcherDashboard }: AccountCenterPageProps) {
  const { t } = useI18n();
  const profileUser = launcherDashboard?.user ?? null;
  const profileStats = launcherDashboard?.stats ?? null;
  const membershipText = profileUser?.membershipExpiresAt
    ? new Date(profileUser.membershipExpiresAt).toLocaleDateString()
    : t("account.membershipInactive");
  const expText =
    typeof profileUser?.experience === "number" && typeof profileUser?.nextLevelNeed === "number"
      ? `${profileUser.experience}/${profileUser.nextLevelNeed}`
      : "--/--";
  const playtimeChart = launcherDashboard?.weeklyPlaytime.points ?? [];

  // Determine user role
  const userRole = profileUser?.role?.trim().toUpperCase() || "USER";
  const isAdmin = userRole === "ADMIN";
  const isSponsor = userRole === "SPONSOR";

  // Resolve user level
  const userLevel = resolveUserLevel(profileUser, userRole);
  const userLevelNum = parseLevelNumber(userLevel);

  return (
    <div className="page-shell">
      <header className="page-header mb-6">
        <div className="page-header-main">
          <p className="page-eyebrow">{t("account.eyebrow")}</p>
          <h1 className="page-title">{t("account.title")}</h1>
          <p className="page-subtitle">{t("account.subtitle")}</p>
        </div>
      </header>

      <div className="page-grid page-grid-two">
        {/* Main Profile Card */}
        <Card variant="frost" className="page-card overflow-hidden rounded-[10px] md:p-6" interactive={false}>
          {/* Profile Header with Avatar */}
          <div className="flex items-start gap-4">
            {/* Enhanced Avatar */}
            <div className="relative">
              <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-white/8 bg-[var(--bg-elevated)]">
                {/* Avatar image or fallback */}
                {profileUser?.avatarUrl ? (
                  <img src={profileUser.avatarUrl} alt={profileUser.username ?? "avatar"} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-2xl font-bold text-[var(--text-primary)]">
                    {(profileUser?.username ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                )}

                {/* Status indicator */}
                <div className="absolute bottom-1 right-1 h-3 w-3 rounded-full border-2 border-[var(--bg-elevated)] bg-[var(--mc-grass)]" />
              </div>

              {/* Level Badge */}
              <div className="absolute -bottom-2 -right-2">
                <div className="flex items-center justify-center rounded-full bg-[var(--mc-grass)] p-1.5 ring-2 ring-[var(--bg-elevated)]">
                  <Trophy size={12} className="text-white" />
                </div>
              </div>
            </div>

            {/* User Info */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-2xl font-bold text-[var(--text-primary)]">
                  {profileUser?.username ?? t("nav.player")}
                </h2>
                {isAdmin && (
                  <div className="badge badge-warning gap-1 rounded-[5px] px-2 py-1">
                    <Crown size={12} className="text-amber-400" />
                    <span className="text-[10px] font-semibold text-amber-400">ADMIN</span>
                  </div>
                )}
              </div>

              <p className="mt-1 truncate text-sm text-[var(--text-secondary)]">
                {profileUser?.customTitle || t("account.noTitle")}
              </p>

              {/* User Level Display - No "Level" label */}
              <div className="mt-3 flex items-center gap-3">
                <div className="badge badge-accent gap-1.5 rounded-[5px] px-3 py-1.5 normal-case tracking-normal">
                  <span className="text-data text-sm font-bold text-[var(--mc-grass)]">{userLevel}</span>
                </div>

                {/* Role Badge - Only show for non-admin users */}
                {!isAdmin && !isSponsor && (
                  <div className="badge badge-muted rounded-[5px] px-3 py-1 normal-case tracking-normal text-xs">
                    普通会员
                  </div>
                )}
                {isSponsor && (
                  <div className="badge badge-accent rounded-[5px] px-3 py-1 normal-case tracking-normal text-xs">
                    Pro会员
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Stats Grid */}
          <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label={t("account.wallet")} value={profileUser?.walletBalance ?? "--"} icon={<CreditCard size={14} />} />
            <Metric label={t("account.membership")} value={membershipText} icon={<ShieldCheck size={14} />} />
            <Metric label={t("account.sessions")} value={String(profileStats?.playSessionCount ?? 0)} icon={<BarChart3 size={14} />} />
            <Metric label={t("account.exp")} value={expText} icon={<Award size={14} />} />
          </div>
        </Card>

        {/* Activity Card */}
        <Card variant="frost" className="page-card overflow-hidden rounded-[10px] md:p-6" interactive={false}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
              <Clock size={18} className="text-[var(--mc-grass)]" />
              {t("account.activity")}
            </h2>
            <span className="badge badge-muted rounded-[5px] px-3 py-1 text-[11px] normal-case tracking-normal">
              {t("account.totalHours", { hours: profileStats?.totalPlayHours ?? 0 })}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Metric label={t("account.totalActivities")} value={String(profileStats?.totalActivities ?? 0)} />
            <Metric label={t("account.latestActivity")} value={profileStats?.latestActivityAt ? new Date(profileStats.latestActivityAt).toLocaleString() : "--"} />
          </div>

          {/* Weekly Playtime Visual */}
          {playtimeChart.length > 0 ? (
            <div className="surface-panel surface-panel-soft mt-4 rounded-[8px] p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t("account.weeklyActivity")}</span>
                <Calendar size={14} className="text-[var(--text-muted)]" />
              </div>
              <div className="flex items-end gap-1 h-16">
                {playtimeChart.slice(-7).map((day, idx) => {
                  const maxHours = Math.max(...playtimeChart.slice(-7).map(d => d.playHours), 1);
                  const height = maxHours > 0 ? (day.playHours / maxHours) * 100 : 5;
                  const isToday = idx === playtimeChart.slice(-7).length - 1;
                  return (
                    <div
                      key={day.date}
                      className="flex-1 flex flex-col items-center gap-1"
                      title={`${day.date}: ${day.playHours.toFixed(1)}h`}
                    >
                      <div
                        className={`w-full rounded-t-[2px] transition-all duration-200 ${
                          isToday
                            ? "bg-[var(--mc-grass)]"
                            : "bg-[var(--mc-grass)]/35 hover:bg-[var(--mc-grass)]/55"
                        }`}
                        style={{ height: `${Math.max(height, 5)}%` }}
                      />
                      <span className={`text-[9px] ${isToday ? "text-[var(--mc-grass)] font-semibold" : "text-[var(--text-muted)]"}`}>
                        {new Date(day.date).toLocaleDateString("en-US", { weekday: "narrow" })}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="empty-state mt-4 min-h-[180px]">
              <p className="empty-state-text !mt-0">{t("account.noStats")}</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="metric-tile">
      <div className="metric-label">
        {icon}
        <span>{label}</span>
      </div>
      <p className="metric-value truncate">{value}</p>
    </div>
  );
}

function resolveUserLevel(user: any, role: string): string {
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
  if (role === "ADMIN") return "Lv.MAX";
  if (role === "SPONSOR") return "Lv.10";
  return "Lv.1";
}

function parseLevelNumber(levelStr: string): number {
  if (levelStr === "Lv.MAX") return 999;
  const match = levelStr.match(/Lv\.?(\d+)/i);
  if (match) return parseInt(match[1], 10) || 1;
  return 1;
}

export default memo(AccountCenterPage);
