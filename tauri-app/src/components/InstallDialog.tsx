import Card from "./Card";
import { useI18n } from "../i18n";
import type { InstallDialogState, InstallPhaseState } from "../types";

type InstallDialogProps = {
  dialog: InstallDialogState;
  onClose: () => void;
};

export default function InstallDialog({ dialog, onClose }: InstallDialogProps) {
  const { t } = useI18n();

  return (
    <section className="modalOverlay">
      <Card variant="strong" className="w-full max-w-[760px] max-h-[88vh] overflow-auto rounded-[var(--radius-xl)] p-4">
        <div className="panelHead">
          <h2>{t("dialog.installing", { version: dialog.versionId })}</h2>
          <span className="mutedPill">{t("dialog.session", { id: dialog.sessionId.slice(-6) })}</span>
        </div>
        <p className="minorHint">{t("dialog.hint")}</p>
        <InstallPhaseView phase={dialog.vanilla} />
        {dialog.loaderPhase && <InstallPhaseView phase={dialog.loaderPhase} />}
        {dialog.errorText !== "" && <pre className="errorBox">{dialog.errorText}</pre>}
        <div className="modalActions">
          <button className="primaryAction" disabled={!dialog.canClose} onClick={onClose}>
            {t("dialog.confirm")}
          </button>
        </div>
      </Card>
    </section>
  );
}

function InstallPhaseView({ phase }: { phase: InstallPhaseState }) {
  const { t } = useI18n();
  const percent =
    phase.total > 0
      ? Math.min(100, Math.floor((phase.current / phase.total) * 100))
      : phase.status === "done"
        ? 100
        : 0;

  const stage = translateStage(phase.stage, t);
  const status = translateStatus(phase.status, t);

  return (
    <Card as="article" variant="soft" className="mt-3 rounded-[var(--radius-md)] p-3">
      <div className="phaseHeadRow">
        <p className="phaseTitle">{phase.title}</p>
        <p className={`phaseStatus ${phase.status}`}>{status}</p>
      </div>
      <p className="phaseMeta">{t("dialog.stage", { stage })}</p>
      <p className="phaseMeta">{phase.message || t("dialog.waiting")}</p>
      <div className="progressTrack">
        <div className="progressFill" style={{ width: `${percent}%` }} />
      </div>
      <p className="phaseMeta">
        {t("dialog.progress", {
          current: phase.current,
          total: phase.total || "?",
          downloaded: phase.downloaded,
          cached: phase.cached
        })}
      </p>
    </Card>
  );
}

function translateStatus(
  status: InstallPhaseState["status"],
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (status === "done") return t("dialog.status.done");
  if (status === "running") return t("dialog.status.running");
  if (status === "error") return t("dialog.status.error");
  return t("dialog.status.pending");
}

function translateStage(stage: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (stage === "prepare") return t("dialog.stage.prepare");
  if (stage === "complete") return t("dialog.stage.complete");
  if (stage === "failed") return t("dialog.stage.failed");
  return stage || t("dialog.stage.default");
}
