import { memo, useState } from "react";
import { Compass, Gamepad2, Home, Settings, Stethoscope } from "lucide-react";
import AppLogo from "./AppLogo";
import { useI18n } from "../i18n";
import type { Page } from "../types";

type SidebarProps = {
  currentPage: Page;
  setPage: (page: Page) => void;
};

const RAIL = "w-[60px]";
const PANEL = "w-[236px]";

function Sidebar({ currentPage, setPage }: SidebarProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const navItems = [
    { id: "home" as const, icon: Home, label: t("nav.dashboard") },
    { id: "instances" as const, icon: Gamepad2, label: t("nav.myGames") },
    { id: "content" as const, icon: Compass, label: t("nav.content") },
    { id: "diagnostics" as const, icon: Stethoscope, label: t("nav.diagnostics") },
    { id: "settings" as const, icon: Settings, label: t("nav.settings") }
  ];

  // Label fades in only when expanded; stays in flow but clipped by the panel
  const labelCls = (extra = "") =>
    `${extra} whitespace-nowrap transition-opacity duration-150 ${
      expanded ? "opacity-100" : "pointer-events-none opacity-0"
    }`;

  return (
    // The <aside> reserves a fixed 60px rail in the layout; the inner panel is an
    // absolute overlay that expands on hover/focus without reflowing the content.
    <aside className={`relative z-30 h-full shrink-0 ${RAIL}`}>
      {/* Structural chrome stays quiet on purpose: under the liquid profile it
          gets only a translucent frost (see styles.css) — never the lensed
          LiquidGlass material, whose rim/shine layers read as a bright outline
          on a large flush panel. */}
      <div
        className={`app-sidebar-panel absolute inset-y-0 left-0 flex h-full flex-col overflow-hidden border-r border-white/8 bg-[var(--bg-secondary)] transition-[width] duration-200 ease-[var(--ease-standard)] ${
          expanded ? `${PANEL} shadow-[10px_0_30px_rgba(0,0,0,0.32)]` : RAIL
        }`}
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        onFocusCapture={() => setExpanded(true)}
        onBlurCapture={(event: React.FocusEvent<HTMLDivElement>) => {
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
              ((currentPage === "install" || currentPage === "instance-settings") && item.id === "instances");
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

      </div>
    </aside>
  );
}

export default memo(Sidebar);
