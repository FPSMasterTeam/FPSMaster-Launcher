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
    <div className="relative w-full px-2 sm:px-4">
      <div className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-[var(--mc-grass)]/16 blur-3xl" />
      <Card as="section" variant="strong" className="relative overflow-hidden rounded-xl border border-white/10 p-5 shadow-[0_20px_48px_rgba(4,8,14,0.34)] sm:p-6" interactive={false}>
        <div className="pointer-events-none absolute -right-14 -top-14 h-40 w-40 rounded-full bg-[var(--mc-grass)]/12 blur-3xl" />

        <header className="relative mb-7 flex items-center gap-4">
          <AppLogo size={56} className="rounded-2xl border border-white/10 shadow-[0_0_0_1px_var(--border-subtle),0_10px_30px_rgba(37,184,122,0.22)]" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">FPSMaster</p>
            <h1 className="text-3xl font-semibold tracking-tight text-[var(--text-primary)]">{t("login.title")}</h1>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{t("login.subtitle")}</p>
          </div>
        </header>

        <form className="relative space-y-4" onSubmit={(event) => void submit(event)}>
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{t("login.account")}</label>
            <input
              type="text"
              value={identity}
              onChange={(event) => setIdentity(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-white/10 bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{t("login.password")}</label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-white/10 bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/5 bg-[var(--bg-secondary)]/72 px-3 py-3 text-sm text-[var(--text-secondary)] transition-colors hover:border-white/10">
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

            <label className={`flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${rememberPassword ? "cursor-pointer border-white/5 bg-[var(--bg-secondary)]/72 text-[var(--text-secondary)] hover:border-white/10" : "cursor-not-allowed border-white/5 bg-[var(--surface-soft)]/65 text-[var(--text-muted)] opacity-70"}`}>
              <Checkbox
                checked={rememberPassword && autoLogin}
                disabled={!rememberPassword}
                onCheckedChange={(checked) => setAutoLogin(checked === true)}
              />
              <span>{t("login.autoLogin")}</span>
            </label>
          </div>

          {!rememberPassword && autoLogin && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {t("login.autoLoginRequiresRemember")}
            </div>
          )}

          {errorText && <div className="rounded-xl border border-[#ff6b8f]/25 bg-[#ff6b8f]/10 px-3 py-2 text-xs text-[#ff6b8f]">{errorText}</div>}

          {statusText ? (
            <div className="rounded-xl border border-white/5 bg-[var(--surface-soft)] px-3 py-2 text-xs text-[var(--text-secondary)]">
              {statusText}
            </div>
          ) : null}

          <Button type="submit" variant="primary" size="lg" className="w-full justify-center gap-2" disabled={loading}>
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
