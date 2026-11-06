import { withCourse } from "./task-title";

/**
 * Dates a person's own documents state — class meetings, quiz and homework dates, exams, deadlines.
 *
 * Reading these out of a syllabus is a job for a model, but a wrong date on a calendar is worse than no
 * date, so nothing here is trusted on the model's say-so. Every date cites the numbered sentence of the file
 * it was read from (since 2026-10-19; a verbatim quote before), and that sentence has to actually contain the
 * day (`10/27`, `27th Oct.`, `Oct 27`, `10月27日`): a model that mis-reads a table row, or adds a year the file
 * never mentions, cites a sentence that does not support its own date, and that date is dropped.
 *
 * Nothing is written to the calendar from here. The result is a batch the person confirms as a whole.
 */
export const DATE_KINDS = ["class", "quiz", "homework_out", "homework_due", "exam", "project_due", "deadline", "meeting", "other"] as const;

export type DateCandidate = {
  id: string; date: string; startTime: string; endTime: string; kind: (typeof DATE_KINDS)[number];
  title: string; project: string; sourceRef: string; quote: string; confidence: "high" | "medium" | "low"; note: string;
};
/** A weekly meeting pattern. Expanded into dated blocks in code, never by the model, so the arithmetic is right. */
export type RecurringMeeting = {
  id: string; title: string; project: string; weekdays: number[]; startTime: string; endTime: string;
  from: string; to: string; exceptions: string[]; location: string; sourceRef: string; quote: string;
  confidence: "high" | "medium" | "low";
};
/**
 * Something a file lists as due or happening but gives no day for ('TBD', 'to be announced'). It is not a date and is never turned into one;
 * it is kept so the part it belongs to still exists (a course project with a due date TBD is still 25% of the grade) and the person is asked.
 */
export type UndatedItem = { id: string; kind: (typeof DATE_KINDS)[number]; title: string; project: string; sourceRef: string; quote: string; note: string };
export type DateExtraction = { dates: DateCandidate[]; recurring: RecurringMeeting[]; questions: string[]; undated?: UndatedItem[];
  /**
   * Verified dates that are already over (a note's 「记录于 7/28」, a quiz last month, a finished course). They are history: kept for
   * estimating progress and habits, never offered for the calendar or scheduled.
   */
  past?: Array<DateCandidate | RecurringMeeting> };

export type DateExtractionContext = {
  version: "crossline.date-extractor.v1";
  today: string; timeZone: string;
  /** What the person already has, so a date can be tied to the right project by id (or left blank). */
  projects: Array<{ id: string; name: string; identityId: string }>;
  documents: Array<{ id: string; fileName: string; text: string }>;
};

const text = (max: number, min = 0) => ({ type: "string", minLength: min, maxLength: max }) as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const confidence = { type: "string", enum: ["high", "medium", "low"] } as const;

/**
 * What the model writes (2026-10-19): times as minutes after midnight and the evidence as sentence numbers (`refs`), never copied words or
 * typed clock strings; `resolveDateRefs` turns an answer into a `DateExtraction`, filling `sourceRef`, `quote` and `HH:MM` from the
 * ledger, and `sanitizeDateExtraction` then checks each item against the sentences it cites.
 */
const REFS = { type: "array", minItems: 1, maxItems: 6, items: { type: "integer", minimum: 1 } } as const;
const minute = { type: "integer", minimum: 0, maximum: 1439 } as const;
const minuteOrNone = { anyOf: [minute, { type: "null" }] } as const;
export const DATE_EXTRACTION_SCHEMA = object({
  dates: {
    type: "array", maxItems: 60,
    items: object({
      id: text(60, 1), date: text(10, 10), startMinute: minuteOrNone, endMinute: minuteOrNone,
      kind: { type: "string", enum: [...DATE_KINDS] }, title: text(160, 1), project: text(80),
      refs: REFS, confidence, note: text(300)
    })
  },
  recurring: {
    type: "array", maxItems: 12,
    items: object({
      id: text(60, 1), title: text(160, 1), project: text(80),
      weekdays: { type: "array", minItems: 1, maxItems: 7, items: { type: "integer", minimum: 0, maximum: 6 } },
      startMinute: minute, endMinute: minute, from: text(10, 10), to: text(10, 10),
      exceptions: { type: "array", maxItems: 30, items: text(10, 10) }, location: text(120),
      refs: REFS, confidence
    })
  },
  questions: { type: "array", maxItems: 10, items: text(300, 1) },
  undated: {
    type: "array", maxItems: 12,
    items: object({
      id: text(60, 1), kind: { type: "string", enum: [...DATE_KINDS] }, title: text(160, 1), project: text(80),
      refs: REFS, note: text(300)
    })
  }
});

/** `HH:MM` for minutes after midnight; "" for none. */
export function clockOf(minutes: unknown): string {
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function reject(code: string, detail: string): never {
  const error = new Error(code);
  (error as Error & { detail?: string }).detail = detail.slice(0, 400);
  throw error;
}

/**
 * Punctuation and spacing are not content: a model copying `27th Oct.` as `27th Oct` quoted the right words,
 * and refusing it cost a real midterm date. Every word and number still has to appear, in order.
 */
const squash = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function validDate(value: string): boolean {
  if (!ISO.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Does the quote actually mention this day? Accepts `10/27`, `10-27`, `27th Oct.`, `Oct 27`, `October 27th`
 * and `10月27日`. The year is deliberately not required: a syllabus rarely prints it, and the check is there to
 * catch a misread row, not to demand a format.
 */
export function quoteSupportsDate(date: string, quote: string): boolean {
  const [, mm, dd] = date.split("-");
  const month = Number(mm), day = Number(dd);
  const q = arabicDayNumbers(quote.toLowerCase());
  if (new RegExp(`(^|[^0-9])0?${month}\\s*[/\\-.]\\s*0?${day}(?![0-9])`).test(q)) return true;
  if (new RegExp(`0?${month}\\s*月\\s*0?${day}`).test(q)) return true; // i18n-ignore
  for (const name of [MONTHS[month - 1]!, MONTH_NAMES[month - 1]!]) {
    if (new RegExp(`(^|[^a-z])${name}[a-z]*\\.?\\s*0?${day}(?![0-9])`).test(q)) return true;
    if (new RegExp(`(^|[^0-9])0?${day}(st|nd|rd|th)?\\s*(of\\s+)?${name}`).test(q)) return true;
  }
  return false;
}

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }; // i18n-ignore
/** 「十一」 is 11, 「二十八」 28, 「三十一」 31: the numbers a month or a day is written with. */
function cnNumber(text: string): number | undefined {
  const ten = text.indexOf("十"); // i18n-ignore
  if (ten < 0) return text.length === 1 ? CN_DIGITS[text] : undefined;
  const tens = ten === 0 ? 1 : CN_DIGITS[text.slice(0, ten)];
  const rest = text.slice(ten + 1);
  const ones = rest ? CN_DIGITS[rest] : 0;
  return tens === undefined || ones === undefined ? undefined : tens * 10 + ones;
}
/**
 * Months and days written in Chinese numerals as digits, and 「号」 as 「日」 (W-228, 2026-11-05): a person types 「十一月十三号」 as often
 * as 「11月13日」, and the check refused the one they wrote.
 */
function arabicDayNumbers(text: string): string {
  return text.replace(/[零〇一二两三四五六七八九十]{1,3}(?=\s*(月|号|日|號))/gu, (match) => { const value = cnNumber(match); return value === undefined ? match : String(value); }) // i18n-ignore
    .replace(/(\d{1,2})\s*[号號]/gu, "$1日"); // i18n-ignore
}

const DAY_MS = 86_400_000;
const isoPlus = (today: string, days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const CN_WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }; // i18n-ignore
const EN_WEEKDAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * The days a sentence the person said names relative to the day they said it (W-228, 2026-11-05): 「明天」「后天」「下周五」「这周三」
 * 「13号」「next Friday」. A reply is dated by when it was written, so these are as exact as a printed date; the check used to refuse them
 * and the date was lost though the reply had been told it was noted. Files are not read this way: a file's 「next week」 has no known day.
 */
export function relativeDays(quote: string, today: string): Set<string> {
  const q = arabicDayNumbers(quote.toLowerCase());
  const days = new Set<string>();
  if (!ISO.test(today)) return days;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = -((dow + 6) % 7);
  const weekday = (target: number, weeksAhead: number) => isoPlus(today, monday + ((target + 6) % 7) + 7 * weeksAhead);
  if (/今天|今晚|今早|今日|today|tonight/u.test(q)) days.add(today); // i18n-ignore
  if (/明天|明早|明晚|明日|tomorrow/u.test(q)) days.add(isoPlus(today, 1)); // i18n-ignore
  if (/(^|[^大])后天/u.test(q)) days.add(isoPlus(today, 2)); // i18n-ignore
  if (/大后天/u.test(q)) days.add(isoPlus(today, 3)); // i18n-ignore
  for (const match of q.matchAll(/(下下|下个?|这个?|本|今)?\s*(周|星期|礼拜|禮拜)([一二三四五六日天])/gu)) { // i18n-ignore
    const target = CN_WEEKDAY[match[3]!]!;
    const prefix = match[1] ?? "";
    const ahead = prefix.startsWith("下下") ? [2] : prefix.startsWith("下") ? [1] : prefix ? [0] : [0, 1]; // i18n-ignore
    for (const weeks of ahead) days.add(weekday(target, weeks));
  }
  for (const match of q.matchAll(/\b(next|this|coming)?\s*(sun|mon|tue|wed|thu|fri|sat)(day|nesday|urday|sday|rsday)?\b/g)) {
    const target = EN_WEEKDAY.indexOf(match[2]!);
    for (const weeks of match[1] === "next" ? [1] : match[1] ? [0] : [0, 1]) days.add(weekday(target, weeks));
  }
  // A bare day of the month (「13日」, 「13号」 folded into it above), not one after a month: the next such day from today.
  for (const match of q.matchAll(/(^|[^0-9月/\-.])(\d{1,2})\s*日/gu)) { // i18n-ignore
    const day = Number(match[2]);
    for (let ahead = 0; ahead <= 62; ahead += 1) {
      const candidate = isoPlus(today, ahead);
      if (Number(candidate.slice(8, 10)) === day) { days.add(candidate); break; }
    }
  }
  return days;
}

/** Words that name a day relative to when they were written, whose day a file alone cannot give (「下周」「明天」「next week」). */
export const RELATIVE_DAY_WORDS = /今天|今晚|明天|明早|明晚|后天|下下?个?(周|星期|礼拜|月)|这个?(周|星期|礼拜)|本(周|月)|下学期|tomorrow|today|tonight|next (week|month|mon|tue|wed|thu|fri|sat|sun)|this (week|mon|tue|wed|thu|fri|sat|sun)/iu; // i18n-ignore
/**
 * The note an undated item carries when a file named its day only relative to when it was written (W-228, 2026-11-05): the day is not
 * guessed, and the person is asked which day it is (`profileGaps`, `DATE_RELATIVE`), with the file's own words.
 */
export const RELATIVE_NOTE = "relative:";

/** The person's words support a date when they print it, or, in a reply, name it relative to the day the reply was written. */
const supportsDate = (date: string, quote: string, sourceRef: string, today: string) =>
  quoteSupportsDate(date, quote) || (sourceRef.startsWith("reply-") && relativeDays(quote, today).has(date));

type Known = { sources: Record<string, string>; today: string };

function rangeCheck(known: Known) {
  const [ty, tm, td] = known.today.split("-").map(Number) as [number, number, number];
  const today = Date.UTC(ty, tm - 1, td);
  return (date: string) => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const delta = (Date.UTC(y, m - 1, d) - today) / 86_400_000;
    return delta >= -120 && delta <= 540;
  };
}

function checkSource(known: Known, sourceRef: string, quote: string, label: string): void {
  if (!(sourceRef in known.sources)) reject("DATE_UNKNOWN_SOURCE", `「${label}」引用了不存在的文件「${sourceRef}」。`); // i18n-ignore
  if (!squash(known.sources[sourceRef]!).includes(squash(quote))) {
    reject("DATE_QUOTE_NOT_VERBATIM", `「${label}」的引用不是 ${sourceRef} 的原文逐字内容：「${quote.slice(0, 60)}」`); // i18n-ignore
  }
}

function checkDate(item: DateCandidate, known: Known): void {
  const inRange = rangeCheck(known);
  if (!validDate(item.date)) reject("DATE_INVALID", `「${item.title}」的日期「${item.date}」不是有效的 YYYY-MM-DD。`); // i18n-ignore
  if (!inRange(item.date)) reject("DATE_OUT_OF_RANGE", `「${item.title}」的日期 ${item.date} 离今天太远，很可能年份推错了。`); // i18n-ignore
  for (const time of [item.startTime, item.endTime]) {
    if (time && !TIME.test(time)) reject("DATE_TIME_INVALID", `「${item.title}」的时间「${time}」必须是 24 小时制 HH:MM 或留空。`); // i18n-ignore
  }
  if (item.endTime && !item.startTime) reject("DATE_TIME_INVALID", `「${item.title}」有结束时间却没有开始时间。`); // i18n-ignore
  if (item.startTime && item.endTime && item.endTime <= item.startTime) reject("DATE_TIME_INVALID", `「${item.title}」的结束时间不晚于开始时间。`); // i18n-ignore
  checkSource(known, item.sourceRef, item.quote, item.title);
  if (!supportsDate(item.date, item.quote, item.sourceRef, known.today)) {
    reject("DATE_QUOTE_DOES_NOT_SUPPORT_DATE", `「${item.title}」的引用「${item.quote.slice(0, 60)}」里找不到 ${item.date} 这一天。`); // i18n-ignore
  }
}

function checkMeeting(meeting: RecurringMeeting, known: Known): void {
  const inRange = rangeCheck(known);
  if (!validDate(meeting.from) || !validDate(meeting.to) || meeting.to < meeting.from) {
    reject("DATE_INVALID", `「${meeting.title}」的起止日期不是有效区间。`); // i18n-ignore
  }
  if (!inRange(meeting.from) || !inRange(meeting.to)) reject("DATE_OUT_OF_RANGE", `「${meeting.title}」的起止日期离今天太远。`); // i18n-ignore
  if (!TIME.test(meeting.startTime) || !TIME.test(meeting.endTime) || meeting.endTime <= meeting.startTime) {
    reject("DATE_TIME_INVALID", `「${meeting.title}」的上课时间必须是 24 小时制 HH:MM，且结束晚于开始。`); // i18n-ignore
  }
  for (const exception of meeting.exceptions) {
    if (!validDate(exception)) reject("DATE_INVALID", `「${meeting.title}」的例外日期「${exception}」无效。`); // i18n-ignore
  }
  checkSource(known, meeting.sourceRef, meeting.quote, meeting.title);
}

function shape(value: unknown): DateExtraction {
  const out = value as DateExtraction | undefined;
  if (!out || !Array.isArray(out.dates) || !Array.isArray(out.recurring) || !Array.isArray(out.questions)) {
    reject("DATE_SCHEMA_INVALID", "输出结构不符合要求。"); // i18n-ignore
  }
  return out;
}

/** Strict: one bad item rejects the whole answer. Used where an answer must be exactly right. */
export function validateDateExtraction(value: unknown, known: Known): DateExtraction {
  const out = shape(value);
  const ids = new Set<string>();
  const checkId = (id: string) => { if (ids.has(id)) reject("DATE_DUPLICATE_ID", `id「${id}」重复。`); ids.add(id); }; // i18n-ignore
  for (const item of out.dates) { checkId(item.id); checkDate(item, known); }
  for (const meeting of out.recurring) { checkId(meeting.id); checkMeeting(meeting, known); }
  return out;
}

/** How long an arrangement with no end date (a job, a standing meeting) is taken to run: half a year, within the range a date may lie in. */
const OPEN_ENDED_DAYS = 182;
/**
 * A weekly arrangement whose start is a date and whose end is not one is ongoing: a job has no end date, and the lite run of 2026-10-20
 * wrote 「持续进行中，结束时间」 (exactly the field's ten characters), which dropped the hard line's whole schedule as 「not a valid range」.
 */
function openEnded(meeting: RecurringMeeting, today: string): RecurringMeeting {
  // A start in words (「即日起」, 「from now on」) or one long past (a standing meeting that began last year) starts today: only what is
  // ahead is ever placed, and more than 120 days back is refused as a misread year (W-228).
  const from = !validDate(meeting.from) || (validDate(meeting.to) && meeting.to >= today && meeting.from < isoPlus(today, -120)) ? today : meeting.from;
  if (validDate(meeting.to)) return { ...meeting, from };
  return { ...meeting, from, to: isoPlus(from, OPEN_ENDED_DAYS) };
}

/**
 * An arrangement across midnight (a night shift 22:00–06:00, W-228) is two: the evening on its own weekdays and the early hours on the
 * next. Both ends are times of one day everywhere downstream, so the check used to refuse it and the hard line's fixed schedule was lost.
 */
function acrossMidnight(meeting: RecurringMeeting): RecurringMeeting[] {
  if (!TIME.test(meeting.startTime) || !TIME.test(meeting.endTime) || meeting.endTime >= meeting.startTime) return [meeting];
  const evening = { ...meeting, endTime: "23:59" };
  if (meeting.endTime === "00:00") return [evening];
  return [evening, { ...meeting, id: `${meeting.id}-next`, weekdays: meeting.weekdays.map((day) => (day + 1) % 7), startTime: "00:00" }];
}
/**
 * A dated item across midnight keeps its evening: the day it is on is the day it starts. A moment written as a span — a deadline 「23:59」
 * given as 23:59–23:59 or 23:59–00:00 — is the moment alone (W-230: Homework 5 due 23:59 was dropped as 「时间不完整」 once the clip made
 * its end equal its start).
 */
const dateAcrossMidnight = (item: DateCandidate): DateCandidate => {
  if (!TIME.test(item.startTime) || !TIME.test(item.endTime) || item.endTime > item.startTime) return item;
  return item.endTime === item.startTime || item.startTime === "23:59" ? { ...item, endTime: "" } : { ...item, endTime: "23:59" };
};

/** Why an item was not recorded: `reason` is the detail the model is shown, `code` what the person's screens word for themselves. */
export type DateDrop = { id: string; title: string; reason: string; code: string };

/**
 * Per-item: every date stands on its own quote, so one that cannot be verified is dropped and the rest are
 * kept. Failing the whole answer for one misquoted row (a model joining two lines that are not adjacent in
 * the file) threw away a hundred good rows and a four-minute run. What was dropped is reported, never hidden.
 * An answer in which nothing survives is still an error, because that is a model that misread the file.
 */
export function sanitizeDateExtraction(value: unknown, known: Known, options: { allowEmpty?: boolean } = {}):
  { extraction: DateExtraction; dropped: DateDrop[] } {
  const out = shape(value);
  const ids = new Set<string>();
  const dropped: DateDrop[] = [];
  const attempt = <T extends { id: string; title: string }>(items: T[], check: (item: T) => void): T[] => items.filter((item) => {
    try {
      if (ids.has(item.id)) reject("DATE_DUPLICATE_ID", `id「${item.id}」重复。`); // i18n-ignore
      check(item);
      ids.add(item.id);
      return true;
    } catch (error) {
      dropped.push({ id: item.id, title: item.title, reason: (error as Error & { detail?: string }).detail ?? (error as Error).message, code: (error as Error).message });
      return false;
    }
  });
  const dates = attempt(out.dates.map(dateAcrossMidnight), (item) => checkDate(item, known));
  // A file's 「下周五」 has no day the app can check: kept as an undated item carrying the file's words, and the person is asked which day.
  const relative = out.dates.filter((item) => !item.sourceRef.startsWith("reply-") && RELATIVE_DAY_WORDS.test(item.quote)
    && dropped.some((drop) => drop.id === item.id && drop.code === "DATE_QUOTE_DOES_NOT_SUPPORT_DATE"));
  for (const item of relative) dropped.splice(dropped.findIndex((drop) => drop.id === item.id), 1);
  const askedUndated: UndatedItem[] = relative.map((item) => ({ id: item.id, kind: item.kind, title: item.title, project: item.project, sourceRef: item.sourceRef,
    quote: item.quote, note: `${RELATIVE_NOTE}${item.quote.slice(0, 120)}` }));
  const recurring = attempt(out.recurring.flatMap((meeting) => acrossMidnight(openEnded(meeting, known.today))), (meeting) => checkMeeting(meeting, known));
  // The same for one the model already put in `undated[]` (as the Skill asks): its relative words are kept, so it is asked whatever its
  // kind — a class 「下周五补课」 is not a graded part, and was skipped without a word (W-230).
  const relativeNote = (item: UndatedItem): UndatedItem => !item.note && !item.sourceRef.startsWith("reply-") && RELATIVE_DAY_WORDS.test(item.quote)
    ? { ...item, note: `${RELATIVE_NOTE}${item.quote.slice(0, 120)}` } : item;
  const undated = [...attempt(out.undated ?? [], (item) => checkSource(known, item.sourceRef, item.quote, item.title)).map(relativeNote), ...askedUndated];
  // A caller that records what was dropped (the interview's) keeps an empty answer; the default refuses it, so a repair can follow.
  if (!options.allowEmpty && out.dates.length + out.recurring.length > 0 && dates.length + recurring.length === 0) {
    reject("DATE_NOTHING_VERIFIABLE", `一条都没能在原文里核实：${dropped.slice(0, 3).map((item) => item.reason).join("；")}`); // i18n-ignore
  }
  // A date names its course (「ECE 555 课堂期末考试」, not 「课堂期末考试」): two courses each have a final, and the calendar shows the title alone.
  const named = <T extends { title: string; project: string }>(item: T): T => ({ ...item, title: withCourse(item.title, item.project) });
  // Only what is still ahead is a plan; the rest is history (decided 2026-10-08: past clues inform habits and progress, not the schedule).
  const ahead = dates.filter((item) => item.date >= known.today), weekly = recurring.filter((meeting) => meeting.to >= known.today);
  const past = [...dates.filter((item) => item.date < known.today), ...recurring.filter((meeting) => meeting.to < known.today)].map(named);
  return { extraction: { dates: ahead.map(named), recurring: weekly.map(named), questions: out.questions, undated: undated.map(named), past }, dropped };
}

/** Every date a weekly pattern covers, minus its exceptions. Weekday 0 is Sunday. */
export function expandRecurring(meeting: Pick<RecurringMeeting, "weekdays" | "from" | "to" | "exceptions">): string[] {
  const days: string[] = [];
  const [fy, fm, fd] = meeting.from.split("-").map(Number) as [number, number, number];
  const end = Date.parse(`${meeting.to}T00:00:00Z`);
  const skip = new Set(meeting.exceptions);
  for (let time = Date.UTC(fy, fm - 1, fd); time <= end; time += 86_400_000) {
    const date = new Date(time);
    const iso = date.toISOString().slice(0, 10);
    if (meeting.weekdays.includes(date.getUTCDay()) && !skip.has(iso)) days.push(iso);
  }
  return days;
}

/**
 * A new batch beside ones nobody has answered yet. A re-read of the files replaces them; any other turn only adds to them (the same id
 * takes the newer item). Every turn used to replace them: a turn that heard 「12–14 点午饭」 threw away an unanswered batch of a course's
 * dates, both midterms among them, and put the two meals in its place.
 */
export function mergeDateExtractions(earlier: DateExtraction[], next: DateExtraction): DateExtraction {
  const byId = <T extends { id: string }>(lists: T[][]): T[] => [...new Map(lists.flat().map((item) => [item.id, item])).values()];
  const all = [...earlier, next];
  return { dates: byId(all.map((batch) => batch.dates)), recurring: byId(all.map((batch) => batch.recurring)),
    questions: [...new Set(all.flatMap((batch) => batch.questions))], undated: byId(all.map((batch) => batch.undated ?? [])),
    past: [...new Map(all.flatMap((batch) => batch.past ?? []).map((item) => [item.id, item])).values()] };
}

/**
 * Ids made from what an item is, not from where the model counted it (2026-10-19): each extraction run is a fresh thread that numbers its
 * dates from d1 again, and merging by the model's ids let a later run's d1 replace an earlier run's unanswered d1. The same date read
 * twice gets the same id (the newer reading wins); two different dates never share one.
 */
export function withContentIds(extraction: DateExtraction): DateExtraction {
  const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const hash = (text: string) => { let h = 5381; for (const char of text) h = ((h * 33) ^ char.codePointAt(0)!) >>> 0; return h.toString(36); };
  const unique = <T extends { id: string }>(items: T[], key: (item: T) => string, prefix: string) => {
    const seen = new Map<string, number>();
    return items.map((item) => {
      const base = `${prefix}${hash(key(item))}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { ...item, id: n > 1 ? `${base}-${n}` : base };
    });
  };
  return { ...extraction,
    dates: unique(extraction.dates, (item) => `${item.date}|${item.startTime}|${item.kind}|${norm(item.title)}`, "d-"),
    recurring: unique(extraction.recurring, (item) => `${[...item.weekdays].sort().join(",")}|${item.startTime}|${item.endTime}|${norm(item.title)}`, "w-"),
    ...(extraction.undated ? { undated: unique(extraction.undated, (item) => `${item.kind}|${norm(item.title)}`, "u-") } : {}),
    ...(extraction.past ? { past: unique(extraction.past, (item) => JSON.stringify({ ...item, id: "" }), "p-") } : {}) };
}

/**
 * What the person already answered is not offered again. Every interview turn may return the files' dates, and a turn after the person
 * confirmed a batch returned the same 24 dates as a new one to confirm (2026-10-15 walkthrough) — confirming it twice would put every class
 * on the calendar twice. A date matches on day, start time and kind within its project, or on day and title; a weekly arrangement on its
 * weekdays and times within its project, or on its title (the model rewords 「RBT 610 课程」 as 「RBT 610 固定课程」 between turns).
 */
export function withoutDecidedDates(next: DateExtraction, decided: Array<DateCandidate | RecurringMeeting>): DateExtraction {
  const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const keys = new Set<string>();
  const dateKeys = (item: DateCandidate) => [`d|${item.date}|${item.startTime}|${item.kind}|${norm(item.project)}`, `t|${item.date}|${norm(item.title)}`];
  const weeklyKeys = (item: RecurringMeeting) => [`w|${[...item.weekdays].sort().join(",")}|${item.startTime}|${item.endTime}|${norm(item.project)}`, `n|${norm(item.title)}`];
  for (const item of decided) for (const key of "weekdays" in item ? weeklyKeys(item) : dateKeys(item)) keys.add(key);
  return { ...next, dates: next.dates.filter((item) => !dateKeys(item).some((key) => keys.has(key))),
    recurring: next.recurring.filter((item) => !weeklyKeys(item).some((key) => keys.has(key))) };
}

/**
 * Weekly arrangements that fall wholly outside the hours the person works and belong to no project — meals, sleep — say nothing the
 * available hours do not already say. Kept out of the batch, they are not offered for confirmation or for the calendar. A course's
 * class is kept even outside those hours: it is still an arrangement the person may want on the calendar. So is a hard line's own
 * schedule (上班 9:30–18:30, named by its project or its title): it lies outside the free hours by definition, and it is the fixed
 * schedule the start standard asks for.
 */
export function withoutOffHours(recurring: RecurringMeeting[], windows: Array<{ days: number[]; start: string; end: string }>,
  projects: Array<{ id: string; name: string }>,
  /** The lines whose own arrangements are kept: the interview passes every line (W-228), so a habit filed under 健康 is kept too. */
  hardLines: Array<{ id: string; label: string }> = []): RecurringMeeting[] {
  const ofHardLine = (item: RecurringMeeting) => hardLines.some((line) =>
    item.project === line.id || item.project === line.label || (line.label.length >= 2 && item.title.includes(line.label)));
  const belongs = (item: RecurringMeeting) => ofHardLine(item) || Boolean(item.project) && projects.some((project) =>
    item.project === project.id || item.project === project.name || item.project.includes(project.name));
  const overlaps = (item: RecurringMeeting) => item.weekdays.some((day) => windows.some((window) =>
    window.days.includes(day) && window.start < item.endTime && window.end > item.startTime));
  return recurring.filter((item) => belongs(item) || overlaps(item));
}
