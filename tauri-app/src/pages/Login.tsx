import { Boxes, CloudCog, LogIn, ShieldCheck, Zap } from "lucide-react";
import { memo, FormEvent, useEffect, useState } from "react";
import AppLogo from "../components/AppLogo";
import Button from "../components/Button";
import Card from "../components/Card";
import { Checkbox } from "../components/Checkbox";
import { useI18n, type TranslationKey } from "../i18n";
import type { LauncherLoginPrefs } from "../types";

type LoginPageProps = {
  loading: boolean;
  initialPrefs: LauncherLoginPrefs;
  statusText?: string | null;
  onSubmit: (prefs: LauncherLoginPrefs) => Promise<string | null>;
};

const CAROUSEL_SLIDES: ReadonlyArray<{
  icon: typeof Boxes;
  titleKey: TranslationKey;
  descKey: TranslationKey;
}> = [
  { icon: Boxes, titleKey: "login.carousel.0.title", descKey: "login.carousel.0.desc" },
  { icon: Zap, titleKey: "login.carousel.1.title", descKey: "login.carousel.1.desc" },
  { icon: CloudCog, titleKey: "login.carousel.2.title", descKey: "login.carousel.2.desc" }
];

const CAROUSEL_INTERVAL = 5000;

function LoginPage({ loading, initialPrefs, statusText, onSubmit }: LoginPageProps) {
  const { t } = useI18n();
  const [identity, setIdentity] = useState(initialPrefs.usernameOrEmail);
  const [password, setPassword] = useState(initialPrefs.password);
  const [rememberPassword, setRememberPassword] = useState(initialPrefs.rememberPassword);
  const [autoLogin, setAutoLogin] = useState(initialPrefs.autoLogin && initialPrefs.rememberPassword);
  const [errorText, setErrorText] = useState("");
  const [slide, setSlide] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSlide((current) => (current + 1) % CAROUSEL_SLIDES.length);
    }, CAROUSEL_INTERVAL);
    return () => window.clearInterval(timer);
  }, []);

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
    <div className="login-shell relative flex w-full items-center justify-center px-4 py-8">
      {/* Ambient glow lives behind the card (not inside it) so it never gets clipped. */}
      <div className="login-glow login-glow-a" aria-hidden />
      <div className="login-glow login-glow-b" aria-hidden />

      <Card
        as="section"
        variant="strong"
        className="login-card relative grid w-full max-w-[940px] overflow-hidden rounded-[10px] border border-white/10 shadow-[0_24px_60px_rgba(4,8,14,0.42)] lg:grid-cols-[1.05fr_1fr]"
        interactive={false}
      >
        {/* Left: feature carousel */}
        <aside className="login-aside relative hidden flex-col justify-between overflow-hidden p-9 lg:flex">
          <div className="relative flex items-center gap-3">
            <AppLogo size={40} className="rounded-[8px] border border-white/10 shadow-[0_8px_24px_rgba(37,184,122,0.28)]" />
            <div className="leading-tight">
              <p className="text-sm font-semibold tracking-wide text-white">FPSMaster</p>
              <p className="text-xs text-white/55">{t("login.brand.tagline")}</p>
            </div>
          </div>

          <div className="relative mt-8">
            <div className="login-slides">
              {CAROUSEL_SLIDES.map((item, index) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.titleKey}
                    className={`login-slide ${index === slide ? "is-active" : ""}`}
                    aria-hidden={index !== slide}
                  >
                    <span className="login-slide-icon">
                      <Icon size={22} />
                    </span>
                    <h2 className="login-slide-title">{t(item.titleKey)}</h2>
                    <p className="login-slide-desc">{t(item.descKey)}</p>
                  </div>
                );
              })}
            </div>

            <div className="login-dots" role="tablist" aria-label="carousel">
              {CAROUSEL_SLIDES.map((item, index) => (
                <button
                  key={item.titleKey}
                  type="button"
                  className={`login-dot ${index === slide ? "is-active" : ""}`}
                  aria-label={t(item.titleKey)}
                  aria-selected={index === slide}
                  role="tab"
                  onClick={() => setSlide(index)}
                />
              ))}
            </div>
          </div>
        </aside>

        {/* Right: login form */}
        <div className="login-form relative flex flex-col justify-center p-8 sm:p-10">
          <header className="mb-7">
            <div className="mb-4 flex items-center gap-3 lg:hidden">
              <AppLogo size={44} className="rounded-[10px] border border-white/10 shadow-[0_10px_30px_rgba(37,184,122,0.22)]" />
              <p className="page-eyebrow !m-0">FPSMaster</p>
            </div>
            <p className="page-eyebrow hidden lg:block">FPSMaster</p>
            <h1 className="page-title !mt-1 !text-[30px]">{t("login.title")}</h1>
            <p className="page-subtitle !mt-2 !text-sm">{t("login.subtitle")}</p>
          </header>

          <form className="field-stack relative" onSubmit={(event) => void submit(event)}>
            <div>
              <label className="field-label">{t("login.account")}</label>
              <input
                type="text"
                value={identity}
                onChange={(event) => setIdentity(event.target.value)}
                className="ui-input"
                autoComplete="username"
              />
            </div>

            <div>
              <label className="field-label">{t("login.password")}</label>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="ui-input"
                autoComplete="current-password"
              />
            </div>

            <div className="login-options">
              <label className="login-option">
                <Checkbox
                  className="!h-4 !w-4"
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

              <label className={`login-option ${rememberPassword ? "" : "is-disabled"}`}>
                <Checkbox
                  className="!h-4 !w-4"
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

            <Button type="submit" variant="primary" size="lg" className="w-full justify-center gap-2 !rounded-[10px]" disabled={loading}>
              <LogIn size={16} />
              {loading ? t("login.loggingIn") : t("login.login")}
            </Button>

            <div className="flex items-center justify-center gap-2 pt-1 text-xs text-[var(--text-muted)]">
              <ShieldCheck size={14} className="text-[var(--mc-grass)]" />
              {t("login.tip.signInToContinue")}
            </div>
          </form>
        </div>
      </Card>
    </div>
  );
}

export default memo(LoginPage);
