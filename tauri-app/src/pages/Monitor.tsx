import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import Card from "../components/Card";
import TitleBar from "../components/TitleBar";
import { useI18n } from "../i18n";
import type { GameRuntimeStats, UiLogPollResult } from "../types";
import { formatDuration, loadSettings, parseIntSafe, prefix } from "../utils/launcher";

type MonitorPageProps = {
  params: URLSearchParams;
};

export default function MonitorPage({ params }: MonitorPageProps) {
  const { t } = useI18n();
  const visualSettings = useMemo(() => loadSettings(), []);
  const activeBackgroundUrl = visualSettings.backgroundSource === "web-random" ? visualSettings.backgroundWebUrl : visualSettings.backgroundImage;
  const pid = parseIntSafe(params.get("pid"), 0);
  const startedAt = parseIntSafe(params.get("startedAt"), Date.now());
  const initialCursor = parseIntSafe(params.get("cursor"), 0);
  const version = params.get("version") ?? "unknown";

  const [logs, setLogs] = useState<string[]>([]);
  const [stats, setStats] = useState<GameRuntimeStats | null>(null);
  const [status, setStatus] = useState(t("monitor.connecting"));
  const [tick, setTick] = useState(Date.now());
  const [confirmAction, setConfirmAction] = useState<"stop" | "back" | null>(null);
  const [stopping, setStopping] = useState(false);

  const cursorRef = useRef<number | null>(initialCursor > 0 ? initialCursor : null);
  const pollingRef = useRef(false);

  useEffect(() => {
    let active = true;
    const pollLogs = async () => {
      if (!active || pollingRef.current) return;
      pollingRef.current = true;
      try {
        const args = cursorRef.current === null ? {} : { afterSeq: cursorRef.current };
        const out = await invoke<UiLogPollResult>("poll_ui_logs", args);
        if (!active) return;
        cursorRef.current = out.nextSeq;
        if (out.entries.length === 0) return;
        setLogs((prev) => {
          const next = [...prev, ...out.entries.map((entry) => `${prefix(entry)} ${entry.message}`)];
          return next.length > 4000 ? next.slice(next.length - 4000) : next;
        });
      } catch {
      } finally {
        pollingRef.current = false;
      }
    };

    const pollRuntime = async () => {
      if (pid <= 0) {
        setStatus(t("monitor.invalidPid"));
        return;
      }
      try {
        const out = await invoke<GameRuntimeStats>("poll_game_runtime", { pid });
        if (!active) return;
        setStats(out);
        setStatus(out.running ? t("monitor.processRunning") : t("monitor.processExited"));
      } catch (error) {
        if (!active) return;
        setStatus(t("monitor.runtimePollingFailed", { error: String(error) }));
      }
    };

    void pollLogs();
    void pollRuntime();
    const logsTimer = window.setInterval(() => void pollLogs(), 200);
    const runtimeTimer = window.setInterval(() => {
      void pollRuntime();
      setTick(Date.now());
    }, 1000);

    return () => {
      active = false;
      window.clearInterval(logsTimer);
      window.clearInterval(runtimeTimer);
    };
  }, [pid, t]);

  const uptimeMs = stats?.running === false ? null : stats?.elapsedMs ?? Math.max(0, tick - startedAt);
  const uptime = uptimeMs === null ? "N/A" : formatDuration(uptimeMs);
  const memory = stats?.memoryMb === null || stats?.memoryMb === undefined ? "N/A" : `${stats.memoryMb} MB`;

  async function backToLauncher() {
    await invoke("show_main_window");
    await getCurrentWindow().close();
  }

  async function stopGame(): Promise<boolean> {
    if (pid <= 0) {
      setStatus(t("monitor.invalidPid"));
      return false;
    }
    setStopping(true);
    setStatus(t("monitor.stopping"));
    try {
      const terminated = await invoke<boolean>("terminate_game_process", { pid, force: true });
      setStatus(terminated ? t("monitor.stopSent") : t("monitor.processExited"));
      return terminated;
    } catch (error) {
      setStatus(t("monitor.stopFailed", { error: String(error) }));
      return false;
    } finally {
      setStopping(false);
    }
  }

  async function confirmAndExecute() {
    if (!confirmAction) return;
    if (confirmAction === "stop") {
      await stopGame();
      setConfirmAction(null);
      return;
    }
    await stopGame();
    setConfirmAction(null);
    await backToLauncher();
  }

  return (
    <div className="appWindow relative overflow-hidden linear-backdrop">
      {activeBackgroundUrl && (
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <div
            className="absolute inset-0 bg-cover bg-center bg-no-repeat"
            style={{
              backgroundImage: `url("${activeBackgroundUrl}")`,
              opacity: visualSettings.backgroundOpacity / 100,
              filter: `blur(${visualSettings.backgroundBlur}px)`,
              transform: visualSettings.backgroundBlur > 0 ? "scale(1.06)" : "scale(1)"
            }}
          />
          <div className="absolute inset-0 bg-[var(--bg-primary)]/40" />
        </div>
      )}
      <div className="relative z-10">
        <TitleBar title={`${t("app.name")} Runtime ${version}`} subtitle={t("monitor.subtitle")} />
      </div>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col gap-3 p-3 md:p-4">
        <Card as="section" variant="frost" className="rounded-xl p-3.5 md:p-4" interactive={false}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">{t("monitor.brandTag")}</p>
              <h1 className="mt-1 text-2xl font-semibold text-[var(--text-primary)] md:text-3xl">{`${t("app.name")} ${version}`}</h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="ghostButton" onClick={() => setLogs([])} type="button">
                {t("monitor.clearLogs")}
              </button>
              <button className="ghostButton danger" onClick={() => setConfirmAction("stop")} disabled={stopping || !(stats?.running ?? true)} type="button">
                {t("monitor.endGame")}
              </button>
              <button className="primaryAction" onClick={() => setConfirmAction("back")} disabled={stopping} type="button">
                {t("monitor.backLauncher")}
              </button>
            </div>
          </div>
        </Card>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label={t("monitor.pid")} value={pid > 0 ? pid : "N/A"} />
          <StatCard label={t("monitor.status")} value={stats?.running ? t("monitor.running") : t("monitor.exited")} />
          <StatCard label={t("monitor.memory")} value={memory} />
          <StatCard label={t("monitor.uptime")} value={uptime} />
        </section>

        <Card as="section" variant="frost" className="flex min-h-0 flex-1 flex-col rounded-xl p-3.5" interactive={false}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("monitor.consoleOutput")}</h2>
            <span className="mutedPill">{status}</span>
          </div>
          <pre className="logBox h-full min-h-0 max-h-none">{logs.join("\n")}</pre>
        </Card>
      </main>

      {confirmAction && (
        <section className="modalOverlay">
          <Card variant="strong" className="w-full max-w-[680px] rounded-xl p-4" interactive={false}>
            <div className="panelHead">
              <h2>{t("monitor.confirmTitle")}</h2>
              <span className="mutedPill">{pid > 0 ? `pid=${pid}` : "pid=N/A"}</span>
            </div>
            <p className="minorHint">{t("monitor.confirmMessage")}</p>
            <div className="modalActions">
              <button className="ghostButton" onClick={() => setConfirmAction(null)} disabled={stopping} type="button">
                {t("monitor.cancel")}
              </button>
              <button className="primaryAction" onClick={() => void confirmAndExecute()} disabled={stopping} type="button">
                {confirmAction === "back" ? t("monitor.confirmBack") : t("monitor.confirmStop")}
              </button>
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card variant="soft" className="rounded-2xl p-3" interactive={false}>
      <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[var(--text-primary)]">{value}</p>
    </Card>
  );
}
