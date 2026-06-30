import { useState } from "react";
import Card from "./Card";
import { useI18n } from "../i18n";
import type {
  LaunchPrepareDialogState,
  LaunchPrepareItem,
  LaunchPrepareItemStatus,
  LaunchPreparePhaseKey
} from "../types";

type LaunchPrepareDialogProps = {
  dialog: LaunchPrepareDialogState;
  onClose: () => void;
};

// Maps every phase onto one of four macro steps used to estimate overall progress:
// 0 login · 1 prepare files (check/verify/install/mods) · 2 runtime · 3 launch.
// Which file-prep sub-phases actually run varies (fresh install vs. verify-only), so
// collapsing them into a single macro step keeps the total bar stable across paths.
const MACRO_STEP: Record<LaunchPreparePhaseKey, number> = {
  login: 0,
  "check-instance": 1,
  verify: 1,
  vanilla: 1,
  fabric: 1,
  forge: 1,
  optifine: 1,
  mods: 1,
  runtime: 2,
  launch: 3
};
const MACRO_TOTAL = 4;
const MAX_VISIBLE_ITEMS = 6;

export default function LaunchPrepareDialog({ dialog, onClose }: LaunchPrepareDialogProps) {
  const { t } = useI18n();
  const activePhase =
    dialog.phases.find((phase) => phase.status === "running") ??
    dialog.phases.find((phase) => phase.status === "error") ??
    dialog.phases[dialog.phases.length - 1];

  const taskPercent =
    activePhase && activePhase.total > 0
      ? Math.min(100, Math.floor((activePhase.current / activePhase.total) * 100))
      : activePhase?.status === "done"
        ? 100
        : 0;

  // Estimated overall progress. The dialog is remounted per session (keyed on
  // sessionId), so this latch resets each launch and only ever advances within one.
  // Guarded render-phase setState is React's documented pattern for adjusting state
  // from new props — it stays monotonic without an effect.
  const macroStep = activePhase ? MACRO_STEP[activePhase.key] : 0;
  const rawTotal = Math.min(100, Math.round(((macroStep + taskPercent / 100) / MACRO_TOTAL) * 100));
  const [latchedTotal, setLatchedTotal] = useState(rawTotal);
  if (rawTotal > latchedTotal) {
    setLatchedTotal(rawTotal);
  }
  const totalPercent = Math.max(latchedTotal, rawTotal);

  const allItems = activePhase?.items ?? [];
  const items = allItems.slice(0, MAX_VISIBLE_ITEMS);
  const hasError = dialog.errorText !== "";

  return (
    <section className="modalOverlay">
      <Card variant="strong" className="w-full max-w-[560px] rounded-[10px] p-5 md:p-6" interactive={false}>
        <div className="panelHead">
          <div>
            <h2>{t("launch.prepare.title", { name: dialog.instanceName })}</h2>
            <p className="minorHint mt-1">{dialog.versionId || activePhase?.title || t("launch.progress.preparing")}</p>
          </div>
          <span className="mutedPill">{t("dialog.session", { id: dialog.sessionId.slice(-6) })}</span>
        </div>

        <div className="launchPrepareCompact">
          <div className="launchPrepareBars">
            <div className="launchPrepareBar">
              <div className="launchPrepareBarHead">
                <span className="launchPrepareBarLabel">{t("launch.prepare.total")}</span>
                <span className="launchPrepareBarPercent">{t("launch.prepare.percent", { percent: totalPercent })}</span>
              </div>
              <div className="progressTrack launchPrepareTotalTrack">
                <div className="progressFill launchPrepareTotalFill" style={{ width: `${totalPercent}%` }} />
              </div>
            </div>

            <div className="launchPrepareBar">
              <div className="launchPrepareBarHead">
                <span className="launchPrepareBarLabel" title={activePhase?.title}>
                  {activePhase?.title ?? t("launch.prepare.currentTask")}
                </span>
                <span className={`phaseStatus ${activePhase?.status ?? "pending"}`}>
                  {translateStatus(activePhase?.status ?? "pending", t)}
                </span>
              </div>
              <div className="progressTrack">
                <div className={`progressFill ${activePhase?.status === "error" ? "isError" : ""}`} style={{ width: `${taskPercent}%` }} />
              </div>
              <div className="launchPrepareBarMeta">
                <span className="launchPrepareBarMessage" title={activePhase?.message || undefined}>
                  {activePhase?.message || t("dialog.waiting")}
                </span>
                {activePhase && activePhase.total > 0 && (
                  <span className="launchPrepareBarCounts">
                    {t("dialog.progress", {
                      current: activePhase.current,
                      total: activePhase.total,
                      downloaded: activePhase.downloaded,
                      cached: activePhase.cached
                    })}
                  </span>
                )}
              </div>
            </div>
          </div>

          {items.length > 0 && (
            <div className="launchPrepareFiles">
              <div className="launchPrepareFilesHead">
                <span>{t("launch.prepare.filesTitle")}</span>
                {allItems.length > items.length && (
                  <span>{t("launch.prepare.filesShown", { shown: items.length, total: allItems.length })}</span>
                )}
              </div>
              <div className="launchPrepareFileList">
                {items.map((item) => (
                  <LaunchPrepareFileRow key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}
        </div>

        {hasError && <pre className="errorBox">{dialog.errorText}</pre>}

        <div className="modalActions">
          <button className="primaryAction" disabled={!dialog.canClose} onClick={onClose} type="button">
            {dialog.canClose ? t("dialog.confirm") : t("launch.prepare.running")}
          </button>
        </div>
      </Card>
    </section>
  );
}

function LaunchPrepareFileRow({ item }: { item: LaunchPrepareItem }) {
  const { t } = useI18n();
  const percent =
    item.totalBytes && item.totalBytes > 0
      ? Math.min(100, Math.floor((item.currentBytes / item.totalBytes) * 100))
      : item.status === "done" || item.status === "cached"
        ? 100
        : 0;

  return (
    <div className={`launchPrepareFileRow ${item.status}`}>
      <span className="launchPrepareFileName" title={item.name}>{item.name}</span>
      <div className="progressTrack launchPrepareFileTrack">
        <div className="progressFill" style={{ width: `${percent}%` }} />
      </div>
      <span className={`launchPrepareFileBadge ${item.status}`}>{translateItemStatus(item.status, t)}</span>
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
