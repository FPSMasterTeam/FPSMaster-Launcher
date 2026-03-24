import { LogIn, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import AppLogo from "../components/AppLogo";
import Button from "../components/Button";
import Card from "../components/Card";
import { useI18n } from "../i18n";

type LoginPageProps = {
  loading: boolean;
  onSubmit: (usernameOrEmail: string, password: string) => Promise<string | null>;
};

export default function LoginPage({ loading, onSubmit }: LoginPageProps) {
  const { t } = useI18n();
  const [identity, setIdentity] = useState("");
  const [password, setPassword] = useState("");
  const [errorText, setErrorText] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText("");
    const error = await onSubmit(identity.trim(), password);
    if (error) {
      setErrorText(error);
      return;
    }
    setPassword("");
  }

  return (
    <div className="relative w-full px-2 sm:px-4">
      <div className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-[var(--mc-grass)]/16 blur-3xl" />
      <Card as="section" variant="strong" className="relative overflow-hidden rounded-xl border border-[var(--border-medium)] p-5 shadow-[0_20px_48px_rgba(4,8,14,0.34)] sm:p-6">
        <div className="pointer-events-none absolute -right-14 -top-14 h-40 w-40 rounded-full bg-[var(--mc-grass)]/12 blur-3xl" />

        <header className="relative mb-7 flex items-center gap-4">
          <AppLogo size={56} className="rounded-2xl border border-[var(--border-medium)] shadow-[0_0_0_1px_var(--border-subtle),0_10px_30px_rgba(37,184,122,0.22)]" />
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
              className="min-h-11 w-full rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{t("login.password")}</label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
            />
          </div>

          {errorText && <div className="rounded-xl border border-[var(--accent-danger)]/40 bg-[var(--accent-danger)]/10 px-3 py-2 text-xs text-[var(--accent-danger)]">{errorText}</div>}

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
