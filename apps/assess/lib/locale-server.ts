import { cookies } from "next/headers";
import { asLocale, DEFAULT_LOCALE, LOCALE_COOKIE, type Locale } from "./i18n";

/** The language a page renders in (server components only): the browser's `crossline-locale` cookie, else Chinese (docs/i18n.md). */
export async function getLocale(): Promise<Locale> {
  try { return asLocale((await cookies()).get(LOCALE_COOKIE)?.value); } catch { return DEFAULT_LOCALE; }
}
