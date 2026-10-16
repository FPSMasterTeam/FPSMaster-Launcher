import { FileText, FolderOpen, LoaderCircle, Send, Stethoscope } from "lucide-react";
import { useState } from "react";
import Button from "./Button";
import Card from "./Card";
import ModalFrame from "./ModalFrame";
import { useI18n } from "../i18n";
import type { GameExitEvent } from "../types";
import { formatDuration } from "../utils/launcher";

type CrashDialogProps = {
  crash: GameExitEvent;
  instanceName: string;
  /** Instance logs folder; null when the client keeps its logs elsewhere (Extreme). */
  onOpenLogs: (() => void) | null;
  onOpenFile: (path: string) => void;
  onDiagnose: () => void;
  /** Uploads the crash report; resolves once sent (or silently dropped on 429). */
  onUpload: () => Promise<void>;
  onClose: () => void;
};

// Shown when a launched game exits abnormally (launcher-ui-20 / product-4):
// what crashed, where the evidence is, and an opt-in report upload.
export default function CrashDialog({
  crash,
  instanceName,
  onOpenLogs,
  onOpenFile,
  onDiagnose,
  onUpload,
  onClose
}: CrashDialogProps) {
  const { t } = useI18n();
  const [uploadState, setUploadState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [uploadError, setUploadError] = useState("");
  const summary = crash.crashSummary?.trim() || crash.hsErrSummary?.trim() || "";
  const canUpload = Boolean(crash.crashReportPath || crash.hsErrPath);

  async function upload() {
    setUploadState("sending");
    setUploadError("");
    try {
      await onUpload();
      setUploadState("sent");
    } catch (error) {
      setUploadState("failed");
      setUploadError(String(error instanceof Error ? error.message : error));
    }
  }

  return (
    <ModalFrame
      labelledBy="crash-dialog-title"
      onEscape={onClose}
      overlayClassName="fixed inset-0 z-[94] flex items-center justify-center bg-[var(--bg-primary)]/82 p-6"
    >
      <Card variant="frost" className="w-full max-w-xl rounded-[10px] p-6" interactive={false}>
        <h3 id="crash-dialog-title" className="text-xl font-semibold text-[var(--accent-danger)]">
          {t("crash.title", { name: instanceName })}
        </h3>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          {t("crash.subtitle", { code: crash.exitCode, duration: formatDuration(crash.durationMs) })}
        </p>

        <div className="mt-4 rounded-[8px] border border-[#ff6b8f]/25 bg-[#ff6b8f]/10 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
            {t("crash.summary")}
          </p>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs leading-5 text-[var(--text-primary)]">
            {summary || t("crash.noSummary")}
          </pre>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {crash.crashReportPath && (
            <Button size="sm" variant="secondary" className="gap-2" onClick={() => onOpenFile(crash.crashReportPath!)}>
              <FileText size={14} />
              {t("crash.openReport")}
            </Button>
          )}
          {crash.hsErrPath && (
            <Button size="sm" variant="secondary" className="gap-2" onClick={() => onOpenFile(crash.hsErrPath!)}>
              <FileText size={14} />
              {t("crash.openHsErr")}
            </Button>
          )}
          {onOpenLogs && (
            <Button size="sm" variant="secondary" className="gap-2" onClick={onOpenLogs}>
              <FolderOpen size={14} />
              {t("crash.openLogs")}
            </Button>
          )}
          <Button size="sm" variant="secondary" className="gap-2" onClick={onDiagnose}>
            <Stethoscope size={14} />
            {t("crash.diagnose")}
          </Button>
        </div>

        {canUpload && (
          <div className="mt-5 rounded-[8px] border border-white/8 bg-black/15 px-4 py-3">
            <p className="text-sm leading-6 text-[var(--text-secondary)]">{t("crash.uploadExplain")}</p>
            {uploadState === "sent" ? (
              <p className="mt-2 text-sm text-[var(--mc-grass)]">{t("crash.uploadDone")}</p>
            ) : (
              <Button
                size="sm"
                variant="primary"
                className="mt-3 gap-2"
                disabled={uploadState === "sending"}
                onClick={() => void upload()}
              >
                {uploadState === "sending" ? <LoaderCircle size={14} className="minecraft-inline-spinner" /> : <Send size={14} />}
                {t("crash.uploadConsent")}
              </Button>
            )}
            {uploadState === "failed" && (
              <p className="mt-2 text-xs text-[var(--accent-danger)]" role="alert">
                {t("crash.uploadFailed", { error: uploadError })}
              </p>
            )}
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("crash.close")}
          </Button>
        </div>
      </Card>
    </ModalFrame>
  );
}
