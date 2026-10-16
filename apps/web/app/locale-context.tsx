"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE, tFor, type Locale, type Translate } from "../lib/i18n";

/**
 * The page's language for client components (docs/i18n.md). The root layout reads it on the server and hands it down, so the first
 * paint is already in the right language and a client component never guesses.
 */
const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export const useLocale = (): Locale => useContext(LocaleContext);

/** `const t = useT(); t("待确认")`, `t("已完成 {{n}} 项", { n })`. */
export function useT(): Translate {
  const locale = useLocale();
  return useMemo(() => tFor(locale), [locale]);
}

/**
 * A phrase in a server component that has no request context to read the language from (the shared frame): translated on the client
 * side of the boundary, where the layout's language is known. `<Say text="更多" />`.
 */
export function Say({ text, values }: { text: string; values?: Record<string, unknown> }) {
  return <>{useT()(text, values)}</>;
}
