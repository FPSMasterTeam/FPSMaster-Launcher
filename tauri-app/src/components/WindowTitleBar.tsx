import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { memo, useState } from "react";
import AppLogo from "./AppLogo";
import { useI18n } from "../i18n";

type WindowTitleBarProps = {
  authenticated: boolean;
  onClose: () => Promise<void> | void;
};

// Self-contained window chrome. Owns its own "busy" guard state so window
// actions never re-render the rest of the launcher, and so the title bar
// itself (memoized) stays put when unrelated app state changes.
function WindowTitleBar({ authenticated, onClose }: WindowTitleBarProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function guard(action: () => Promise<void> | void) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      console.error("Window action failed", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed left-0 right-0 top-0 z-50 flex h-10 items-center justify-between border-b border-white/5 bg-[var(--bg-secondary)]/92 px-3"
      data-tauri-drag-region
    >
      <div
        className={`flex min-w-0 flex-1 items-center ${authenticated ? "gap-2" : "gap-3"}`}
        data-tauri-drag-region
      >
        {!authenticated && <AppLogo size={24} className="rounded-md" />}
        <span className="truncate text-sm font-semibold tracking-wide text-[var(--text-secondary)]">
          {t("app.name")}
        </span>
      </div>
      <div className="flex h-full items-center gap-0.5 window-no-drag" data-no-drag="true">
        <button
          type="button"
          className="h-full px-4 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-soft)] hover:shadow-[inset_0_0_0_1px_var(--border-subtle)] transition-all duration-150 window-no-drag"
          data-no-drag="true"
          onClick={() => guard(() => getCurrentWindow().minimize())}
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          className="h-full px-4 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-soft)] hover:shadow-[inset_0_0_0_1px_var(--border-subtle)] transition-all duration-150 window-no-drag"
          data-no-drag="true"
          onClick={() => guard(() => getCurrentWindow().toggleMaximize())}
        >
          <Square size={11} />
        </button>
        <button
          type="button"
          className="h-full px-4 text-[var(--text-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 hover:shadow-[inset_0_0_0_1px_var(--accent-danger)] transition-all duration-150 window-no-drag"
          data-no-drag="true"
          onClick={() => guard(onClose)}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

export default memo(WindowTitleBar);
