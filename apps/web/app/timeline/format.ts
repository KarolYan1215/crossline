import { intlLocale, tFor, weekdayShort, type Locale } from "../../lib/i18n";

/**
 * Durations and dates as the calendar, plan and milestone views write them, in the page's language (docs/i18n.md). Chinese reads exactly
 * as before; English is "45 min", "1 h 30 min", "Oct 7". Times stay 24-hour in both.
 */

/** 「45 分」, 「1 小时」, 「1 时 30 分」 / "45 min", "1 h", "1 h 30 min" — the reading of `formatMinutes` in `ui/controls`. */
export function minutesText(locale: Locale | undefined, minutes: number): string {
  const t = tFor(locale);
  if (minutes < 60) return t("{{n}} 分", { n: minutes });
  const whole = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? t("{{h}} 时 {{m}} 分", { h: whole, m: rest }) : t("{{n}} 小时", { n: whole });
}

/** Hours with one decimal: 「1.5 小时」 / "1.5 h". */
export const hoursText = (locale: Locale | undefined, minutes: number) => tFor(locale)("{{n}} 小时", { n: Math.round(minutes / 6) / 10 });

/** A month's name on an axis: 「10月」 / "Oct"; with the year, 「2026年10月」 / "Oct 2026". `month` is 1–12. */
export function monthLabel(locale: Locale | undefined, year: number, month: number, withYear = false): string {
  if (locale === "en") {
    const date = new Date(Date.UTC(year, month - 1, 15));
    return date.toLocaleDateString(intlLocale(locale), { month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
  }
  return withYear ? tFor(locale)("{{year}}年{{month}}月", { year, month }) : tFor(locale)("{{month}}月", { month });
}

/** 「10/7 周三」 / "Wed 10/7" for a `YYYY-MM-DD` day — the reading of `dayLabel` in `ui/controls`. */
export function dayWithWeekday(locale: Locale | undefined, value: string): string {
  const day = new Date(`${value.slice(0, 10)}T12:00:00`);
  const date = `${day.getMonth() + 1}/${day.getDate()}`, weekday = weekdayShort(locale, day.getDay());
  return locale === "en" ? `${weekday} ${date}` : `${date} ${weekday}`;
}

/**
 * About how wide a text is drawn at `px`: a CJK or full-width character one em, a capital about 0.68 em, a space 0.3 em, anything else
 * about 0.58 em. English labels are longer in characters and narrower per character, so layout that fits labels measures, never counts.
 */
export function drawnWidth(text: string, px = 12): number {
  let width = 0;
  for (const char of text) width += /[⺀-鿿豈-﫿＀-￯]/.test(char) ? px : /[A-Z]/.test(char) ? px * 0.68 : /\s/.test(char) ? px * 0.3 : px * 0.58;
  return Math.ceil(width);
}

/**
 * Cut to `ems` characters with 「…」 in Chinese (as before); in English to about that many CJK characters' width, so a Latin label keeps
 * about twice as many characters as a Chinese one.
 */
export function clip(locale: Locale | undefined, text: string, ems: number): string {
  if (locale !== "en") return text.length > ems ? `${text.slice(0, ems - 1)}…` : text;
  if (drawnWidth(text, 1) <= ems) return text;
  let out = "";
  for (const char of text) {
    if (drawnWidth(`${out}${char}`, 1) > ems - 1) break;
    out += char;
  }
  return `${out}…`;
}
