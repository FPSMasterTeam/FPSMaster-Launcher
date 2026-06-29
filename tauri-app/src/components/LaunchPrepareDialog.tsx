import Card from "./Card";
import { useI18n } from "../i18n";
import type { LaunchPrepareDialogState, LaunchPrepareItem, LaunchPrepareItemStatus } from "../types";

type LaunchPrepareDialogProps = {
  dialog: LaunchPrepareDialogState;
  onClose: () => void;
};

export default function LaunchPrepareDialog({ dialog, onClose }: LaunchPrepareDialogProps) {
  const { t } = useI18n();
  const activePhase =
    dialog.phases.find((phase) => phase.status === "running") ??
    dialog.phases.find((phase) => phase.status === "error") ??
    dialog.phases[dialog.phases.length - 1];

  const percent =
    activePhase && activePhase.total > 0
      ? Math.min(100, Math.floor((activePhase.current / activePhase.total) * 100))
      : activePhase?.status === "done"
        ? 100
        : 0;

  const items = (activePhase?.items ?? []).slice(0, 4);

  return (
    <section className="modalOverlay">
      <Card variant="strong" className="w-full max-w-[560px] rounded-[10px] p-5 md:p-6" interactive={false}>
        <div className="panelHead">
          <div>
            <h2>{t("launch.prepare.title", { name: dialog.instanceName })}</h2>
            <p className="minorHint mt-1">{activePhase?.title ?? t("launch.progress.preparing")}</p>
          </div>
          <span className="mutedPill">{t("dialog.session", { id: dialog.sessionId.slice(-6) })}</span>
        </div>

        <div className="launchPrepareCompact">
          <div className="launchPrepareCompactTop">
            <p className="launchPrepareCompactTitle">{activePhase?.title ?? t("launch.progress.preparing")}</p>
            <p className={`phaseStatus ${activePhase?.status ?? "pending"}`}>
              {translateStatus(activePhase?.status ?? "pending", t)}
            </p>
          </div>

          <p className="phaseMeta">{activePhase?.message || t("dialog.waiting")}</p>

          <div className="progressTrack launchPrepareCompactTrack">
            <div className="progressFill" style={{ width: `${percent}%` }} />
          </div>

          <div className="launchPrepareCompactMeta">
            <span>{t("launch.prepare.percent", { percent })}</span>
            {activePhase && activePhase.total > 0 && (
              <span>{t("dialog.progress", {
                current: activePhase.current,
                total: activePhase.total,
                downloaded: activePhase.downloaded,
                cached: activePhase.cached
              })}</span>
            )}
          </div>

          {items.length > 0 && (
            <div className="launchPrepareCompactItems">
              {items.map((item) => (
                <LaunchPrepareItemRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>

        {dialog.errorText !== "" && <pre className="errorBox">{dialog.errorText}</pre>}

        <div className="modalActions">
          <button className="primaryAction" disabled={!dialog.canClose} onClick={onClose} type="button">
            {dialog.canClose ? t("dialog.confirm") : t("launch.prepare.running")}
          </button>
        </div>
      </Card>
    </section>
  );
}

function LaunchPrepareItemRow({ item }: { item: LaunchPrepareItem }) {
  const { t } = useI18n();
  const percent =
    item.totalBytes && item.totalBytes > 0
      ? Math.min(100, Math.floor((item.currentBytes / item.totalBytes) * 100))
      : item.status === "done" || item.status === "cached"
        ? 100
        : 0;

  return (
    <div className={`launchPrepareCompactItem ${item.status}`}>
      <div className="launchPrepareCompactItemHead">
        <p className="launchPrepareCompactItemName" title={item.name}>{item.name}</p>
        <span className={`launchPrepareItemBadge ${item.status}`}>{translateItemStatus(item.status, t)}</span>
      </div>
      <div className="progressTrack launchPrepareItemTrack">
        <div className="progressFill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function translateStatus(status: "pending" | "running" | "done" | "error", t: ReturnType<typeof useI18n>["t"]): string {
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
