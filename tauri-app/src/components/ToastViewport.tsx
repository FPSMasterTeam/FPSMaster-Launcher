import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { memo, useSyncExternalStore } from "react";
import { useI18n } from "../i18n";
import {
  dismissToast,
  getToastSnapshot,
  subscribeToasts,
  type Toast,
  type ToastTone
} from "../lib/toast";

const TONE_ICON: Record<ToastTone, typeof Info> = {
  error: XCircle,
  warning: AlertTriangle,
  success: CheckCircle2,
  info: Info
};

// Stacked notifications for failures the user would otherwise never see.
// Sits above modals so an error raised while a dialog is open is still readable.
function ToastViewport() {
  const { t } = useI18n();
  const toasts = useSyncExternalStore(subscribeToasts, getToastSnapshot, getToastSnapshot);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toastViewport" role="region" aria-label={t("toast.regionLabel")}>
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} dismissLabel={t("toast.dismiss")} />
      ))}
    </div>
  );
}

function ToastRow({ toast, dismissLabel }: { toast: Toast; dismissLabel: string }) {
  const Icon = TONE_ICON[toast.tone];
  return (
    <div className={`toastRow toastRow-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      <span className="toastIcon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="toastBody">
        {toast.title ? <p className="toastTitle">{toast.title}</p> : null}
        <p className="toastMessage">{toast.message}</p>
      </div>
      <button
        type="button"
        className="toastClose"
        aria-label={dismissLabel}
        title={dismissLabel}
        onClick={() => dismissToast(toast.id)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export default memo(ToastViewport);
