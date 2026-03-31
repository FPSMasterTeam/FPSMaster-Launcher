import { ChevronsLeft, ChevronsRight, Compass, Crown, Gamepad2, Home, Settings, Trophy } from "lucide-react";
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
  const accountActive = currentPage === "account-center";
  const userAvatarUrl = user?.avatarUrl?.trim();
  const userInitials = getUserInitials(userName);

  return (
    <aside
      className={`relative z-20 flex h-full flex-col overflow-hidden bg-[var(--bg-secondary)]/72 backdrop-blur-xl transition-[width] duration-[var(--duration-normal)] ${
        collapsed ? "w-[76px]" : "w-[76px] lg:w-[268px]"
      }`}
    >
      <div className="px-2 py-2 lg:px-3">
        <div className={`flex min-h-10 w-full items-center rounded-lg px-2 ${collapsed ? "justify-center" : "justify-center lg:justify-start"}`}>
          <AppLogo size={28} className="rounded-lg" />
          <div className={`ml-3 min-w-0 ${collapsed ? "hidden" : "hidden lg:block"}`}>
            <p className="truncate text-sm font-semibold text-[var(--text-primary)]">FPSMaster</p>
            <p className="truncate text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">Launcher</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-2 py-2 lg:px-3">
        {navItems.map((item) => {
          const active =
            currentPage === item.id ||
            ((currentPage === "install" || currentPage === "instance-settings") && item.id === "instances") ||
            (currentPage === "mandatory-update" && item.id === "settings");
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
                  : "border-transparent text-[var(--text-secondary)] hover:border-white/5 hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)]"
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

      <div className="border-t border-white/5 p-2.5 lg:p-3">
        <button
          className="group relative flex w-full items-center overflow-hidden rounded-xl p-2 transition-all duration-[var(--duration-normal)] hover:bg-[var(--surface-soft)]"
          type="button"
          aria-label={userName}
          onClick={() => setPage("account-center")}
        >
          {/* Avatar container */}
          <div className="relative shrink-0">
            <div className={`relative flex items-center justify-center overflow-hidden rounded-full border transition-all duration-[var(--duration-normal)] ${
              collapsed ? "h-9 w-9" : "h-10 w-10"
            } border-white/5`}>
              {/* Avatar image or initials */}
              {userAvatarUrl ? (
                <img
                  src={userAvatarUrl}
                  alt={userName}
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                <div className={`flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-[var(--mc-grass)] to-emerald-600 text-white font-semibold ${
                  collapsed ? "text-xs" : "text-sm"
                }`}>
                  {userInitials}
                </div>
              )}

              {/* Status indicator */}
              <div className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[var(--bg-elevated)] bg-[var(--mc-grass)]" />
            </div>

            {/* Level badge */}
            {!collapsed && (
              <div className="absolute -bottom-1 -right-1 flex items-center justify-center">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-amber-500 shadow-lg ring-1 ring-[var(--bg-elevated)]">
                  <Trophy size={9} className="text-amber-900/70" />
                </div>
              </div>
            )}
          </div>

          {/* User info */}
          {!collapsed && (
            <div className="ml-3 min-w-0 flex-1 text-left">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
                  {userName}
                </p>
                {role === "ADMIN" && (
                  <Crown size={12} className="shrink-0 text-amber-400" />
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-md bg-[var(--mc-grass)]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--mc-grass)]">
                  {levelText}
                </span>
                {role !== "ADMIN" && (
                  <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${roleBadgeClass}`}>
                    {roleLabel}
                  </span>
                )}
              </div>
            </div>
          )}
        </button>

        {/* Collapse button */}
        <button
          className={`mt-2 flex min-h-9 w-full items-center rounded-lg bg-[var(--surface-soft)] px-2 py-1.5 text-[var(--text-muted)] transition-all duration-[var(--duration-normal)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] ${
            canToggleCollapse ? "" : "cursor-not-allowed opacity-50"
          } ${collapsed ? "justify-center" : "justify-center lg:justify-start"}`}
          type="button"
          onClick={onToggleCollapse}
          disabled={!canToggleCollapse}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
        >
          {collapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
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

function getUserInitials(username: string): string {
  const trimmed = username.trim();
  if (trimmed.length <= 2) {
    return trimmed.toUpperCase();
  }
  // Get first character and last character
  return (trimmed[0] + trimmed[trimmed.length - 1]).toUpperCase();
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
    return "border-[#ff6b8f]/25 bg-[#ff6b8f]/10 text-[#ff6b8f]";
  }
  if (role === "SPONSOR") {
    return "border-[#25b87a]/25 bg-[#25b87a]/12 text-[#25b87a]";
  }
  return "bg-[var(--bg-elevated)] text-[var(--text-secondary)]";
}
