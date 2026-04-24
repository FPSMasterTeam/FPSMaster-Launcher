import Card from "./Card";
import { useI18n } from "../i18n";
import type { InstallDialogState, InstallPhaseState, LaunchPrepareItem, LaunchPrepareItemStatus } from "../types";

type InstallDialogProps = {
  dialog: InstallDialogState;
  onClose: () => void;
  onCancel: () => void;
};

export default function InstallDialog({ dialog, onClose, onCancel }: InstallDialogProps) {
  const { t } = useI18n();

  return (
    <section className="modalOverlay">
      <Card variant="strong" className="installDialogCard w-full max-w-[780px] rounded-3xl p-5 md:p-6" interactive={false}>
        <div className="panelHead">
          <h2 className="flex items-center gap-2">
            {!dialog.canClose ? <span className="installDialogSpinner minecraft-inline-spinner" aria-hidden="true" /> : null}
            {t("dialog.installing", { version: dialog.versionId })}
          </h2>
          <span className="mutedPill">{t("dialog.session", { id: dialog.sessionId.slice(-6) })}</span>
        </div>
        <div className="installDialogBody">
          <p className="minorHint">{t("dialog.hint")}</p>

          <div className="installDialogPhaseStack">
            <InstallPhaseView phase={dialog.vanilla} />
            {dialog.loaderPhase && <InstallPhaseView phase={dialog.loaderPhase} />}
            {dialog.optiFinePhase && <InstallPhaseView phase={dialog.optiFinePhase} />}
          </div>
          {dialog.errorText !== "" && <pre className="errorBox installDialogErrorBox">{dialog.errorText}</pre>}
        </div>

        <div className="modalActions">
          {dialog.canClose ? (
            <button className="primaryAction" onClick={onClose} type="button">
              {t("dialog.confirm")}
            </button>
          ) : (
            <button className="primaryAction" disabled={dialog.cancelling} onClick={onCancel} type="button">
              {dialog.cancelling ? t("dialog.cancelling") : t("dialog.cancelInstall")}
            </button>
          )}
        </div>
      </Card>
    </section>
  );
}

function InstallPhaseView({ phase }: { phase: InstallPhaseState }) {
  const { t } = useI18n();
  const percent = phase.total > 0 ? Math.min(100, Math.floor((phase.current / phase.total) * 100)) : phase.status === "done" ? 100 : 0;

  const stage = translateStage(phase.stage, t);
  const status = translateStatus(phase.status, t);

  return (
    <Card as="article" variant="soft" className="mt-3 rounded-2xl p-4" interactive={false}>
      <div className="phaseHeadRow">
        <p className="phaseTitle">{phase.title}</p>
        <p className={`phaseStatus ${phase.status}`}>
          {phase.status === "running" ? <span className="installDialogSpinner minecraft-inline-spinner" aria-hidden="true" /> : null}
          {status}
        </p>
      </div>
      <p className="phaseMeta">{t("dialog.stage", { stage })}</p>
      <p className="phaseMeta">{phase.message || t("dialog.waiting")}</p>
      <div className="progressTrack">
        <div className="progressFill" style={{ width: `${percent}%` }} />
      </div>
      {phase.total > 0 ? <p className="phaseMeta">{t("dialog.simpleProgress", { current: phase.current, total: phase.total })}</p> : null}
      {phase.items.length > 0 ? (
        <div className="installFileList mt-3">
          {phase.items.map((item) => (
            <InstallItemRow key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function InstallItemRow({ item }: { item: LaunchPrepareItem }) {
  const { t } = useI18n();
  const percent =
    item.totalBytes && item.totalBytes > 0
      ? Math.min(100, Math.floor((item.currentBytes / item.totalBytes) * 100))
      : item.status === "done" || item.status === "cached"
        ? 100
        : 0;

  return (
    <div className={`installFileRow ${item.status}`}>
      <div className="installFileRowMain">
        <span className={`installFileStatus ${item.status}`}>{translateItemStatus(item.status, t)}</span>
        <p className="installFileName" title={item.name}>{item.name}</p>
        <span className="installFilePercent">{item.totalBytes && item.totalBytes > 0 ? `${percent}%` : item.status === "done" || item.status === "cached" ? "100%" : "--"}</span>
      </div>
      <div className="progressTrack installFileTrack">
        <div className="progressFill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function translateStatus(status: InstallPhaseState["status"], t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "done") return t("dialog.status.done");
  if (status === "running") return t("dialog.status.running");
  if (status === "error") return t("dialog.status.error");
  return t("dialog.status.pending");
}

function translateItemStatus(status: LaunchPrepareItemStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "pending") return t("launch.prepare.item.pending");
  if (status === "done") return t("launch.prepare.item.done");
  if (status === "cached") return t("launch.prepare.item.cached");
  if (status === "error") return t("launch.prepare.item.error");
  return t("launch.prepare.item.running");
}

function translateStage(stage: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (stage === "prepare") return t("dialog.stage.prepare");
  if (stage === "complete") return t("dialog.stage.complete");
  if (stage === "failed") return t("dialog.stage.failed");
  return stage || t("dialog.stage.default");
}
