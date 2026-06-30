import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Power, Trash2 } from "lucide-react";
import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type { GameRuntimeStats, UiLogPollResult } from "../types";
import { formatDuration, prefix } from "../utils/launcher";

// The monitor renders as a view inside the main window (not a separate webview window),
// so it takes plain props and a close callback instead of URL params + window controls.
type MonitorPageProps = {
  pid: number;
  version: string;
  initialCursor: number;
  startedAt: number;
  onClose: () => void;
};

const MONITOR_LOG_POLL_INTERVAL_MS = 1000;
const MONITOR_RUNTIME_POLL_INTERVAL_MS = 2000;
const MONITOR_UPTIME_TICK_INTERVAL_MS = 1000;
const MONITOR_LOG_FLUSH_INTERVAL_MS = 300;
const MONITOR_LOG_LINE_LIMIT = 1000;
const MONITOR_LOG_LINE_HEIGHT = 18;
const MONITOR_LOG_OVERSCAN = 12;

function MonitorPage({ pid, version, initialCursor, startedAt, onClose }: MonitorPageProps) {
  const { t } = useI18n();
  const monitorStartedAt = useRef(startedAt).current;

  const [logLines, setLogLines] = useState<string[]>([]);
  const [stats, setStats] = useState<GameRuntimeStats | null>(null);
  const [status, setStatus] = useState(t("monitor.connecting"));
  const [tick, setTick] = useState(startedAt);
  const [exitedAt, setExitedAt] = useState<number | null>(null);
  const [confirmAction, setConfirmAction] = useState<"stop" | null>(null);
  const [stopping, setStopping] = useState(false);

  const cursorRef = useRef<number | null>(initialCursor > 0 ? initialCursor : null);
  const logsPollingRef = useRef(false);
  const runtimePollingRef = useRef(false);
  const logLinesRef = useRef<string[]>([]);
  const pendingLogLinesRef = useRef<string[]>([]);
  const flushLogsScheduledRef = useRef<number | null>(null);
  const logsTimerRef = useRef<number | null>(null);
  const runtimeTimerRef = useRef<number | null>(null);
  const tickTimerRef = useRef<number | null>(null);
  const winddownRef = useRef(false);

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

    // Once the game process has exited there is nothing more to sample. Keeping the
    // 1s runtime/uptime polls and the 800ms log rescan running forever pegs the
    // renderer and makes the window unresponsive (buttons, close). Stop the live
    // updates after one final log catch-up so the window goes genuinely idle.
    const windDown = () => {
      if (winddownRef.current) return;
      winddownRef.current = true;
      if (runtimeTimerRef.current !== null) {
        window.clearInterval(runtimeTimerRef.current);
        runtimeTimerRef.current = null;
      }
      if (tickTimerRef.current !== null) {
        window.clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
      // Catch any final lines, then stop log polling too.
      void pollLogs();
      window.setTimeout(() => {
        void pollLogs();
        if (logsTimerRef.current !== null) {
          window.clearInterval(logsTimerRef.current);
          logsTimerRef.current = null;
        }
      }, 1500);
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
        if (!out.running) {
          windDown();
        }
      } catch (error) {
        if (!active) return;
        setStatus(t("monitor.runtimePollingFailed", { error: String(error) }));
      } finally {
        runtimePollingRef.current = false;
      }
    };

    void pollLogs();
    void pollRuntime();
    logsTimerRef.current = window.setInterval(() => void pollLogs(), MONITOR_LOG_POLL_INTERVAL_MS);
    runtimeTimerRef.current = window.setInterval(() => {
      void pollRuntime();
    }, MONITOR_RUNTIME_POLL_INTERVAL_MS);
    tickTimerRef.current = window.setInterval(() => {
      setTick(Date.now());
    }, MONITOR_UPTIME_TICK_INTERVAL_MS);

    return () => {
      active = false;
      if (flushLogsScheduledRef.current !== null) {
        window.clearTimeout(flushLogsScheduledRef.current);
        flushLogsScheduledRef.current = null;
      }
      if (logsTimerRef.current !== null) {
        window.clearInterval(logsTimerRef.current);
        logsTimerRef.current = null;
      }
      if (runtimeTimerRef.current !== null) {
        window.clearInterval(runtimeTimerRef.current);
        runtimeTimerRef.current = null;
      }
      if (tickTimerRef.current !== null) {
        window.clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
    };
  }, [pid, t]);

  const uptimeMs = Math.max(0, (exitedAt ?? tick) - monitorStartedAt);
  const uptime = formatDuration(uptimeMs);
  const memory = stats?.memoryMb === null || stats?.memoryMb === undefined ? "N/A" : `${stats.memoryMb} MB`;
  const runtimeStateLabel = stats?.running === false ? t("monitor.exited") : t("monitor.running");
  const pidLabel = pid > 0 ? pid : "N/A";

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
    <div className="monitorEmbeddedRoot">
      <main className="monitorWorkspace monitorWorkspaceCompact">
        <Card as="section" variant="soft" className="monitorHeroCard monitorHeroCardCompact monitorPlainCard page-card rounded-[10px]" interactive={false}>
          <div className="monitorHeroHeader monitorHeroHeaderCompact">
            <div className="monitorHeroIdentity">
              <p className="page-eyebrow">{t("monitor.brandTag")}</p>
              <h1 className="monitorHeroTitle monitorHeroTitleCompact text-data">{version}</h1>
            </div>
            <div className="monitorActionRow">
              <button
                className="monitorIconBtn"
                title={t("monitor.clearLogs")}
                aria-label={t("monitor.clearLogs")}
                onClick={() => {
                  logLinesRef.current = [];
                  pendingLogLinesRef.current = [];
                  setLogLines([]);
                }}
                type="button"
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
              <button
                className="monitorIconBtn"
                title={t("monitor.backLauncher")}
                aria-label={t("monitor.backLauncher")}
                onClick={onClose}
                disabled={stopping}
                type="button"
              >
                <ArrowLeft size={16} aria-hidden="true" />
              </button>
              <button
                className="monitorIconBtn monitorIconBtn-danger"
                title={t("monitor.endGame")}
                aria-label={t("monitor.endGame")}
                onClick={() => setConfirmAction("stop")}
                disabled={stopping || !(stats?.running ?? true)}
                type="button"
              >
                <Power size={16} aria-hidden="true" />
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
          <LogConsole lines={logLines} />
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

// Virtualized console: renders only the lines in (and just around) the viewport, so the
// DOM and its GPU layer stay tiny regardless of how many lines or how long they are.
// A non-virtualized log grows into a huge wide/tall layer that the compositor keeps
// re-managing — costly even when the window is idle and nothing is changing.
const LogConsole = memo(function LogConsole({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(360);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= MONITOR_LOG_LINE_HEIGHT * 2;
    setScrollTop(el.scrollTop);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep following the tail when the user is pinned to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
  }, [lines]);

  const total = lines.length;
  const totalHeight = total * MONITOR_LOG_LINE_HEIGHT;
  const start = Math.max(0, Math.floor(scrollTop / MONITOR_LOG_LINE_HEIGHT) - MONITOR_LOG_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / MONITOR_LOG_LINE_HEIGHT) + MONITOR_LOG_OVERSCAN * 2;
  const end = Math.min(total, start + visibleCount);
  const visible = lines.slice(start, end);

  return (
    <div
      ref={scrollRef}
      className="logBox monitorConsoleBody monitorConsoleBodyExpanded monitorLogScroll"
      onScroll={onScroll}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ position: "absolute", top: start * MONITOR_LOG_LINE_HEIGHT, left: 0, right: 0 }}>
          {visible.map((line, index) => (
            <div key={start + index} className="monitorLogRow">
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

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
