import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { memo, useState } from "react";
import AppLogo from "./AppLogo";
import LiquidGlass from "./LiquidGlass";
import { useI18n } from "../i18n";
import { IS_MAC, MAC_TRAFFIC_LIGHT_INSET } from "../utils/platform";

type WindowTitleBarProps = {
  version?: string;
  onClose: () => Promise<void> | void;
};

// Self-contained window chrome. Owns its own "busy" guard state so window
// actions never re-render the rest of the launcher, and so the title bar
// itself (memoized) stays put when unrelated app state changes.
//
// On macOS the window keeps native decorations (titleBarStyle: Overlay), so the
// native traffic lights render over this bar's left edge — we only reserve
// space for them and never draw our own controls.
function WindowTitleBar({ version, onClose }: WindowTitleBarProps) {
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
    // Persistent floating chrome: Liquid Glass under the liquid profile. The
    // material layers are pointer-events: none, so drag regions keep working.
    <LiquidGlass
      as="div"
      mode="standard"
      displacementScale={44}
      aberrationIntensity={1.4}
      className="app-titlebar"
      data-tauri-drag-region
    >
      <div
        className="app-titlebar-main"
        data-tauri-drag-region
        style={IS_MAC ? { paddingLeft: MAC_TRAFFIC_LIGHT_INSET } : undefined}
      >
        <AppLogo size={18} className="pointer-events-none rounded-[5px]" />
        <span className="app-titlebar-name" data-tauri-drag-region>
          {t("app.name")}
        </span>
        {version && (
          <span className="app-titlebar-chip text-data" data-tauri-drag-region>
            v{version}
          </span>
        )}
      </div>
      {!IS_MAC && (
        <div className="app-titlebar-controls window-no-drag" data-no-drag="true">
          <button
            type="button"
            className="app-titlebar-btn window-no-drag"
            data-no-drag="true"
            aria-label={t("window.minimize")}
            onClick={() => guard(() => getCurrentWindow().minimize())}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            className="app-titlebar-btn window-no-drag"
            data-no-drag="true"
            aria-label={t("window.maximize")}
            onClick={() => guard(() => getCurrentWindow().toggleMaximize())}
          >
            <Square size={11} />
          </button>
          <button
            type="button"
            className="app-titlebar-btn is-danger window-no-drag"
            data-no-drag="true"
            aria-label={t("window.close")}
            onClick={() => guard(onClose)}
          >
            <X size={13} />
          </button>
        </div>
      )}
    </LiquidGlass>
  );
}

export default memo(WindowTitleBar);
