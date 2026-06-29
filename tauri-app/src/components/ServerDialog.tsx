import { ExternalLink, Play, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import Button from "./Button";
import Card from "./Card";
import type { Instance, ServerItem } from "../types";

type ServerDialogProps = {
  server: ServerItem | null;
  closing: boolean;
  onClose: () => void;
  onLaunch: () => void;
  currentInstance: Instance | null;
  busy: boolean;
  launching: boolean;
  launchProgressPercent: number | null;
};

export default function ServerDialog({
  server,
  closing,
  onClose,
  onLaunch,
  currentInstance,
  busy,
  launching,
  launchProgressPercent,
}: ServerDialogProps) {
  const { t } = useI18n();

  if (!server || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`modal-shell ${closing ? "modal-backdrop-animate-out" : "modal-backdrop-animate"}`}
      onClick={onClose}
    >
      <Card
        variant="strong"
        className={`${closing ? "modal-animate-out" : "modal-animate"} modal-card page-card w-full max-w-2xl`}
        interactive={false}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="flex items-center gap-4 min-w-0">
            <div className="icon-tile h-16 w-16 rounded-[10px] shrink-0">
              {server.iconUrl ? (
                <img src={server.iconUrl} alt={server.name} className="h-full w-full object-cover" />
              ) : server.iconPath ? (
                <img src={server.iconPath} alt={server.name} className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-xl font-bold text-[var(--text-secondary)]">
                  {server.name.slice(0, 1)}
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="page-eyebrow">{t("servers.serverDetail")}</p>
              <h3 className="page-title !mt-1 !text-[28px] truncate">{server.name}</h3>
              <p className="mt-1 text-sm text-[var(--text-muted)] truncate">{server.address}</p>
            </div>
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            type="button"
            aria-label={t("servers.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {server.description && (
            <div className="mb-4">
              <p className="text-sm leading-6 text-[var(--text-secondary)]">{server.description}</p>
            </div>
          )}

          {server.detailedDescription && (
            <div className="surface-panel surface-panel-soft rounded-[10px] p-4 mb-4">
              <p className="text-sm leading-6 text-[var(--text-secondary)] whitespace-pre-wrap">
                {server.detailedDescription}
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <Button
              variant="primary"
              size="lg"
              className="flex-1 min-h-[48px] justify-center"
              disabled={busy || launching}
              launchProgress={launching}
              launchProgressPercent={launchProgressPercent}
              onClick={onLaunch}
            >
              <span className="flex flex-col items-center justify-center gap-1 text-center leading-tight">
                <span className="flex items-center justify-center gap-2">
                  <Play fill="currentColor" size={16} />
                  {launching
                    ? `${t("home.launching")}${typeof launchProgressPercent === "number" ? ` ${launchProgressPercent}%` : ""}`
                    : t("servers.quickLaunch")
                  }
                </span>
                {currentInstance && !launching && (
                  <span className="text-xs text-white/80">
                    {currentInstance.name}
                  </span>
                )}
              </span>
            </Button>

            <Button
              variant="secondary"
              size="lg"
              className="min-h-[48px] px-5"
              title={t("servers.addToServerList")}
            >
              <ExternalLink size={16} />
            </Button>
          </div>
        </div>
      </Card>
    </div>,
    document.body
  );
}
