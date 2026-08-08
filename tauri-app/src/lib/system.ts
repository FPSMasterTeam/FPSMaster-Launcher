// Thin wrappers over Tauri system commands + small timing helper.
// Extracted from App.tsx.
import { invoke } from "@tauri-apps/api/core";
import { getAllWebviewWindows, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { JdkEnsureResult, Locale } from "../types";
import { IS_MAC } from "../utils/platform";

const MONITOR_LABEL_PREFIX = "runtime-monitor-";

// Each launch spawns a fresh monitor window; close any leftover ones first so they
// don't pile up as zombie webviews still polling/re-rendering in the background.
async function closeExistingMonitorWindows(): Promise<void> {
  try {
    const windows = await getAllWebviewWindows();
    await Promise.all(
      windows
        .filter((win) => win.label.startsWith(MONITOR_LABEL_PREFIX))
        .map((win) => win.destroy().catch(() => win.close().catch(() => {})))
    );
  } catch {
    // best-effort cleanup
  }
}

export async function ensureJdk(
  gameDir: string,
  versionId: string,
  downloadThreads: number
): Promise<JdkEnsureResult> {
  return invoke<JdkEnsureResult>("ensure_jdk", { gameDir, versionId, downloadThreads });
}

export async function syncAutostart(enabled: boolean): Promise<void> {
  try {
    await invoke("set_launch_on_startup", { enabled });
  } catch {
    // best-effort
  }
}

export async function syncTrayBehavior(minimizeToTray: boolean): Promise<void> {
  try {
    await invoke("configure_tray_behavior", { minimizeToTray });
  } catch {
    // best-effort
  }
}

export async function openMonitor(
  pid: number,
  instanceName: string,
  cursor: number,
  locale: Locale
): Promise<WebviewWindow> {
  const params = new URLSearchParams({
    view: "monitor",
    pid: String(pid),
    version: instanceName,
    startedAt: String(Date.now()),
    cursor: String(cursor),
    lang: locale
  });

  await closeExistingMonitorWindows();

  const monitorLabel = `${MONITOR_LABEL_PREFIX}${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const win = new WebviewWindow(monitorLabel, {
    title: `Runtime - ${instanceName}`,
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    // macOS keeps native decorations (rounded corners + traffic lights overlaying
    // the custom title bar); other platforms draw fully custom chrome.
    ...(IS_MAC
      ? { decorations: true, titleBarStyle: "overlay" as const, hiddenTitle: true }
      : { decorations: false }),
    url: `/?${params.toString()}`
  });

  await new Promise<void>((resolve, reject) => {
    void win.once("tauri://created", () => resolve());
    void win.once("tauri://error", (event) => {
      reject(new Error(String((event as { payload?: unknown }).payload ?? "create monitor failed")));
    });
  });

  return win;
}

export function nextRecurringDelay(baseMs: number, jitterMs: number): number {
  if (jitterMs <= 0) {
    return baseMs;
  }
  const offset = Math.round((Math.random() * 2 - 1) * jitterMs);
  return Math.max(30_000, baseMs + offset);
}
