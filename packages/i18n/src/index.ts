import i18next, { type TOptions } from "i18next";

/**
 * The interface language (decided 2026-10-16; rules, glossary and workflow in docs/i18n.md). One site, switched between Chinese and
 * English in one press. The product was written in Chinese, and the Chinese text stays where it is written: it is the key —
 * `t("待确认")`, `t("已完成 {{n}} 项", { n })` — and English lives in `locales/en/*.json`, keyed by that Chinese. Chinese needs no
 * catalogue at all (a missing key is shown as itself, with its values filled in), and a Chinese sentence that changes is a new key, so
 * its English is asked for again instead of silently describing the old sentence.
 *
 * One i18next instance per process. The web app, the worker and the quick test each register the catalogues they use
 * (`@crossline/i18n/catalog/web|worker|assess`, imported once at their entry), so code shared between them — `packages/core` — reads
 * the same function wherever it runs.
 *
 * What follows the switch is everything the app writes. What does not: what a model already wrote, and what the person wrote — both
 * are shown as they are. New model output is written in the workspace's language from the moment it is switched (the interview keeps
 * the language it started in until it ends).
 */
export type Locale = "zh" | "en";
export const LOCALES: readonly Locale[] = ["zh", "en"];
export const DEFAULT_LOCALE: Locale = "zh";
/** The workspace's language in the ledger: the worker writes notifications and asks models in it, and other devices adopt it. */
export const LOCALE_SETTING = "ui.locale";
/** The browser's choice, read before anyone signs in and by every page render. */
export const LOCALE_COOKIE = "crossline-locale";

export const isLocale = (value: unknown): value is Locale => value === "zh" || value === "en";
export const asLocale = (value: unknown): Locale => isLocale(value) ? value : DEFAULT_LOCALE;

// One instance per process, kept on `globalThis`: Next bundles this package into several server chunks, and a catalogue registered
// through one copy must be read through every other.
const holder = globalThis as { __crosslineI18n?: ReturnType<typeof i18next.createInstance> };
const fresh = !holder.__crosslineI18n;
const instance = holder.__crosslineI18n ??= i18next.createInstance();
if (fresh) void instance.init({
  lng: DEFAULT_LOCALE,
  // A key with no English shows the Chinese: never an empty label. The discovery test (packages/i18n/src/catalog.test.ts) is what
  // keeps that from reaching a person.
  fallbackLng: false,
  initAsync: false,
  // The keys are Chinese sentences, which contain colons and full stops of their own.
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
  returnEmptyString: false,
  resources: {}
});

/** Adds a catalogue of English (keyed by the Chinese). Called once per catalogue file by the app's entry. */
export function registerCatalog(entries: Record<string, string>, locale: Locale = "en"): void {
  instance.addResources(locale, "translation", entries);
}

export type Translate = (key: string, values?: Record<string, unknown>) => string;

/**
 * The translator for one language: `const t = tFor(locale); t("待确认")`. Plural forms are English keys with `_one`/`_other`
 * (`"{{count}} 个任务_one": "{{count}} task"`), chosen by the `count` value.
 */
export function tFor(locale: Locale | undefined): Translate {
  const fixed = instance.getFixedT(locale === "en" ? "en" : "zh");
  return (key, values) => String(values ? fixed(key, values as TOptions) : fixed(key));
}

/** A value in both languages, for the rare table that cannot be keyed by its Chinese (two Chinese labels with one English, or the reverse). */
export type Bilingual<T = string> = { zh: T; en: T };
export const pickOf = <T>(locale: Locale | undefined, value: Bilingual<T>): T => locale === "en" ? value.en : value.zh;

/** `lang` for `<html>` and the name `Intl` formats with. */
export const htmlLang = (locale: Locale | undefined): string => locale === "en" ? "en" : "zh-CN";
export const intlLocale = (locale: Locale | undefined): string => locale === "en" ? "en-US" : "zh-CN";

/** 「10月17日」 / "Oct 17" for a `YYYY-MM-DD` day, read as a calendar day (no time zone shift). Times stay 24-hour in both languages. */
export function monthDay(locale: Locale | undefined, day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  if (locale !== "en") return `${month}月${date}日`;
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** 「周三」 / "Wed" for a weekday 0 (Sunday) to 6. */
export function weekdayShort(locale: Locale | undefined, weekday: number): string {
  return locale === "en" ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday] ?? "" : `周${"日一二三四五六"[weekday] ?? ""}`;
}

/** A list joined the way each language joins one: 「A、B 和 C」 / "A, B and C". */
export function joinList(locale: Locale | undefined, items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  const head = items.slice(0, -1);
  const last = items[items.length - 1]!;
  return locale === "en" ? `${head.join(", ")} and ${last}` : `${head.join("、")}和${last}`;
}

/** The cookie header's language, if it names one. */
export function localeFromCookieHeader(header: string | null | undefined): Locale | undefined {
  const match = (header ?? "").match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=(zh|en)(?:;|$)`));
  return match ? match[1] as Locale : undefined;
}
