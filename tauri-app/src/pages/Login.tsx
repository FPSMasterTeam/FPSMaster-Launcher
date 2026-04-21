import { LogIn, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import AppLogo from "../components/AppLogo";
import Button from "../components/Button";
import Card from "../components/Card";
import { Checkbox } from "../components/Checkbox";
import { useI18n } from "../i18n";
import type { LauncherLoginPrefs } from "../types";

type LoginPageProps = {
  loading: boolean;
  initialPrefs: LauncherLoginPrefs;
  statusText?: string | null;
  onSubmit: (prefs: LauncherLoginPrefs) => Promise<string | null>;
};

export default function LoginPage({ loading, initialPrefs, statusText, onSubmit }: LoginPageProps) {
  const { t } = useI18n();
  const [identity, setIdentity] = useState(initialPrefs.usernameOrEmail);
  const [password, setPassword] = useState(initialPrefs.password);
  const [rememberPassword, setRememberPassword] = useState(initialPrefs.rememberPassword);
  const [autoLogin, setAutoLogin] = useState(initialPrefs.autoLogin && initialPrefs.rememberPassword);
  const [errorText, setErrorText] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText("");
    const nextPrefs: LauncherLoginPrefs = {
      usernameOrEmail: identity.trim(),
      password,
      rememberPassword,
      autoLogin: rememberPassword && autoLogin
    };
    const error = await onSubmit(nextPrefs);
    if (error) {
      setErrorText(error);
      return;
    }
    if (!rememberPassword) {
      setPassword("");
    }
  }

  return (
    <div className="page-shell page-shell-centered relative w-full px-2 sm:px-4">
      <div className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-[var(--mc-grass)]/16 blur-2xl" />
      <Card as="section" variant="strong" className="page-card page-card-roomy relative w-full max-w-[560px] overflow-hidden rounded-[24px] border border-white/10 shadow-[0_20px_48px_rgba(4,8,14,0.34)]" interactive={false}>
        <div className="pointer-events-none absolute -right-14 -top-14 h-40 w-40 rounded-full bg-[var(--mc-grass)]/12 blur-2xl" />

        <header className="relative mb-7 flex items-center gap-4">
          <AppLogo size={56} className="rounded-2xl border border-white/10 shadow-[0_0_0_1px_var(--border-subtle),0_10px_30px_rgba(37,184,122,0.22)]" />
          <div>
            <p className="page-eyebrow">FPSMaster</p>
            <h1 className="page-title !mt-1 !text-[34px]">{t("login.title")}</h1>
            <p className="page-subtitle !mt-1 !text-sm">{t("login.subtitle")}</p>
          </div>
        </header>

        <form className="field-stack relative" onSubmit={(event) => void submit(event)}>
          <div>
            <label className="field-label">{t("login.account")}</label>
            <input
              type="text"
              value={identity}
              onChange={(event) => setIdentity(event.target.value)}
              className="ui-input"
            />
          </div>

          <div>
            <label className="field-label">{t("login.password")}</label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="ui-input"
            />
          </div>

          <div className="field-grid field-grid-two">
            <label className="surface-panel flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-3 text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--border-medium)]">
              <Checkbox
                checked={rememberPassword}
                onCheckedChange={(checked) => {
                  const isChecked = checked === true;
                  setRememberPassword(isChecked);
                  if (!isChecked) {
                    setAutoLogin(false);
                  }
                }}
              />
              <span>{t("login.rememberPassword")}</span>
            </label>

            <label className={`surface-panel flex items-center gap-3 rounded-2xl px-3 py-3 text-sm transition-colors ${rememberPassword ? "cursor-pointer text-[var(--text-secondary)] hover:border-[var(--border-medium)]" : "cursor-not-allowed text-[var(--text-muted)] opacity-70"}`}>
              <Checkbox
                checked={rememberPassword && autoLogin}
                disabled={!rememberPassword}
                onCheckedChange={(checked) => setAutoLogin(checked === true)}
              />
              <span>{t("login.autoLogin")}</span>
            </label>
          </div>

          {!rememberPassword && autoLogin && (
            <div className="notice notice-warning">
              <div>
                <p className="notice-title">{t("login.rememberPassword")}</p>
                <p className="notice-text">{t("login.autoLoginRequiresRemember")}</p>
              </div>
            </div>
          )}

          {errorText && (
            <div className="notice notice-danger">
              <div>
                <p className="notice-text !mt-0">{errorText}</p>
              </div>
            </div>
          )}

          {statusText ? (
            <div className="notice">
              <div>
                <p className="notice-text !mt-0">{statusText}</p>
              </div>
            </div>
          ) : null}

          <Button type="submit" variant="primary" size="lg" className="w-full justify-center gap-2 !rounded-2xl" disabled={loading}>
            <LogIn size={16} />
            {loading ? t("login.loggingIn") : t("login.login")}
          </Button>

          <div className="flex items-center justify-center gap-2 pt-1 text-xs text-[var(--text-muted)]">
            <ShieldCheck size={14} className="text-[var(--mc-grass)]" />
            {t("login.tip.signInToContinue")}
          </div>
        </form>
      </Card>
    </div>
  );
}
