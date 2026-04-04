import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Crown, LoaderCircle, Plus, User, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import type { MinecraftAccount, MinecraftAuthConfig } from "../types";
import { resolveMinecraftAvatarUrl } from "../utils/launcher";

type MinecraftProfileCardProps = {
  accounts: MinecraftAccount[];
  currentAccount: MinecraftAccount | null;
  onSelectAccount: (accountId: string) => void;
  onAddOfflineAccount: (username: string) => void;
  onSaveMicrosoftAccount: (account: MinecraftAccount) => void;
  onDeleteAccount: (accountId: string) => void;
};

type AccountDialogMode = "offline" | "microsoft";

export default function MinecraftProfileCard({
  accounts,
  currentAccount,
  onSelectAccount,
  onAddOfflineAccount,
  onSaveMicrosoftAccount,
  onDeleteAccount
}: MinecraftProfileCardProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<AccountDialogMode>("offline");
  const [offlineName, setOfflineName] = useState("");
  const [offlineError, setOfflineError] = useState("");
  const [authConfig, setAuthConfig] = useState<MinecraftAuthConfig | null>(null);
  const [microsoftBusy, setMicrosoftBusy] = useState(false);
  const [microsoftStatus, setMicrosoftStatus] = useState("");
  const [microsoftError, setMicrosoftError] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!dialogOpen || mode !== "offline") {
      return;
    }
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [dialogOpen, mode]);

  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    let disposed = false;
    void loadMinecraftAuthConfig()
      .then((config) => {
        if (!disposed) {
          setAuthConfig(config);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setAuthConfig({
            configured: false,
            configurationHint: String(error)
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [dialogOpen]);

  const displayAccount = currentAccount ?? accounts[0] ?? null;
  const profileTitle = displayAccount?.username?.trim() || t("minecraftAccount.emptyTitle");
  const profileSubtitle = displayAccount ? t(`minecraftAccount.type.${displayAccount.type}` as const) : t("minecraftAccount.emptySubtitle");
  const avatarUrl = useMemo(() => resolveMinecraftAvatarUrl(displayAccount), [displayAccount]);

  function resetDialogState(nextMode: AccountDialogMode = "offline") {
    setMode(nextMode);
    setOfflineName("");
    setOfflineError("");
    setMicrosoftBusy(false);
    setMicrosoftStatus("");
    setMicrosoftError("");
  }

  function openAddDialog() {
    setDialogOpen(true);
    setOpen(false);
    resetDialogState("offline");
  }

  function closeAddDialog() {
    setDialogOpen(false);
    resetDialogState("offline");
  }

  function submitOfflineAccount() {
    const username = offlineName.trim();
    if (!username) {
      setOfflineError(t("minecraftAccount.offlineNameRequired"));
      return;
    }
    onAddOfflineAccount(username);
    closeAddDialog();
  }

  async function beginMicrosoftLogin() {
    setMicrosoftBusy(true);
    setMicrosoftError("");
    setMicrosoftStatus(t("minecraftAccount.microsoftBrowserOpening"));
    try {
      const account = await startMinecraftBrowserLogin();
      onSaveMicrosoftAccount(account);
      closeAddDialog();
    } catch (error) {
      setMicrosoftError(String(error));
    } finally {
      setMicrosoftBusy(false);
    }
  }

  return (
    <>
      <div className="minecraft-profile-anchor" ref={containerRef}>
        <button
          type="button"
          className={`minecraft-profile-card ${open ? "is-open" : ""}`}
          onClick={() => setOpen((value) => !value)}
        >
          <img src={avatarUrl} alt={profileTitle} className="minecraft-profile-avatar" />
          <div className="minecraft-profile-copy">
            <p className="minecraft-profile-name">{profileTitle}</p>
            <p className="minecraft-profile-subtitle">{profileSubtitle}</p>
          </div>
          <ChevronDown size={16} className={`minecraft-profile-chevron ${open ? "is-open" : ""}`} />
        </button>

        {open ? (
          <div className="minecraft-profile-dropdown">
            <div className="minecraft-profile-dropdown-scroll">
              {accounts.map((account) => {
                const selected = displayAccount?.id === account.id;
                return (
                  <div
                    key={account.id}
                    className={`minecraft-account-row ${selected ? "is-active" : ""}`}
                    onClick={() => {
                      onSelectAccount(account.id);
                      setOpen(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectAccount(account.id);
                        setOpen(false);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="minecraft-account-row-main">
                      <img src={resolveMinecraftAvatarUrl(account, 56)} alt={account.username} className="minecraft-account-row-avatar" />
                      <div className="minecraft-account-row-copy">
                        <div className="minecraft-account-row-title">
                          <span className="truncate">{account.username}</span>
                          <span className={`minecraft-account-type-badge ${account.type === "microsoft" ? "is-premium" : ""}`}>
                            {account.type === "microsoft" ? <Crown size={11} /> : <User size={11} />}
                            {t(`minecraftAccount.type.${account.type}` as const)}
                          </span>
                        </div>
                        <p className="minecraft-account-row-meta">{account.uuid || t("minecraftAccount.uuidPending")}</p>
                      </div>
                    </div>
                    <div className="minecraft-account-row-actions">
                      <span className={`selection-indicator ${selected ? "is-active" : ""}`} />
                      <button
                        type="button"
                        className="minecraft-account-delete"
                        aria-label={t("minecraftAccount.delete")}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteAccount(account.id);
                        }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <button type="button" className="minecraft-account-add" onClick={openAddDialog}>
              <Plus size={15} />
              {t("minecraftAccount.add")}
            </button>
          </div>
        ) : null}
      </div>

      {dialogOpen && typeof document !== "undefined"
        ? createPortal(
            <div className="minecraft-account-modal-backdrop" role="presentation" onClick={closeAddDialog}>
              <div className="minecraft-account-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                <div className="minecraft-account-modal-header">
                  <div>
                    <p className="page-eyebrow">{t("minecraftAccount.title")}</p>
                    <h3 className="minecraft-account-modal-title">{t("minecraftAccount.add")}</h3>
                  </div>
                  <button type="button" className="minecraft-account-modal-close" onClick={closeAddDialog}>
                    <X size={15} />
                  </button>
                </div>

                <div className="minecraft-account-mode-grid">
                  <button
                    type="button"
                    className={`minecraft-account-mode-card ${mode === "offline" ? "is-active" : ""}`}
                    onClick={() => setMode("offline")}
                  >
                    <div className="minecraft-account-mode-icon">
                      <User size={16} />
                    </div>
                    <div>
                      <p className="minecraft-account-mode-title">{t("minecraftAccount.type.offline")}</p>
                      <p className="minecraft-account-mode-desc">{t("minecraftAccount.offlineHint")}</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`minecraft-account-mode-card ${mode === "microsoft" ? "is-active" : ""} ${authConfig && !authConfig.configured ? "is-disabled" : ""}`}
                    onClick={() => setMode("microsoft")}
                  >
                    <div className="minecraft-account-mode-icon">
                      <Crown size={16} />
                    </div>
                    <div>
                      <p className="minecraft-account-mode-title">{t("minecraftAccount.type.microsoft")}</p>
                      <p className="minecraft-account-mode-desc">{t("minecraftAccount.microsoftHint")}</p>
                    </div>
                  </button>
                </div>

                {mode === "offline" ? (
                  <div className="mt-4">
                    <label className="field-label">{t("minecraftAccount.offlineName")}</label>
                    <input
                      ref={inputRef}
                      type="text"
                      value={offlineName}
                      onChange={(event) => {
                        setOfflineName(event.target.value);
                        if (offlineError) {
                          setOfflineError("");
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          submitOfflineAccount();
                        }
                      }}
                      className="ui-input"
                      placeholder={t("minecraftAccount.offlinePlaceholder")}
                    />
                    {offlineError ? <p className="mt-2 text-xs text-[var(--accent-danger)]">{offlineError}</p> : null}
                  </div>
                ) : (
                  <div className="minecraft-auth-panel">
                    {!authConfig?.configured ? (
                      <div className="minecraft-auth-notice is-warning">
                        <p>{authConfig?.configurationHint || t("minecraftAccount.microsoftUnconfigured")}</p>
                      </div>
                    ) : null}

                    <div className="minecraft-auth-notice">
                      <p>{microsoftBusy ? microsoftStatus || t("minecraftAccount.microsoftWaiting") : t("minecraftAccount.microsoftReady")}</p>
                    </div>

                    {microsoftError ? <p className="minecraft-auth-error">{microsoftError}</p> : null}
                  </div>
                )}

                <div className="minecraft-account-modal-actions">
                  <button type="button" className="segment-chip px-4" onClick={closeAddDialog}>
                    {t("monitor.cancel")}
                  </button>
                  {mode === "offline" ? (
                    <button type="button" className="segment-chip is-active px-4" onClick={submitOfflineAccount}>
                      {t("minecraftAccount.confirmAddOffline")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="segment-chip is-active px-4"
                      onClick={beginMicrosoftLogin}
                      disabled={microsoftBusy || !authConfig?.configured}
                    >
                      {microsoftBusy ? <LoaderCircle size={14} className="minecraft-inline-spinner" /> : <Crown size={14} />}
                      {t("minecraftAccount.microsoftStart")}
                    </button>
                  )}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

async function loadMinecraftAuthConfig(): Promise<MinecraftAuthConfig> {
  return invoke<MinecraftAuthConfig>("get_minecraft_auth_config");
}

async function startMinecraftBrowserLogin(): Promise<MinecraftAccount> {
  return invoke<MinecraftAccount>("start_minecraft_browser_login");
}
