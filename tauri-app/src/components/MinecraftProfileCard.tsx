import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Crown, LoaderCircle, Plus, TriangleAlert, User, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import steveFaceUrl from "../assets/steve-face.svg";
import { useI18n } from "../i18n";
import { describeApiError } from "../lib/launcherError";
import { lookupMinecraftSkinUrl } from "../lib/minecraftAccount";
import type { MinecraftAccount, MinecraftAuthConfig } from "../types";

type MinecraftProfileCardProps = {
  accounts: MinecraftAccount[];
  currentAccount: MinecraftAccount | null;
  required: boolean;
  onSelectAccount: (accountId: string) => void;
  onAddOfflineAccount: (username: string) => void;
  onSaveMicrosoftAccount: (account: MinecraftAccount) => void;
  onDeleteAccount: (accountId: string) => void;
};

type AccountDialogMode = "offline" | "microsoft";

function MinecraftProfileCard({
  accounts,
  currentAccount,
  required,
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
  const requiredDialogOpen = required && accounts.length === 0;
  const dialogVisible = dialogOpen || requiredDialogOpen;

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
    if (!dialogVisible || mode !== "offline") {
      return;
    }
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [dialogVisible, mode]);

  useEffect(() => {
    if (!dialogVisible) {
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
  }, [dialogVisible]);

  const displayAccount = currentAccount ?? accounts[0] ?? null;
  const profileTitle = displayAccount?.username?.trim() || t("minecraftAccount.emptyTitle");
  const profileSubtitle = displayAccount
    ? displayAccount.needsRelogin
      ? t("minecraftAccount.reloginRequired")
      : t(`minecraftAccount.type.${displayAccount.type}` as const)
    : t("minecraftAccount.emptySubtitle");

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

  function closeAddDialog(force = false) {
    if (required && !force) {
      return;
    }
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
    closeAddDialog(true);
  }

  async function beginMicrosoftLogin() {
    setMicrosoftBusy(true);
    setMicrosoftError("");
    setMicrosoftStatus(t("minecraftAccount.microsoftBrowserOpening"));
    try {
      const account = await startMinecraftBrowserLogin();
      onSaveMicrosoftAccount(account);
      closeAddDialog(true);
    } catch (error) {
      // Raw `String(error)` here exposed reqwest/hyper source chains from the
      // Rust side; users saw "error sending request for url ..." and no hint of
      // what to do about it.
      setMicrosoftError(describeApiError(error, t));
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
          <MinecraftAvatar account={displayAccount} title={profileTitle} className="minecraft-profile-avatar" />
          <div className="minecraft-profile-copy">
            <p className="minecraft-profile-name">{profileTitle}</p>
            <p className={`minecraft-profile-subtitle ${displayAccount?.needsRelogin ? "text-[var(--accent-danger)]" : ""}`}>
              {profileSubtitle}
            </p>
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
                      <MinecraftAvatar account={account} title={account.username} className="minecraft-account-row-avatar" />
                      <div className="minecraft-account-row-copy">
                        <div className="minecraft-account-row-title">
                          <span className="truncate">{account.username}</span>
                          <span className={`minecraft-account-type-badge ${account.type === "microsoft" ? "is-premium" : ""}`}>
                            {account.type === "microsoft" ? <Crown size={11} /> : <User size={11} />}
                            {t(`minecraftAccount.type.${account.type}` as const)}
                          </span>
                        </div>
                        {account.needsRelogin ? (
                          <p className="minecraft-account-row-meta flex items-center gap-1 text-[var(--accent-danger)]">
                            <TriangleAlert size={11} />
                            {t("minecraftAccount.reloginRequired")}
                          </p>
                        ) : (
                          <p className="minecraft-account-row-meta">{account.uuid || t("minecraftAccount.uuidPending")}</p>
                        )}
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
                          if (!window.confirm(t("minecraftAccount.deleteConfirm", { name: account.username }))) {
                            return;
                          }
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

      {dialogVisible && typeof document !== "undefined"
        ? createPortal(
            <div
              className="minecraft-account-modal-backdrop"
              role="presentation"
              onClick={required ? undefined : () => closeAddDialog()}
            >
              <div className="minecraft-account-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                <div className="minecraft-account-modal-header">
                  <div>
                    <p className="page-eyebrow">{t("minecraftAccount.title")}</p>
                    <h3 className="minecraft-account-modal-title">
                      {required ? t("minecraftAccount.requiredTitle") : t("minecraftAccount.add")}
                    </h3>
                  </div>
                  {!required && (
                    <button type="button" className="minecraft-account-modal-close" onClick={() => closeAddDialog()}>
                      <X size={15} />
                    </button>
                  )}
                </div>

                {required ? (
                  <div className="minecraft-auth-notice is-warning mt-4">
                    <p>{t("minecraftAccount.requiredHint")}</p>
                  </div>
                ) : null}

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
                  {!required && (
                    <button type="button" className="segment-chip px-4" onClick={() => closeAddDialog()}>
                      {t("monitor.cancel")}
                    </button>
                  )}
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

// Resolves the skin to render for an account: the stored skinUrl when present,
// otherwise a cached backend lookup by uuid (premium) / username (offline names
// that map to a real Mojang profile). Returns null while unresolved or when the
// account has no real profile skin — the avatar then falls back to Steve.
function useResolvedMinecraftSkinUrl(account: MinecraftAccount | null | undefined): string | null {
  const storedSkinUrl = account?.skinUrl?.trim() || null;
  const accountType = account?.type ?? null;
  const accountUuid = account?.uuid ?? "";
  const accountUsername = account?.username ?? "";
  const identityKey = accountType ? `${accountType}:${accountUuid}:${accountUsername}` : "";
  const [lookupResult, setLookupResult] = useState<{
    identityKey: string;
    url: string | null;
  }>({ identityKey: "", url: null });

  useEffect(() => {
    if (storedSkinUrl || !accountType) {
      return;
    }
    let disposed = false;
    void lookupMinecraftSkinUrl({ type: accountType, uuid: accountUuid, username: accountUsername })
      .then((url) => {
        if (!disposed) {
          setLookupResult({ identityKey, url });
        }
      });
    return () => {
      disposed = true;
    };
  }, [storedSkinUrl, accountType, accountUuid, accountUsername, identityKey]);

  return storedSkinUrl ?? (lookupResult.identityKey === identityKey ? lookupResult.url : null);
}

function MinecraftAvatar({
  account,
  title,
  className
}: {
  account: MinecraftAccount | null;
  title: string;
  className: string;
}) {
  const skinUrl = useResolvedMinecraftSkinUrl(account);
  const [failed, setFailed] = useState(false);
  const showSkin = skinUrl && !failed;

  useEffect(() => {
    setFailed(false);
  }, [skinUrl]);

  return (
    <span className={`${className} minecraft-avatar-frame`} aria-label={title} role="img">
      {showSkin ? (
        <>
          <img src={skinUrl} alt="" className="minecraft-avatar-face" onError={() => setFailed(true)} />
          <img src={skinUrl} alt="" className="minecraft-avatar-overlay" onError={() => setFailed(true)} />
        </>
      ) : (
        <img src={steveFaceUrl} alt="" className="minecraft-avatar-steve" />
      )}
    </span>
  );
}

export default memo(MinecraftProfileCard);
