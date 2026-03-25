import { ChevronsLeft, ChevronsRight, Compass, Gamepad2, Home, Settings, User } from "lucide-react";
import AppLogo from "./AppLogo";
import { useI18n } from "../i18n";
import type { LauncherUser, Page } from "../types";

type SidebarProps = {
  currentPage: Page;
  collapsed: boolean;
  canToggleCollapse: boolean;
  user: LauncherUser | null;
  onToggleCollapse: () => void;
  setPage: (page: Page) => void;
};

export default function Sidebar({
  currentPage,
  collapsed,
  canToggleCollapse,
  user,
  onToggleCollapse,
  setPage
}: SidebarProps) {
  const { t } = useI18n();
  const navItems = [
    { id: "home" as const, icon: Home, label: t("nav.dashboard") },
    { id: "instances" as const, icon: Gamepad2, label: t("nav.myGames") },
    { id: "content" as const, icon: Compass, label: t("nav.content") },
    { id: "settings" as const, icon: Settings, label: t("nav.settings") }
  ];

  const userName = resolveUserName(user, t("nav.player"));
  const role = resolveUserRole(user);
  const roleLabel = resolveUserRoleLabel(role, t);
  const levelText = resolveUserLevel(user, role);
  const roleBadgeClass = resolveRoleBadgeClass(role);

  return (
    <aside
      className={`relative z-20 flex h-full flex-col overflow-hidden bg-[var(--bg-secondary)]/72 backdrop-blur-xl transition-[width] duration-[var(--duration-normal)] ${
        collapsed ? "w-[76px]" : "w-[76px] lg:w-[244px]"
      }`}
    >
      <div className="border-b border-[var(--border-subtle)] px-2 py-2 lg:px-3">
        <button
          type="button"
          onClick={() => setPage("home")}
          className={`flex min-h-10 w-full items-center rounded-lg px-2 transition-colors hover:bg-[var(--surface-soft)] ${collapsed ? "justify-center" : "justify-center lg:justify-start"}`}
          aria-label={t("nav.dashboard")}
        >
          <AppLogo size={28} className="rounded-lg" />
          <div className={`ml-3 min-w-0 ${collapsed ? "hidden" : "hidden lg:block"}`}>
            <p className="truncate text-sm font-semibold text-[var(--text-primary)]">FPSMaster</p>
            <p className="truncate text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">Launcher</p>
          </div>
        </button>
      </div>

      <nav className="flex-1 space-y-1 px-2 py-2 lg:px-3">
        {navItems.map((item) => {
          const active =
            currentPage === item.id ||
            ((currentPage === "install" || currentPage === "instance-settings") && item.id === "instances");
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className={`group relative flex min-h-10 w-full cursor-pointer items-center overflow-hidden rounded-lg border px-2.5 py-2 transition-all duration-[var(--duration-normal)] active:scale-[0.99] ${
                collapsed ? "justify-center" : "justify-center lg:justify-start"
              } ${
                active
                  ? "border-[rgba(var(--accent-rgb),0.25)] bg-[var(--linear-card-bg)] text-[var(--text-primary)] shadow-[0_0_0_1px_rgba(var(--accent-rgb),var(--linear-hover-ring)),0_8px_18px_rgba(2,8,16,0.22),0_0_14px_rgba(var(--accent-rgb),var(--linear-hover-halo))]"
                  : "border-transparent text-[var(--text-secondary)] hover:border-[var(--border-subtle)] hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)]"
              }`}
              aria-label={item.label}
              title={item.label}
              type="button"
            >
              <Icon size={18} className={`transition-colors duration-[var(--duration-normal)] ${active ? "text-[var(--mc-grass)]" : "group-hover:text-[var(--text-primary)]"}`} />
              <span className={`ml-2.5 whitespace-nowrap text-sm font-medium ${collapsed ? "hidden" : "hidden lg:block"}`}>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="border-t border-[var(--border-subtle)] p-2.5 lg:p-3">
        <button
          className={`group flex min-h-10 w-full items-center rounded-lg border border-transparent p-2 transition-all duration-[var(--duration-normal)] hover:border-[var(--border-medium)] hover:bg-[var(--surface-soft)] ${
            collapsed ? "justify-center" : "justify-center lg:justify-start"
          }`}
          type="button"
          aria-label={userName}
        >
          <div className="relative flex h-8 w-8 min-h-8 min-w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-elevated)] ring-1 ring-[var(--border-medium)]">
            <div className="absolute inset-0 rounded-lg bg-[var(--mc-grass)]/20 opacity-0 blur-xl transition-opacity duration-[var(--duration-normal)] group-hover:opacity-40" />
            <User size={14} className="text-[var(--text-primary)]" />
          </div>
          <div className={`ml-3 text-left ${collapsed ? "hidden" : "hidden lg:block"}`}>
            <p className="whitespace-nowrap text-sm font-semibold text-[var(--text-primary)] transition-colors group-hover:text-[var(--mc-grass)]">{userName}</p>
            <div className="mt-1 flex items-center gap-2 whitespace-nowrap">
              <span className="text-xs text-[var(--text-muted)]">{levelText}</span>
              <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${roleBadgeClass}`}>{roleLabel}</span>
            </div>
          </div>
        </button>

        <button
          className={`mt-2 flex min-h-10 w-full items-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2 py-2 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] ${
            canToggleCollapse ? "" : "cursor-not-allowed opacity-50"
          } ${collapsed ? "justify-center" : "justify-center lg:justify-start"}`}
          type="button"
          onClick={onToggleCollapse}
          disabled={!canToggleCollapse}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          <span className={`ml-2 whitespace-nowrap text-xs font-medium ${collapsed ? "hidden" : "hidden lg:block"}`}>
            {collapsed ? t("nav.expand") : t("nav.collapse")}
          </span>
        </button>
      </div>
    </aside>
  );
}

function resolveUserName(user: LauncherUser | null, fallback: string): string {
  const name = user?.username?.trim();
  if (name) {
    return name;
  }
  const email = user?.email?.trim();
  if (email) {
    return email;
  }
  return fallback;
}

function resolveUserRole(user: LauncherUser | null): string {
  const role = user?.role?.trim().toUpperCase();
  return role || "USER";
}

function resolveUserRoleLabel(
  role: string,
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (role === "ADMIN") return t("sidebar.role.staff");
  if (role === "SPONSOR") return t("sidebar.role.pro");
  return t("sidebar.role.member");
}

function resolveUserLevel(user: LauncherUser | null, role: string): string {
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
  if (role === "USER") return "Lv.1";
  return "Lv.--";
}

function resolveRoleBadgeClass(role: string): string {
  if (role === "ADMIN") {
    return "border-[var(--accent-danger)]/40 bg-[var(--accent-danger)]/10 text-[var(--accent-danger)]";
  }
  if (role === "SPONSOR") {
    return "border-[var(--mc-grass)]/40 bg-[var(--mc-grass)]/12 text-[var(--mc-grass)]";
  }
  return "border-[var(--border-medium)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]";
}
