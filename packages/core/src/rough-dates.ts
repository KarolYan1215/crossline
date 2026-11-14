/**
 * Rough days (2026-11-14, the owner): some days cannot be set yet, and the person answers 「下周」「11 月底前」「12 月中」「这学期内」
 * 「两周内」. That is an answer, not a gap: the app turns it into a window of days on its own and never asks the person for the exact day.
 * The window is internal (the date check accepts a day inside it, the deadline it stands for is its last day); the person sees their own
 * words. Exact days (「11 月 17 日」「下周三」「明天」) are read by `quoteSupportsDate` and `relativeDays`, not here.
 */
export type RoughWindow = { from: string; to: string; precision: "week" | "part" | "month" | "quarter" | "season" | "term" | "span" | "year" };

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utc = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day);
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const CN: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }; // i18n-ignore: numerals read from the reply

/** 「十一」「两」「3」 as a number; undefined when it is not one. */
function amount(text: string): number | undefined {
  if (/^\d+$/u.test(text)) return Number(text);
  if (text === "十") return 10; // i18n-ignore: a numeral
  const tens = text.indexOf("十"); // i18n-ignore: a numeral
  if (tens < 0) return text.length === 1 ? CN[text] : undefined;
  const high = tens === 0 ? 1 : CN[text.slice(0, tens)];
  const low = tens === text.length - 1 ? 0 : CN[text.slice(tens + 1)];
  return high === undefined || low === undefined ? undefined : high * 10 + low;
}

/**
 * The window of days rough words name, said on `today` (YYYY-MM-DD); undefined when they name none. A month earlier than this one by more
 * than two is next year's (「1 月」 said in November); a window that starts before today starts today.
 */
export function roughWindow(text: string, today: string): RoughWindow | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(today)) return undefined;
  const [year, month, date] = today.split("-").map(Number) as [number, number, number];
  const now = utc(year, month, date);
  const q = text.replace(/\s+/gu, "").replace(/([一二三四五六七八九十]{1,3})(?=月)/gu, (match) => String(amount(match) ?? match)); // i18n-ignore: Chinese month numerals
  const window = (from: number, to: number, precision: RoughWindow["precision"]): RoughWindow | undefined =>
    to < now ? undefined : { from: iso(Math.max(from, now)), to: iso(to), precision };
  // 「明年」 moves every month, quarter, half and season it names to next year (「明年 11 月」 said in November is not this month).
  const nextYear = /明年|下一年/u.test(q); // i18n-ignore
  const yearOf = (target: number) => nextYear ? year + 1 : target + 2 < month ? year + 1 : year;
  const monday = now - ((new Date(now).getUTCDay() + 6) % 7) * DAY_MS;
  // A part of a month: 上旬 / 初 the 1st–10th, 中旬 / 中 the 11th–20th, 下旬 / 底 / 末 the 21st to its end; 「前」 after it runs from today.
  const part = (y: number, m: number, word: string | undefined, before: boolean): RoughWindow | undefined => {
    const end = lastDay(y, m);
    const [first, last] = !word ? [1, end] : /上旬|初/u.test(word) ? [1, 10] : /中/u.test(word) ? [11, 20] : [21, end]; // i18n-ignore: words read from the reply
    return window(before ? now : utc(y, m, first), utc(y, m, last), word ? "part" : "month");
  };
  // Weeks, unless a weekday follows (「下周三」 is a day, read elsewhere).
  if (/下下(个)?(周|星期|礼拜)(?![一二三四五六日天])/u.test(q)) return window(monday + 14 * DAY_MS, monday + 20 * DAY_MS, "week"); // i18n-ignore
  if (/下(个)?(周|星期|礼拜)(?![一二三四五六日天])/u.test(q)) return window(monday + 7 * DAY_MS, monday + 13 * DAY_MS, "week"); // i18n-ignore
  if (/(本|这)(个)?(周|星期|礼拜)(?![一二三四五六日天])/u.test(q)) return window(now, monday + 6 * DAY_MS, "week"); // i18n-ignore
  // A month by number, with its part: 「11 月底前」「12 月中」「1 月上旬」「12 月」 (not 「12 月 3 日」).
  const named = /(\d{1,2})月(上旬|中旬|下旬|初|中|底|末)?(之?前|以前)?(?!\d|份?\d)/u.exec(q); // i18n-ignore
  if (named && Number(named[1]) >= 1 && Number(named[1]) <= 12) return part(yearOf(Number(named[1])), Number(named[1]), named[2], Boolean(named[3]));
  // This month and next.
  const thisMonth = /(本|这个?)月(上旬|中旬|下旬|初|中|底|末)?(之?前|以内|内)?|(?<![\d下])月(底|末)(之?前)?/u.exec(q); // i18n-ignore
  if (thisMonth) return part(year, month, thisMonth[2] ?? thisMonth[4], Boolean(thisMonth[3] || thisMonth[5]) || !(thisMonth[2] ?? thisMonth[4]));
  const nextMonth = /下(个)?月(上旬|中旬|下旬|初|中|底|末)?/u.exec(q); // i18n-ignore
  if (nextMonth) return part(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, nextMonth[2], false);
  // Quarters, halves and seasons (2026-11-14, the owner: a period as loose as a quarter is an answer too). One that has already ended is
  // next year's; 「前」 after it runs from today.
  const before = /之?前|以前/u.test(q); // i18n-ignore
  const months = (from: number, to: number, precision: RoughWindow["precision"]): RoughWindow | undefined => {
    // Winter runs into the next year: in January or February it is the winter that began last December.
    const y = nextYear ? year + 1 : to < from ? (month <= to ? year - 1 : year) : to < month ? year + 1 : year;
    const endYear = to < from ? y + 1 : y;
    return window(before ? now : utc(y, from, 1), utc(endYear, to, lastDay(endYear, to)), precision);
  };
  const quarter = /(?:第?([一二三四1-4])季度|q([1-4]))/iu.exec(q); // i18n-ignore
  if (quarter) { const n = amount(quarter[1] ?? quarter[2] ?? "") ?? 1; return months(n * 3 - 2, n * 3, "quarter"); }
  if (/上半年/u.test(q)) return months(1, 6, "quarter"); // i18n-ignore
  if (/下半年/u.test(q)) return months(7, 12, "quarter"); // i18n-ignore
  if (/春(季|天)|开春/u.test(q)) return months(3, 5, "season"); // i18n-ignore
  if (/夏(季|天)/u.test(q)) return months(6, 8, "season"); // i18n-ignore
  if (/秋(季|天)/u.test(q)) return months(9, 11, "season"); // i18n-ignore
  if (/冬(季|天)/u.test(q)) return months(12, 2, "season"); // i18n-ignore
  if (/年初/u.test(q)) return months(1, 2, "month"); // i18n-ignore
  if (nextYear && /年(底|末)/u.test(q)) return months(12, 12, "month"); // i18n-ignore
  if (/年底|年末|今年(以)?内/u.test(q)) return window(now, utc(year, 12, 31), "month"); // i18n-ignore
  if (nextYear && !/寒假|暑假|学期|期末/u.test(q)) return window(utc(year + 1, 1, 1), utc(year + 1, 12, 31), "year"); // i18n-ignore
  // The term and the holidays, as Chinese universities keep them: the autumn term ends in mid-January, the spring term in early July.
  if (/寒假/u.test(q)) { const y = month >= 3 ? year + 1 : year; return window(utc(y, 1, 15), utc(y, 2, 25), "term"); } // i18n-ignore
  if (/暑假/u.test(q)) { const y = month >= 9 ? year + 1 : year; return window(utc(y, 7, 10), utc(y, 8, 31), "term"); } // i18n-ignore
  if (/(这|本)(个)?学期|学期(内|末|结束)|期末(前|之前)?/u.test(q)) { // i18n-ignore
    const end = month >= 8 ? utc(year + 1, 1, 15) : month <= 1 ? utc(year, 1, 15) : utc(year, 7, 5);
    return window(now, end, "term");
  }
  // A span from today: 「两周内」「三天内」「一个月内」「大概两个月」.
  const span = /(\d+|[一两二三四五六七八九十]{1,3})(个)?(天|日|周|星期|礼拜|月)(以)?内|大概(\d+|[一两二三四五六七八九十]{1,3})(个)?(天|周|星期|月)/u.exec(q); // i18n-ignore
  if (span) {
    const n = amount(span[1] ?? span[5] ?? "");
    const unit = span[3] ?? span[7] ?? "";
    if (n !== undefined && n > 0) {
      const days = /月/u.test(unit) ? n * 30 : /周|星期|礼拜/u.test(unit) ? n * 7 : n; // i18n-ignore
      return window(now, now + days * DAY_MS, "span");
    }
  }
  return undefined;
}

/** Whether a day (YYYY-MM-DD) lies in the window rough words name. */
export const inRoughWindow = (day: string, text: string, today: string): boolean => {
  const found = roughWindow(text, today);
  return Boolean(found && day >= found.from && day <= found.to);
};
