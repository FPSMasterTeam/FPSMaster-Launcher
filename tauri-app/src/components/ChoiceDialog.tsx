import Button from "./Button";
import Card from "./Card";
import ModalFrame from "./ModalFrame";

type ChoiceAction = {
  label: string;
  variant: "primary" | "secondary" | "ghost" | "danger";
  onClick: () => void;
};

type ChoiceDialogProps = {
  id: string;
  title: string;
  message: string;
  actions: ChoiceAction[];
  /** Escape. */
  onDismiss: () => void;
};

// A small question with a few answers (close during downloads, autostart,
// tray notice).
export default function ChoiceDialog({ id, title, message, actions, onDismiss }: ChoiceDialogProps) {
  return (
    <ModalFrame
      labelledBy={`${id}-title`}
      onEscape={onDismiss}
      overlayClassName="fixed inset-0 z-[96] flex items-center justify-center bg-[var(--bg-primary)]/82 p-6"
    >
      <Card variant="frost" className="w-full max-w-md rounded-[10px] p-6" interactive={false}>
        <h3 id={`${id}-title`} className="text-lg font-semibold text-[var(--text-primary)]">
          {title}
        </h3>
        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{message}</p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {actions.map((action) => (
            <Button key={action.label} size="sm" variant={action.variant} onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      </Card>
    </ModalFrame>
  );
}
