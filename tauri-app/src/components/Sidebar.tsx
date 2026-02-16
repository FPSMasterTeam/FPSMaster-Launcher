import { ChevronsLeft, ChevronsRight, Gamepad2, Home, Settings, User } from "lucide-react";
import { useI18n } from "../i18n";
import type { Page } from "../types";

type SidebarProps = {
  currentPage: Page;
  collapsed: boolean;
  canToggleCollapse: boolean;
  onToggleCollapse: () => void;
  setPage: (page: Page) => void;
};

export default function Sidebar({
  currentPage,
  collapsed,
  canToggleCollapse,
  onToggleCollapse,
  setPage
}: SidebarProps) {
  const { t } = useI18n();
  const navItems = [
    { id: "home" as const, icon: Home, label: t("nav.dashboard") },
    { id: "instances" as const, icon: Gamepad2, label: t("nav.myGames") },
    { id: "settings" as const, icon: Settings, label: t("nav.settings") }
  ];

  return (
    <div
      className={`relative z-20 flex h-full flex-col justify-between overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]/72 backdrop-blur-xl transition-[width] duration-[var(--duration-normal)] ${
        collapsed ? "w-[76px]" : "w-[76px] lg:w-[260px]"
      }`}
    >
      <div>
        <nav className="pt-3 flex flex-col gap-1 px-2 lg:px-3">
          {navItems.map((item) => {
            const active =
              currentPage === item.id ||
              ((currentPage === "install" || currentPage === "instance-settings") &&
                item.id === "instances");
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setPage(item.id)}
                className={`group relative flex w-full items-center overflow-hidden rounded-xl border p-3 transition-all duration-[var(--duration-normal)] active:scale-[0.99] ${
                  collapsed ? "justify-center" : "justify-center lg:justify-start"
                } ${
                  active
                    ? "border-[rgba(var(--accent-rgb),0.22)] bg-[var(--linear-card-bg)] text-[var(--text-primary)] shadow-[0_0_0_1px_rgba(var(--accent-rgb),var(--linear-hover-ring)),0_8px_18px_rgba(2,8,16,0.22),0_0_14px_rgba(var(--accent-rgb),var(--linear-hover-halo))]"
                    : "border-transparent text-[var(--text-secondary)] hover:border-[var(--border-subtle)] hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon
                  size={22}
                  className={`transition-colors duration-[var(--duration-normal)] ${
                    active ? "text-[var(--mc-grass)]" : "group-hover:text-[var(--text-primary)]"
                  }`}
                />
                <span
                  className={`ml-3 font-medium whitespace-nowrap ${collapsed ? "hidden" : "hidden lg:block"}`}
                  style={{ fontFamily: "Manrope, sans-serif" }}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="border-t border-[var(--border-subtle)] p-4">
        <button
          className={`group flex w-full items-center rounded-xl border border-transparent p-2.5 transition-all duration-[var(--duration-normal)] hover:border-[var(--border-medium)] hover:bg-[var(--surface-soft)] ${
            collapsed ? "justify-center" : "justify-center lg:justify-start"
          }`}
        >
          <div className="relative flex h-9 w-9 min-h-9 min-w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--bg-elevated)] ring-1 ring-[var(--border-medium)]">
            <div className="absolute inset-0 rounded-xl opacity-0 blur-xl transition-opacity duration-[var(--duration-normal)] group-hover:opacity-30 bg-[var(--mc-grass)]/30" />
            <User size={16} className="text-[var(--text-primary)]" />
          </div>
          <div className={`ml-3 text-left ${collapsed ? "hidden" : "hidden lg:block"}`}>
            <p
              className="text-sm font-semibold text-[var(--text-primary)] group-hover:text-[var(--mc-grass)] transition-colors whitespace-nowrap"
              style={{ fontFamily: "Manrope, sans-serif" }}
            >
              {t("nav.player")}
            </p>
            <p className="text-xs text-[var(--text-muted)] whitespace-nowrap" style={{ fontFamily: "Manrope, sans-serif" }}>
              {t("nav.pro")}
            </p>
          </div>
        </button>
        <button
          className={`mt-3 flex w-full items-center rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2.5 py-2 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] ${
            canToggleCollapse ? "" : "cursor-not-allowed opacity-50"
          } ${collapsed ? "justify-center" : "justify-center lg:justify-start"}`}
          type="button"
          onClick={onToggleCollapse}
          disabled={!canToggleCollapse}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          <span className={`ml-2 text-xs font-medium whitespace-nowrap ${collapsed ? "hidden" : "hidden lg:block"}`}>
            {collapsed ? t("nav.expand") : t("nav.collapse")}
          </span>
        </button>
      </div>
    </div>
  );
}
