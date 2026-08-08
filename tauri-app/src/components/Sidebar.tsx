import { memo, useState } from "react";
import { Compass, Crown, Gamepad2, Home, Server, Settings } from "lucide-react";
import AppLogo from "./AppLogo";
import { useI18n } from "../i18n";
import type { LauncherUser, Page } from "../types";

type SidebarProps = {
  currentPage: Page;
  user: LauncherUser | null;
  setPage: (page: Page) => void;
};

const RAIL = "w-[60px]";
const PANEL = "w-[236px]";

function Sidebar({ currentPage, user, setPage }: SidebarProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const navItems = [
    { id: "home" as const, icon: Home, label: t("nav.dashboard") },
    { id: "instances" as const, icon: Gamepad2, label: t("nav.myGames") },
    { id: "servers" as const, icon: Server, label: t("nav.servers") },
    { id: "content" as const, icon: Compass, label: t("nav.content") },
    { id: "settings" as const, icon: Settings, label: t("nav.settings") }
  ];

  const userName = resolveUserName(user, t("nav.player"));
  const role = resolveUserRole(user);
  const roleLabel = resolveUserRoleLabel(role, t);
  const levelText = resolveUserLevel(user, role);
  const roleBadgeClass = resolveRoleBadgeClass(role);
  const userAvatarUrl = user?.avatarUrl?.trim();
  const userInitials = getUserInitials(userName);

  // Label fades in only when expanded; stays in flow but clipped by the panel
  const labelCls = (extra = "") =>
    `${extra} whitespace-nowrap transition-opacity duration-150 ${
      expanded ? "opacity-100" : "pointer-events-none opacity-0"
    }`;

  return (
    // The <aside> reserves a fixed 60px rail in the layout; the inner panel is an
    // absolute overlay that expands on hover/focus without reflowing the content.
    <aside className={`relative z-30 h-full shrink-0 ${RAIL}`}>
      <div
        className={`absolute inset-y-0 left-0 flex h-full flex-col overflow-hidden border-r border-white/8 bg-[var(--bg-secondary)] transition-[width] duration-200 ease-[var(--ease-standard)] ${
          expanded ? `${PANEL} shadow-[10px_0_30px_rgba(0,0,0,0.32)]` : RAIL
        }`}
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        onFocusCapture={() => setExpanded(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setExpanded(false);
          }
        }}
      >
        {/* Brand */}
        <div className="py-3 pl-4 pr-2.5">
          <div className="flex min-h-9 items-center">
            <AppLogo size={28} className="shrink-0 rounded-lg" />
            <div className={labelCls("ml-3 min-w-0")}>
              <p className="truncate text-sm font-semibold text-[var(--text-primary)]">FPSMaster</p>
              <p className="truncate text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">Launcher</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 px-2.5 py-1">
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
                className={`group relative flex min-h-10 w-full cursor-pointer items-center overflow-hidden rounded-lg py-2 pl-[11px] pr-3 transition-colors duration-150 active:scale-[0.99] ${
                  active
                    ? "bg-[var(--surface-hover)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)]"
                }`}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                title={expanded ? undefined : item.label}
                type="button"
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-[var(--mc-grass)]" aria-hidden="true" />
                )}
                <Icon size={18} className={`shrink-0 transition-colors ${active ? "text-[var(--mc-grass)]" : "group-hover:text-[var(--text-primary)]"}`} />
                <span className={labelCls("ml-3 text-sm font-medium")}>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Account */}
        <div className="border-t border-white/5 p-2.5">
          <button
            className="group flex w-full cursor-pointer items-center overflow-hidden rounded-lg py-1.5 pl-0 pr-2.5 transition-colors hover:bg-[var(--surface-soft)]"
            type="button"
            aria-label={userName}
            title={expanded ? undefined : userName}
            onClick={() => setPage("account-center")}
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-white/8 bg-[var(--bg-elevated)]">
              {userAvatarUrl ? (
                <img src={userAvatarUrl} alt={userName} className="h-full w-full rounded-[8px] object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-[var(--text-secondary)]">
                  {userInitials}
                </div>
              )}
            </div>
            <div className={labelCls("ml-3 min-w-0 flex-1 text-left")}>
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{userName}</p>
                {role === "ADMIN" && <Crown size={12} className="shrink-0 text-amber-400" />}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-data inline-flex items-center rounded-[5px] bg-[var(--mc-grass)]/12 px-1.5 py-0.5 text-[11px] font-semibold text-[var(--mc-grass)]">
                  {levelText}
                </span>
                {role !== "ADMIN" && (
                  <span className={`rounded-[5px] px-1.5 py-0.5 text-[10px] font-semibold ${roleBadgeClass}`}>
                    {roleLabel}
                  </span>
                )}
              </div>
            </div>
          </button>
        </div>
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
    return "bg-[var(--accent-danger)]/14 text-[var(--accent-danger)]";
  }
  if (role === "SPONSOR") {
    return "bg-[#25b87a]/14 text-[#25b87a]";
  }
  return "bg-[var(--chip-bg)] text-[var(--text-secondary)]";
}

export default memo(Sidebar);
