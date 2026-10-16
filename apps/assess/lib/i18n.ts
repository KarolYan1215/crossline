/**
 * The quick test's way in to the interface language (docs/i18n.md), for server and client code alike: importing it registers the
 * English the quick test reads (its own catalogue, plus core's). The page's language is the `crossline-locale` cookie, Chinese by
 * default: server code reads it with `lib/locale-server.ts`, client components with `useT()` from `components/locale-context.tsx`.
 */
import "@crossline/i18n/catalog/assess";
export { asLocale, DEFAULT_LOCALE, htmlLang, intlLocale, isLocale, joinList, LOCALE_COOKIE, localeFromCookieHeader, tFor, type Locale,
  type Translate } from "@crossline/i18n";
import { localeFromCookieHeader, type Locale } from "@crossline/i18n";

/** The language a request asks for: its `crossline-locale` cookie, else Chinese. For routes, which have the request at hand. */
export const requestLocale = (request: Request): Locale => localeFromCookieHeader(request.headers.get("cookie")) ?? "zh";

/**
 * Before the language switch reloads the page, anything in progress is written to storage: the test flow listens for this event
 * (and for `pagehide`) so a switch mid-test never loses an answer.
 */
export const LOCALE_SWITCH_EVENT = "crossline-assess:locale-switch";
