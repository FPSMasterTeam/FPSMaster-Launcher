import { memo } from "react";
import Button from "./Button";
import Card from "./Card";
import { useI18n } from "../i18n";

type LaunchErrorDialogProps = {
  message: string;
  onConfirm: () => void;
};

// Modal shown when a game launch fails, surfacing the raw error text.
function LaunchErrorDialog({ message, onConfirm }: LaunchErrorDialogProps) {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-[var(--bg-primary)]/82 p-6">
      <Card variant="frost" className="w-full max-w-lg rounded-2xl p-6" interactive={false}>
        <h3 className="text-xl font-semibold text-[var(--accent-danger)]">{t("launch.error.title")}</h3>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{t("launch.error.subtitle")}</p>
        <div className="mt-4 rounded-xl border border-[#ff6b8f]/25 bg-[#ff6b8f]/10 px-4 py-3">
          <p className="text-sm leading-6 text-[var(--text-primary)] break-all">{message}</p>
        </div>
        <div className="mt-6 flex justify-end">
          <Button size="sm" variant="primary" onClick={onConfirm}>
            {t("launch.error.confirm")}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default memo(LaunchErrorDialog);
