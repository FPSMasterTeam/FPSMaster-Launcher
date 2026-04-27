import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { Locale } from "./types";

import enUS from "./locales/en-US";
import zhCN from "./locales/zh-CN";

const translations = {
  "en-US": enUS,
  "zh-CN": zhCN,
} as const;

export type TranslationKey = keyof (typeof translations)["en-US"];
type TranslationValues = Record<string, string | number>;

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
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: onLocaleChange,
      t: createTranslator(locale)
    }),
    [locale, onLocaleChange]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
