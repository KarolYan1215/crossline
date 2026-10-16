import { monthDay, tFor, weekdayShort, type Locale } from "../../lib/i18n";

/**
 * How the task screens write durations and days in either language (docs/i18n.md). Chinese reads exactly as the shared
 * `formatMinutes` / `dayLabel` in `ui/controls.tsx` do (「45 分」「1 时 30 分」「2 小时」, 「10/17 周五」); English is "45 min",
 * "1 h 30 min", "2 h" and "Oct 17 Fri". Kept here, importable from server code too, rather than changing the shared helpers.
 */
export function minutesText(locale: Locale | undefined, minutes: number): string {
  const t = tFor(locale);
  if (minutes < 60) return t("{{m}} 分", { m: minutes });
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? t("{{h}} 时 {{m}} 分", { h, m }) : t("{{h}} 小时", { h });
}

/** 「10/17 周五」 / "Oct 17 Fri" for a `YYYY-MM-DD…` value. */
export function dayText(locale: Locale | undefined, value: string): string {
  const day = value.slice(0, 10);
  const weekday = new Date(`${day}T12:00:00`).getDay();
  if (locale === "en") return `${monthDay("en", day)} ${weekdayShort("en", weekday)}`;
  return `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} ${weekdayShort("zh", weekday)}`;
}

/** 「10/17」 / "Oct 17" for a `YYYY-MM-DD…` value. */
export function shortDate(locale: Locale | undefined, value: string): string {
  const day = value.slice(0, 10);
  return locale === "en" ? monthDay("en", day) : `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
}

/** Chinese list and clause punctuation, or its English counterpart: 「、」「，」 → ", ", 「；」 → "; ". */
export const punct = (locale: Locale | undefined, mark: "；" | "、" | "，"): string => locale !== "en" ? mark : mark === "；" ? "; " : ", ";

/** The day a deferred decision comes into the week: 「10-20」 (as it has always read) / "Oct 20". */
export const entryDay = (locale: Locale | undefined, day: string): string => locale === "en" ? monthDay("en", day.slice(0, 10)) : day.slice(5, 10);
