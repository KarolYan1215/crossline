/**
 * The web app's way in to the interface language (docs/i18n.md), for server and client code alike: importing it registers the web's
 * English catalogues. Server code that has a request context uses `tOf(ctx)` from `lib/locale.ts`; client components use `useT()`.
 */
import "@crossline/i18n/catalog/web";
export { asLocale, DEFAULT_LOCALE, htmlLang, intlLocale, isLocale, joinList, LOCALE_COOKIE, LOCALE_SETTING, localeFromCookieHeader, monthDay,
  pickOf, tFor, weekdayShort, type Bilingual, type Locale, type Translate } from "@crossline/i18n";
