import { FileText, FolderOpen, Stethoscope } from "lucide-react";
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
  onClose: () => void;
};

// Shown when a launched game exits abnormally (launcher-ui-20 / product-4):
// what crashed and where the evidence is. There is no upload any more: the
// FPSMaster backend that received crash reports has been shut down.
export default function CrashDialog({
  crash,
  instanceName,
  onOpenLogs,
  onOpenFile,
  onDiagnose,
  onClose
}: CrashDialogProps) {
  const { t } = useI18n();
  const summary = crash.crashSummary?.trim() || crash.hsErrSummary?.trim() || "";

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

        <div className="mt-6 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("crash.close")}
          </Button>
        </div>
      </Card>
    </ModalFrame>
  );
}
