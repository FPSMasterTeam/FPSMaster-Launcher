import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { IS_MAC, MAC_TRAFFIC_LIGHT_INSET } from "../utils/platform";

type TitleBarProps = {
  title: string;
  subtitle?: string;
  onClose?: () => Promise<void>;
};

export default function TitleBar({ title, subtitle, onClose }: TitleBarProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    const win = getCurrentWindow();
    const syncMaximizedState = async () => {
      try {
        const maximized = await win.isMaximized();
        if (active) {
          setIsMaximized(maximized);
        }
      } catch {
      }
    };

    void syncMaximizedState();
    const unlisten = win.onResized(() => {
      void syncMaximizedState();
    });
    return () => {
      active = false;
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  const withGuard = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      console.error("Title bar action failed", error);
    } finally {
      setBusy(false);
    }
  };

  const toggleMaximize = () =>
    withGuard(async () => {
      const win = getCurrentWindow();
      await win.toggleMaximize();
      setIsMaximized(await win.isMaximized());
    });

  // Tauri only starts a window drag when the mousedown TARGET itself carries
  // data-tauri-drag-region, so every element layered over the bar needs the
  // attribute too — the header alone is almost fully covered by its children.
  return (
    <header className="customTitlebar" data-tauri-drag-region onDoubleClick={() => void toggleMaximize()}>
      <div
        className="titleMain"
        data-tauri-drag-region
        style={IS_MAC ? { paddingLeft: MAC_TRAFFIC_LIGHT_INSET } : undefined}
      >
        <div className="titleDragRegion" data-tauri-drag-region>
          <p className="titleText" data-tauri-drag-region>
            {title}
          </p>
          <p className="titleSubtext" data-tauri-drag-region>
            {subtitle ?? ""}
          </p>
        </div>
      </div>
      {!IS_MAC && (
      <div className="titleControls window-no-drag">
        <button
          className="titleBtn"
          type="button"
          onClick={() => withGuard(() => getCurrentWindow().minimize())}
          aria-label={t("window.minimize")}
        >
          <WindowControlIcon kind="minimize" />
        </button>
        <button
          className="titleBtn"
          type="button"
          onClick={() => void toggleMaximize()}
          aria-label={isMaximized ? t("window.restore") : t("window.maximize")}
        >
          <WindowControlIcon kind="maximize" maximized={isMaximized} />
        </button>
        <button
          className="titleBtn danger"
          type="button"
          onClick={() => withGuard(() => onClose?.() ?? getCurrentWindow().close())}
          aria-label={t("window.close")}
        >
          <WindowControlIcon kind="close" />
        </button>
      </div>
      )}
    </header>
  );
}

function WindowControlIcon({
  kind,
  maximized = false
}: {
  kind: "minimize" | "maximize" | "close";
  maximized?: boolean;
}) {
  if (kind === "minimize") {
    return (
      <svg className="titleBtnIcon" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 9h8" />
      </svg>
    );
  }
  if (kind === "close") {
    return (
      <svg className="titleBtnIcon" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" />
      </svg>
    );
  }
  if (maximized) {
    return (
      <svg className="titleBtnIcon" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 4.5h5v5h-5z" />
        <path d="M4.5 2.5h5v5" />
        <path d="M7.5 2.5h2v2" />
      </svg>
    );
  }
  return (
    <svg className="titleBtnIcon" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 2.5h7v7h-7z" />
    </svg>
  );
}
