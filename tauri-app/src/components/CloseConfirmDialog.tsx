import Button from "./Button";
import Card from "./Card";
import ModalFrame from "./ModalFrame";
import { useI18n } from "../i18n";

type CloseConfirmDialogProps = {
  onChoose: (choice: "minimize" | "quit" | "stay") => void;
};

// Asked when the window is closed while downloads or installs are running.
export default function CloseConfirmDialog({ onChoose }: CloseConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <ModalFrame
      labelledBy="close-confirm-title"
      onEscape={() => onChoose("stay")}
      overlayClassName="fixed inset-0 z-[96] flex items-center justify-center bg-[var(--bg-primary)]/82 p-6"
    >
      <Card variant="frost" className="w-full max-w-md rounded-[10px] p-6" interactive={false}>
        <h3 id="close-confirm-title" className="text-lg font-semibold text-[var(--text-primary)]">
          {t("close.busy.title")}
        </h3>
        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{t("close.busy.message")}</p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => onChoose("stay")}>
            {t("close.busy.stay")}
          </Button>
          <Button size="sm" variant="danger" onClick={() => onChoose("quit")}>
            {t("close.busy.quit")}
          </Button>
          <Button size="sm" variant="primary" onClick={() => onChoose("minimize")}>
            {t("close.busy.minimize")}
          </Button>
        </div>
      </Card>
    </ModalFrame>
  );
}
