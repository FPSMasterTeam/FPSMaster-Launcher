import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Download,
  LoaderCircle,
  RefreshCw,
  Stethoscope,
  Wrench,
  X,
  XCircle
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { Checkbox } from "../components/Checkbox";
import { LAUNCHER_API_BASE_URL } from "../constants";
import { useI18n, type TranslationKey } from "../i18n";
import { formatByteSize } from "../lib/launchPrepare";
import { describeApiError, isCancelledError } from "../lib/launcherError";
import { notifyError, notifyInfo, notifySuccess } from "../lib/toast";
import type { HealthCheckItem, HealthReport, Settings, SupportBundleResult } from "../types";
import { createSessionId } from "../utils/launcher";

type DiagnosticsPageProps = {
  /** On-disk version id of the instance to check (null: global checks only). */
  versionId: string | null;
  instanceName: string | null;
  settings: Settings;
  busy: boolean;
  onRepairInstance: () => void;
  onOpenSettings: () => void;
};

type Translator = ReturnType<typeof useI18n>["t"];

// Fixes that need something only the user can give: consent to store the
// credential key in a file, or a save location.
const CONSENT_FIXES = new Set(["secure_storage_set_file_fallback"]);
// Codes without a backend fix command that the instance repair resolves.
const REPAIR_INSTANCE_CODES = new Set(["NATIVE_APP_INCOMPLETE", "INSTANCE_PROFILE_UNREADABLE"]);
const SOURCE_CODES = new Set(["SOURCE_SLOW", "SOURCE_UNREACHABLE"]);

const KNOWN_CODES = new Set([
  "JAVA_RUNTIME_OK",
  "JAVA_RUNTIME_INCOMPLETE",
  "JAVA_RUNTIME_MISSING",
  "INSTANCE_FILES_OK",
  "INSTANCE_FILES_MISSING",
  "INSTANCE_FILES_CORRUPTED",
  "INSTANCE_PROFILE_UNREADABLE",
  "NATIVE_APP_INCOMPLETE",
  "DISK_SPACE_OK",
  "DISK_SPACE_LOW",
  "DISK_SPACE_CRITICAL",
  "DISK_UNKNOWN",
  "SOURCE_OK",
  "SOURCE_SLOW",
  "SOURCE_UNREACHABLE",
  "CREDENTIAL_STORE_OK",
  "CREDENTIAL_STORE_UNAVAILABLE",
  "CREDENTIAL_STORE_ACCESS_DENIED",
  "NO_RECENT_CRASHES",
  "RECENT_CRASHES"
]);

function sourceLabel(id: unknown, t: Translator): string {
  if (id === "official") return t("diagnostics.source.official");
  if (id === "bmclapi") return t("diagnostics.source.bmclapi");
  if (id === "fpsmaster-api") return t("diagnostics.source.api");
  return String(id ?? "");
}

// Turns the backend's raw params into display values for the locale templates.
function displayParams(item: HealthCheckItem, t: Translator): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(item.params)) {
    if (value === null || value === undefined) continue;
    if (key === "freeBytes" || key === "totalBytes") {
      out[key] = formatByteSize(Number(value));
    } else if (key === "bytesPerSecond") {
      out[key] = `${formatByteSize(Number(value))}/s`;
    } else if (key === "source") {
      out[key] = sourceLabel(value, t);
    } else if (typeof value === "string" || typeof value === "number") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.join(", ");
    }
  }
  // Templates must never show a raw "{placeholder}" when the backend omits a value.
  for (const key of ["latencyMs", "bytesPerSecond", "latestSummary", "backend", "major", "versionId", "runtime"]) {
    out[key] ??= "-";
  }
  return out;
}

function itemText(item: HealthCheckItem, t: Translator): { title: string; description: string } {
  const params = displayParams(item, t);
  if (!KNOWN_CODES.has(item.code)) {
    return { title: item.code, description: item.detail };
  }
  return {
    title: t(`diagnostics.code.${item.code}.title` as TranslationKey, params),
    description: t(`diagnostics.code.${item.code}.desc` as TranslationKey, params)
  };
}

function StatusIcon({ status }: { status: HealthCheckItem["status"] }) {
  if (status === "ok") return <CheckCircle2 size={18} className="shrink-0 text-[var(--mc-grass)]" />;
  if (status === "warning") return <AlertTriangle size={18} className="shrink-0 text-amber-300" />;
  if (status === "error") return <XCircle size={18} className="shrink-0 text-[var(--accent-danger)]" />;
  return <CircleSlash size={18} className="shrink-0 text-[var(--text-muted)]" />;
}

function DiagnosticsPage({
  versionId,
  instanceName,
  settings,
  busy,
  onRepairInstance,
  onOpenSettings
}: DiagnosticsPageProps) {
  const { t } = useI18n();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [deep, setDeep] = useState(false);
  const [fixing, setFixing] = useState<{ itemId: string; sessionId: string } | null>(null);
  const [fixingAll, setFixingAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState<SupportBundleResult | null>(null);
  const requestRef = useRef(0);

  const runCheck = useCallback(
    async (deepCheck: boolean) => {
      const requestId = ++requestRef.current;
      setChecking(true);
      try {
        const next = await invoke<HealthReport>("run_health_check", {
          gameDir: settings.gameDir,
          versionId,
          apiBaseUrl: LAUNCHER_API_BASE_URL,
          deep: deepCheck
        });
        if (requestRef.current === requestId) setReport(next);
      } catch (error) {
        if (requestRef.current === requestId) notifyError(describeApiError(error, t), t("diagnostics.checkFailed"));
      } finally {
        if (requestRef.current === requestId) setChecking(false);
      }
    },
    [settings.gameDir, versionId, t]
  );

  useEffect(() => {
    void runCheck(false);
  }, [runCheck]);

  async function exportBundle() {
    let targetPath: string | undefined;
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const picked = await save({
        title: t("diagnostics.exportTitle"),
        defaultPath: `fpsmaster-support-${stamp}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }]
      });
      if (picked === null) return;
      targetPath = picked;
    } catch (error) {
      // No native dialog (browser dev): the backend writes to <gameDir>/exports.
      console.warn("[diagnostics] save dialog unavailable:", error);
    }
    setExporting(true);
    try {
      const result = await invoke<SupportBundleResult>("export_support_bundle", {
        gameDir: settings.gameDir,
        versionId,
        healthReport: report,
        targetPath
      });
      setLastExport(result);
      notifySuccess(t("diagnostics.exportDone", { path: result.path }));
    } catch (error) {
      notifyError(describeApiError(error, t), t("diagnostics.exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  async function runFix(item: HealthCheckItem): Promise<boolean> {
    if (!item.fix) return false;
    if (item.fix.command === "export_support_bundle") {
      await exportBundle();
      return true;
    }
    if (CONSENT_FIXES.has(item.fix.command) && !window.confirm(t("diagnostics.fileFallbackConsent"))) {
      return false;
    }
    const sessionId = createSessionId();
    setFixing({ itemId: item.id, sessionId });
    try {
      await invoke(item.fix.command, {
        ...item.fix.args,
        downloadSource: settings.downloadSource,
        downloadThreads: settings.downloadThreads,
        ipcSession: sessionId
      });
      return true;
    } catch (error) {
      if (isCancelledError(error)) {
        notifyInfo(t("error.cancelled"));
      } else {
        notifyError(describeApiError(error, t), t("diagnostics.fixFailed"));
      }
      return false;
    } finally {
      setFixing(null);
    }
  }

  async function fixOne(item: HealthCheckItem) {
    if (await runFix(item)) {
      notifySuccess(t("diagnostics.fixDone"));
      await runCheck(deep);
    }
  }

  // Runs every fix that needs no extra input from the user, then re-checks.
  async function fixAll() {
    const items = (report?.items ?? []).filter(
      (item) =>
        item.status !== "ok" &&
        item.fix &&
        !CONSENT_FIXES.has(item.fix.command) &&
        item.fix.command !== "export_support_bundle"
    );
    if (items.length === 0) return;
    setFixingAll(true);
    let fixed = 0;
    try {
      for (const item of items) {
        if (!(await runFix(item))) break;
        fixed += 1;
      }
    } finally {
      setFixingAll(false);
    }
    if (fixed > 0) notifySuccess(t("diagnostics.fixAllDone", { count: fixed }));
    await runCheck(deep);
  }

  async function cancelFix() {
    if (!fixing) return;
    try {
      await invoke("cancel_install", { sessionId: fixing.sessionId });
    } catch (error) {
      console.warn("[diagnostics] cancel failed:", error);
    }
  }

  const items = report?.items ?? [];
  const problems = items.filter((item) => item.status === "error" || item.status === "warning");
  const autoFixable = problems.filter(
    (item) => item.fix && !CONSENT_FIXES.has(item.fix.command) && item.fix.command !== "export_support_bundle"
  );
  const working = checking || fixing !== null || fixingAll;

  return (
    <div className="page-shell h-full overflow-y-auto">
      <header className="page-header mb-6">
        <div className="page-header-main">
          <p className="page-eyebrow">{t("diagnostics.eyebrow")}</p>
          <h1 className="page-title">{t("diagnostics.title")}</h1>
          <p className="page-subtitle">
            {instanceName ? t("diagnostics.subtitleInstance", { name: instanceName }) : t("diagnostics.subtitle")}
          </p>
        </div>
        <div className="page-header-actions flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Checkbox checked={deep} onCheckedChange={(value) => setDeep(value === true)} />
            {t("diagnostics.deep")}
          </label>
          <Button variant="secondary" size="sm" className="gap-2" disabled={working} onClick={() => void runCheck(deep)}>
            {checking ? <LoaderCircle size={14} className="minecraft-inline-spinner" /> : <RefreshCw size={14} />}
            {t("diagnostics.run")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="gap-2"
            disabled={working || busy || autoFixable.length === 0}
            onClick={() => void fixAll()}
          >
            <Wrench size={14} />
            {t("diagnostics.fixAll")}
          </Button>
          <Button variant="secondary" size="sm" className="gap-2" disabled={exporting} onClick={() => void exportBundle()}>
            <Download size={14} />
            {exporting ? t("diagnostics.exporting") : t("diagnostics.export")}
          </Button>
        </div>
      </header>

      {lastExport && (
        <div className="notice mb-5">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[var(--mc-grass)]" />
          <div className="min-w-0 flex-1">
            <p className="notice-text !mt-0 break-all">{t("diagnostics.exportDone", { path: lastExport.path })}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">{t("diagnostics.exportHint")}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void invoke("open_downloaded_file", { filePath: lastExport.path }).catch((error) =>
                notifyError(describeApiError(error, t))
              )
            }
          >
            {t("diagnostics.openFile")}
          </Button>
        </div>
      )}

      {report && !checking && (
        <p className="mb-4 text-sm text-[var(--text-secondary)]">
          {problems.length === 0
            ? t("diagnostics.summaryOk")
            : t("diagnostics.summaryProblems", { count: problems.length })}
        </p>
      )}

      {!report && checking ? (
        <div className="empty-state">
          <Stethoscope size={40} className="empty-state-icon" />
          <p className="empty-state-title">{t("diagnostics.checking")}</p>
          <p className="empty-state-text">{t("diagnostics.checkingHint")}</p>
        </div>
      ) : (
        <div className="surface-list" aria-busy={checking}>
          {items.map((item) => {
            const text = itemText(item, t);
            const itemFixing = fixing?.itemId === item.id;
            const showRepairInstance = item.status !== "ok" && REPAIR_INSTANCE_CODES.has(item.code);
            const showSourceSettings = item.status !== "ok" && SOURCE_CODES.has(item.code);
            const showFix = item.status !== "ok" && item.fix !== null;
            return (
              <Card key={item.id} variant="frost" className="page-card page-card-compact rounded-[10px]" interactive={false}>
                <div className="flex items-start gap-3">
                  <StatusIcon status={item.status} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[var(--text-primary)]">{text.title}</p>
                    <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{text.description}</p>
                    {item.detail && item.status !== "ok" && (
                      <p className="text-data mt-1 break-all text-[11px] text-[var(--text-muted)]">{item.detail}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {itemFixing && (
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void cancelFix()}
                        aria-label={t("common.cancel")}
                        title={t("common.cancel")}
                      >
                        <X size={14} />
                      </button>
                    )}
                    {showFix && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="gap-2"
                        disabled={working || busy}
                        onClick={() => void fixOne(item)}
                      >
                        {itemFixing ? <LoaderCircle size={14} className="minecraft-inline-spinner" /> : <Wrench size={14} />}
                        {item.fix?.command === "export_support_bundle" ? t("diagnostics.export") : t("diagnostics.fix")}
                      </Button>
                    )}
                    {showRepairInstance && (
                      <Button variant="secondary" size="sm" className="gap-2" disabled={working || busy} onClick={onRepairInstance}>
                        <Wrench size={14} />
                        {t("diagnostics.repairInstance")}
                      </Button>
                    )}
                    {showSourceSettings && (
                      <Button variant="ghost" size="sm" onClick={onOpenSettings}>
                        {t("diagnostics.openSourceSettings")}
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(DiagnosticsPage);
