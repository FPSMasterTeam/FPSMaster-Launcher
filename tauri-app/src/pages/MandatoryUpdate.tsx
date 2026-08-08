import { memo } from "react";
import { AlertTriangle, Download, ShieldAlert } from "lucide-react";
import Button from "../components/Button";
import Card from "../components/Card";
import ChangelogNotes from "../components/ChangelogNotes";
import { useI18n } from "../i18n";
import type { DownloadedLauncherUpdate, LauncherAppUpdateInfo } from "../types";

type MandatoryUpdatePageProps = {
  launcherUpdate: LauncherAppUpdateInfo | null;
  launcherUpdateDownloading: boolean;
  launcherUpdateDownload: DownloadedLauncherUpdate | null;
  onInstallLauncherUpdate: () => void;
};

function MandatoryUpdatePage({
  launcherUpdate,
  launcherUpdateDownloading,
  launcherUpdateDownload,
  onInstallLauncherUpdate,
}: MandatoryUpdatePageProps) {
  const { t } = useI18n();
  const notes = launcherUpdate?.notes?.trim() ?? "";

  return (
    <div className="page-shell page-shell-centered">
      <div className="flex max-h-full min-h-0 w-full max-w-3xl">
        <Card variant="strong" className="page-card page-card-roomy mandatory-update-card rounded-[10px] border border-amber-500/25 bg-amber-500/8" interactive={false}>
          <div className="flex shrink-0 flex-col gap-6 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="badge badge-warning gap-2 rounded-[5px] px-3 py-1 text-[11px]">
                <ShieldAlert size={14} />
                {t("mandatoryUpdate.badge")}
              </div>
              <h1 className="page-title mt-4 md:text-4xl">
                {t("mandatoryUpdate.title")}
              </h1>
              <p className="page-subtitle mt-3 max-w-2xl text-sm md:text-base">
                {t("mandatoryUpdate.description")}
              </p>
            </div>

            <div className="surface-panel rounded-[10px] border-amber-400/20 bg-[var(--bg-secondary)]/75 px-4 py-3 text-sm text-[var(--text-secondary)]">
              <div className="field-label !mb-0">
                {t("mandatoryUpdate.summaryLabel")}
              </div>
              <div className="mt-2 text-lg font-semibold text-[var(--text-primary)]">
                {launcherUpdate?.version ?? "--"}
              </div>
              <div className="mt-1 text-xs text-[var(--text-muted)]">
                {launcherUpdate?.target ?? t("mandatoryUpdate.targetUnknown")}
              </div>
            </div>
          </div>

          <div className="mandatory-update-grid">
            <Card variant="soft" className="page-card min-w-0 rounded-[10px]" interactive={false}>
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <AlertTriangle size={16} className="text-amber-300" />
                {t("mandatoryUpdate.blockedTitle")}
              </div>
              <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                {t("mandatoryUpdate.blockedDesc")}
              </p>
            </Card>

            <Card variant="soft" className="page-card min-w-0 rounded-[10px]" interactive={false}>
              <div className="text-sm font-semibold text-[var(--text-primary)]">
                {notes ? t("mandatoryUpdate.notesTitle") : t("mandatoryUpdate.nextTitle")}
              </div>
              {notes ? (
                <ChangelogNotes
                  notes={notes}
                  className="mt-3 text-sm leading-6 text-[var(--text-secondary)]"
                />
              ) : (
                <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                  {t("mandatoryUpdate.nextDesc")}
                </p>
              )}
              {launcherUpdateDownload ? (
                <p className="mt-3 text-xs text-[var(--text-muted)]">
                  {t("mandatoryUpdate.downloaded", { file: launcherUpdateDownload.fileName })}
                </p>
              ) : null}
            </Card>
          </div>

          <div className="mt-8 flex shrink-0 flex-wrap gap-3">
            <Button
              variant="primary"
              size="lg"
              className="gap-2 !rounded-[10px]"
              onClick={onInstallLauncherUpdate}
              disabled={!launcherUpdate || launcherUpdateDownloading}
            >
              <Download size={16} />
              {launcherUpdateDownloading ? t("mandatoryUpdate.installing") : t("mandatoryUpdate.install")}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default memo(MandatoryUpdatePage);
