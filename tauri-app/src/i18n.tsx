import { createContext, type ReactNode, useContext, useMemo, useRef } from "react";
import type { Locale } from "./types";

// en-US is kept static: it is the type source and the runtime fallback.
// Other locales are split into their own chunks and loaded on demand
// (see loadLocale). main.tsx preloads the active locale before first
// render so the synchronous translator never produces a flash.
import enUS from "./locales/en-US";

export type TranslationKey = keyof typeof enUS;
type TranslationValues = Record<string, string | number>;
type LocaleTable = Record<TranslationKey, string>;

const translations: Record<Locale, LocaleTable> = {
  "en-US": enUS,
  "zh-CN": enUS // placeholder until the zh-CN chunk is loaded
};

const localeLoaders: Record<Locale, (() => Promise<{ default: LocaleTable }>) | null> = {
  "en-US": null,
  "zh-CN": () => import("./locales/zh-CN") as Promise<{ default: LocaleTable }>
};

const loadedLocales = new Set<Locale>(["en-US"]);

export async function loadLocale(locale: Locale): Promise<void> {
  if (loadedLocales.has(locale)) {
    return;
  }
  const loader = localeLoaders[locale];
  if (!loader) {
    return;
  }
  try {
    const mod = await loader();
    translations[locale] = mod.default;
    loadedLocales.add(locale);
  } catch (error) {
    console.warn(`[i18n] failed to load locale ${locale}:`, error);
  }
}

export const LOCALE_OPTIONS: readonly Locale[] = ["en-US", "zh-CN"];

export function resolveLocale(input: string | null | undefined): Locale {
  if (input === "zh-CN" || input === "en-US") {
    return input;
  }
  return detectLocaleFromEnvironment();
}

export function detectLocaleFromEnvironment(): Locale {
  if (typeof navigator !== "undefined") {
    const lang = navigator.language.toLowerCase();
    if (lang.startsWith("zh")) {
      return "zh-CN";
    }
  }
  return "en-US";
}

function interpolate(template: string, values?: TranslationValues): string {
  if (typeof template !== "string") return "";
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in values ? String(values[key]) : `{${key}}`
  );
}

export function createTranslator(locale: Locale) {
  return (key: TranslationKey, values?: TranslationValues): string => {
    const table = translations[locale] ?? translations["en-US"];
    const fallback = translations["en-US"][key];
    return interpolate(table[key] ?? fallback, values);
  };
}

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, values?: TranslationValues) => string;
};

const I18nContext = createContext<I18nContextValue>({
  locale: "en-US",
  setLocale: () => {
  },
  t: createTranslator("en-US")
});

export function I18nProvider({
  locale,
  onLocaleChange,
  children
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  children: ReactNode;
}) {
  // Keep the latest callback in a ref so `setLocale` (and therefore the
  // context value) stays referentially stable even when the parent passes
  // a fresh inline `onLocaleChange` every render.
  const onLocaleChangeRef = useRef(onLocaleChange);
  onLocaleChangeRef.current = onLocaleChange;

  const setLocale = useMemo(
    () => async (next: Locale) => {
      await loadLocale(next);
      onLocaleChangeRef.current(next);
    },
    []
  );

  // Value only changes when the locale actually changes — not on every
  // parent render — so consumers of useI18n() no longer re-render needlessly.
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: createTranslator(locale)
    }),
    [locale, setLocale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
