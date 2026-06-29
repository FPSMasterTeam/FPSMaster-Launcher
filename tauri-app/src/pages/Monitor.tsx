import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, startTransition, useEffect, useRef, useState } from "react";
import Card from "../components/Card";
import TitleBar from "../components/TitleBar";
import { useI18n } from "../i18n";
import type { GameRuntimeStats, UiLogPollResult } from "../types";
import { formatDuration, parseIntSafe, prefix } from "../utils/launcher";

type MonitorPageProps = {
  params: URLSearchParams;
};

const MONITOR_LOG_POLL_INTERVAL_MS = 800;
const MONITOR_RUNTIME_POLL_INTERVAL_MS = 1000;
const MONITOR_UPTIME_TICK_INTERVAL_MS = 1000;
const MONITOR_LOG_FLUSH_INTERVAL_MS = 300;
const MONITOR_LOG_LINE_LIMIT = 1200;

function MonitorPage({ params }: MonitorPageProps) {
  const { t } = useI18n();
  const pid = parseIntSafe(params.get("pid"), 0);
  const monitorStartedAt = useRef(parseIntSafe(params.get("startedAt"), Date.now())).current;
  const initialCursor = parseIntSafe(params.get("cursor"), 0);
  const version = params.get("version") ?? "unknown";

  const [logLines, setLogLines] = useState<string[]>([]);
  const [stats, setStats] = useState<GameRuntimeStats | null>(null);
  const [status, setStatus] = useState(t("monitor.connecting"));
  const [tick, setTick] = useState(Date.now());
  const [exitedAt, setExitedAt] = useState<number | null>(null);
  const [confirmAction, setConfirmAction] = useState<"stop" | null>(null);
  const [stopping, setStopping] = useState(false);

  const cursorRef = useRef<number | null>(initialCursor > 0 ? initialCursor : null);
  const logsPollingRef = useRef(false);
  const runtimePollingRef = useRef(false);
  const logLinesRef = useRef<string[]>([]);
  const pendingLogLinesRef = useRef<string[]>([]);
  const flushLogsScheduledRef = useRef<number | null>(null);
  const logViewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (flushLogsScheduledRef.current !== null) {
        window.clearTimeout(flushLogsScheduledRef.current);
        flushLogsScheduledRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    const flushPendingLogs = () => {
      if (!active) return;
      flushLogsScheduledRef.current = null;
      if (pendingLogLinesRef.current.length === 0) return;
      logLinesRef.current = appendMonitorLogLines(logLinesRef.current, pendingLogLinesRef.current);
      pendingLogLinesRef.current = [];
      startTransition(() => {
        setLogLines(logLinesRef.current);
      });
    };

    const scheduleLogFlush = () => {
      if (flushLogsScheduledRef.current !== null) {
        return;
      }
      flushLogsScheduledRef.current = window.setTimeout(flushPendingLogs, MONITOR_LOG_FLUSH_INTERVAL_MS);
    };

    const pollLogs = async () => {
      if (!active || logsPollingRef.current) return;
      logsPollingRef.current = true;
      try {
        const args = cursorRef.current === null ? {} : { afterSeq: cursorRef.current };
        const out = await invoke<UiLogPollResult>("poll_ui_logs", args);
        if (!active) return;
        cursorRef.current = out.nextSeq;
        if (out.entries.length === 0) return;
        const lines = out.entries.map((entry) => `${prefix(entry)} ${entry.message}`);
        pendingLogLinesRef.current.push(...lines);
        scheduleLogFlush();
      } catch {
      } finally {
        logsPollingRef.current = false;
      }
    };

    const pollRuntime = async () => {
      if (!active || runtimePollingRef.current) return;
      if (pid <= 0) {
        setStatus(t("monitor.invalidPid"));
        return;
      }
      runtimePollingRef.current = true;
      try {
        const out = await invoke<GameRuntimeStats>("poll_game_runtime", { pid });
        if (!active) return;
        setStats((previous) => ({
          ...out,
          memoryMb: out.memoryMb ?? previous?.memoryMb ?? null
        }));
        if (out.running) {
          setExitedAt(null);
        } else {
          setExitedAt((previous) => previous ?? Date.now());
        }
        setStatus(out.running ? t("monitor.processRunning") : t("monitor.processExited"));
      } catch (error) {
        if (!active) return;
        setStatus(t("monitor.runtimePollingFailed", { error: String(error) }));
      } finally {
        runtimePollingRef.current = false;
      }
    };

    void pollLogs();
    void pollRuntime();
    const logsTimer = window.setInterval(() => void pollLogs(), MONITOR_LOG_POLL_INTERVAL_MS);
    const runtimeTimer = window.setInterval(() => {
      void pollRuntime();
    }, MONITOR_RUNTIME_POLL_INTERVAL_MS);
    const tickTimer = window.setInterval(() => {
      setTick(Date.now());
    }, MONITOR_UPTIME_TICK_INTERVAL_MS);

    return () => {
      active = false;
      if (flushLogsScheduledRef.current !== null) {
        window.clearTimeout(flushLogsScheduledRef.current);
        flushLogsScheduledRef.current = null;
      }
      window.clearInterval(logsTimer);
      window.clearInterval(runtimeTimer);
      window.clearInterval(tickTimer);
    };
  }, [pid, t]);

  useEffect(() => {
    const viewport = logViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [logLines]);

  const uptimeMs = Math.max(0, (exitedAt ?? tick) - monitorStartedAt);
  const uptime = formatDuration(uptimeMs);
  const memory = stats?.memoryMb === null || stats?.memoryMb === undefined ? "N/A" : `${stats.memoryMb} MB`;
  const runtimeStateLabel = stats?.running === false ? t("monitor.exited") : t("monitor.running");
  const pidLabel = pid > 0 ? pid : "N/A";

  async function backToLauncher() {
    await invoke("show_main_window");
    await closeMonitorWindow();
  }

  async function closeMonitorWindow() {
    try {
      await invoke("destroy_current_window");
    } catch {
      await getCurrentWindow().destroy();
    }
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
    }
  }

  return (
    <div className="appWindow monitorWindow">
      <div>
        <TitleBar title={version} onClose={closeMonitorWindow} />
      </div>

      <main className="monitorWorkspace monitorWorkspaceCompact">
        <Card as="section" variant="soft" className="monitorHeroCard monitorHeroCardCompact monitorPlainCard page-card rounded-[10px]" interactive={false}>
          <div className="monitorHeroHeader monitorHeroHeaderCompact">
            <div className="monitorHeroIdentity">
              <p className="page-eyebrow">{t("monitor.brandTag")}</p>
              <h1 className="monitorHeroTitle monitorHeroTitleCompact text-data">{version}</h1>
            </div>
            <div className="monitorActionRow">
              <button
                className="icon-button monitorUtilityButton !w-auto px-3"
                onClick={() => {
                  logLinesRef.current = [];
                  pendingLogLinesRef.current = [];
                  setLogLines([]);
                }}
                type="button"
              >
                {t("monitor.clearLogs")}
              </button>
              <button
                className="icon-button monitorUtilityButton !w-auto px-3"
                onClick={() => {
                  void backToLauncher();
                }}
                disabled={stopping}
                type="button"
              >
                {t("monitor.backLauncher")}
              </button>
              <button
                className="icon-button icon-button-danger monitorUtilityButton !w-auto px-3"
                onClick={() => setConfirmAction("stop")}
                disabled={stopping || !(stats?.running ?? true)}
                type="button"
              >
                {t("monitor.endGame")}
              </button>
            </div>
          </div>
          <div className="monitorSummaryStrip">
            <span className={`monitorStateBadge ${stats?.running === false ? "is-exited" : "is-running"}`}>{runtimeStateLabel}</span>
            <MetricRow label={t("monitor.memory")} value={memory} compact />
            <MetricRow label={t("monitor.uptime")} value={uptime} compact />
            <MetricRow label={t("monitor.pid")} value={pidLabel} compact />
            <span className="monitorStatusInline">{status}</span>
          </div>
        </Card>

        <Card as="section" variant="soft" className="monitorConsoleCard monitorConsoleCardExpanded monitorPlainCard page-card rounded-[10px]" interactive={false}>
          <div className="monitorConsoleHead monitorConsoleHeadCompact">
            <h2 className="monitorConsoleTitle">{t("monitor.consoleOutput")}</h2>
          </div>
          <div ref={logViewportRef} className="logBox monitorConsoleBody monitorConsoleBodyExpanded">
            <div className="monitorLogList">
              {logLines.map((line, index) => (
                <div key={`${index}-${line.slice(0, 32)}`} className="monitorLogLine">
                  {line}
                </div>
              ))}
            </div>
          </div>
        </Card>
      </main>

      {confirmAction && (
        <section className="modal-shell">
          <Card variant="soft" className="modal-card page-card monitorConfirmCard w-full max-w-[680px]" interactive={false}>
            <div className="modal-header !mb-3">
              <div>
                <p className="page-eyebrow">{t("monitor.confirmTitle")}</p>
                <h2 className="section-title mt-1 text-data">{version}</h2>
              </div>
              <span className="badge badge-muted normal-case tracking-normal">{pid > 0 ? `pid=${pid}` : "pid=N/A"}</span>
            </div>
            <p className="notice-text !mt-0">{t("monitor.confirmMessage")}</p>
            <div className="modalActions">
              <button className="icon-button !w-auto px-3" onClick={() => setConfirmAction(null)} disabled={stopping} type="button">
                {t("monitor.cancel")}
              </button>
              <button className="segment-chip is-active !min-h-10 px-4" onClick={() => void confirmAndExecute()} disabled={stopping} type="button">
                {t("monitor.confirmStop")}
              </button>
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}

function appendMonitorLogLines(current: string[], incoming: string[]): string[] {
  if (incoming.length === 0) {
    return current;
  }
  const next = current.length === 0 ? incoming : [...current, ...incoming];
  if (next.length <= MONITOR_LOG_LINE_LIMIT) {
    return next;
  }
  return next.slice(next.length - MONITOR_LOG_LINE_LIMIT);
}

function MetricRow({
  label,
  value,
  compact = false
}: {
  label: string;
  value: string | number;
  compact?: boolean;
}) {
  return (
    <div className={`monitorMetricRow ${compact ? "is-compact" : ""}`}>
      <span className="monitorMetricLabel">{label}</span>
      <strong className="monitorMetricValue text-data">{value}</strong>
    </div>
  );
}

export default memo(MonitorPage);
