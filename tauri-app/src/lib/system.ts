// Thin wrappers over Tauri system commands + small timing helper.
// Extracted from App.tsx.
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { JdkEnsureResult, Locale } from "../types";

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

  const monitorLabel = `runtime-monitor-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const win = new WebviewWindow(monitorLabel, {
    title: `Runtime - ${instanceName}`,
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    decorations: false,
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
