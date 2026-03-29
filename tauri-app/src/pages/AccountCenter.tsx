import { BarChart3, Calendar, CreditCard, ShieldCheck, User } from "lucide-react";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type { LauncherDashboard } from "../types";

type AccountCenterPageProps = {
  launcherDashboard: LauncherDashboard | null;
};

export default function AccountCenterPage({ launcherDashboard }: AccountCenterPageProps) {
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

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5 xl:p-6">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">{t("account.eyebrow")}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">{t("account.title")}</h1>
        <p className="mt-1 text-[var(--text-secondary)]">{t("account.subtitle")}</p>
      </header>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
        <Card variant="frost" className="rounded-xl p-5 md:p-6" interactive={false}>
          <div className="flex items-start gap-4">
            <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-3xl border border-[var(--border-medium)] bg-[var(--bg-elevated)]">
              {profileUser?.avatarUrl ? (
                <img src={profileUser.avatarUrl} alt={profileUser.username ?? "avatar"} className="h-full w-full object-cover" />
              ) : (
                <span className="text-2xl font-semibold text-[var(--text-primary)]">
                  {(profileUser?.username ?? "?").slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                <User size={14} />
                {t("account.profile")}
              </div>
              <h2 className="mt-2 truncate text-2xl font-semibold text-[var(--text-primary)]">
                {profileUser?.username ?? t("nav.player")}
              </h2>
              <p className="mt-1 truncate text-sm text-[var(--text-secondary)]">
                {profileUser?.customTitle || t("account.noTitle")}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric label={t("account.wallet")} value={profileUser?.walletBalance ?? "--"} icon={<CreditCard size={14} />} />
                <Metric label={t("account.membership")} value={membershipText} icon={<ShieldCheck size={14} />} />
                <Metric label={t("account.sessions")} value={String(profileStats?.playSessionCount ?? 0)} icon={<BarChart3 size={14} />} />
                <Metric label={t("account.exp")} value={expText} icon={<Calendar size={14} />} />
              </div>
            </div>
          </div>
        </Card>

        <Card variant="frost" className="rounded-xl p-5 md:p-6" interactive={false}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t("account.activity")}</h2>
            <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] font-semibold text-[var(--text-secondary)]">
              {t("account.totalHours", { hours: profileStats?.totalPlayHours ?? 0 })}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Metric label={t("account.totalActivities")} value={String(profileStats?.totalActivities ?? 0)} />
            <Metric label={t("account.latestActivity")} value={profileStats?.latestActivityAt ? new Date(profileStats.latestActivityAt).toLocaleString() : "--"} />
          </div>
          <div className="mt-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-soft)] p-4 text-sm text-[var(--text-secondary)]">
            {playtimeChart.length > 0
              ? t("account.weeklyPoints", { count: playtimeChart.length })
              : t("account.noStats")}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-3 py-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-2 truncate text-sm font-semibold text-[var(--text-primary)]">{value}</p>
    </div>
  );
}
