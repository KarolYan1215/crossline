"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE, tFor, type Locale, type Translate } from "../lib/i18n";

/**
 * The page's language for client components (docs/i18n.md). The root layout reads the cookie on the server and hands it down, so the
 * first paint is already in the right language and a client component never guesses. Outside a provider (tests) it is Chinese.
 */
const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export const useLocale = (): Locale => useContext(LocaleContext);

/** `const t = useT(); t("下一步")`, `t("已答 {{n}} 题", { n })`. */
export function useT(): Translate {
  const locale = useLocale();
  return useMemo(() => tFor(locale), [locale]);
}
