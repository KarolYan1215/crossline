import { withCourse } from "./task-title";

/**
 * Dates a person's own documents state — class meetings, quiz and homework dates, exams, deadlines.
 *
 * Reading these out of a syllabus is a job for a model, but a wrong date on a calendar is worse than no
 * date, so nothing here is trusted on the model's say-so. Every date must come with a verbatim quote from
 * the file, and the quote has to actually contain that day (`10/27`, `27th Oct.`, `Oct 27`, `10月27日`):
 * a model that mis-reads a table row, or adds a year the file never mentions, produces a quote that does
 * not support its own date, and the whole extraction is sent back for repair.
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

export const DATE_EXTRACTION_SCHEMA = object({
  dates: {
    type: "array", maxItems: 60,
    items: object({
      id: text(60, 1), date: text(10, 10), startTime: text(5), endTime: text(5),
      kind: { type: "string", enum: [...DATE_KINDS] }, title: text(160, 1), project: text(80),
      sourceRef: text(60, 1), quote: text(400, 1), confidence, note: text(300)
    })
  },
  recurring: {
    type: "array", maxItems: 12,
    items: object({
      id: text(60, 1), title: text(160, 1), project: text(80),
      weekdays: { type: "array", minItems: 1, maxItems: 7, items: { type: "integer", minimum: 0, maximum: 6 } },
      startTime: text(5, 5), endTime: text(5, 5), from: text(10, 10), to: text(10, 10),
      exceptions: { type: "array", maxItems: 30, items: text(10, 10) }, location: text(120),
      sourceRef: text(60, 1), quote: text(400, 1), confidence
    })
  },
  questions: { type: "array", maxItems: 10, items: text(300, 1) },
  undated: {
    type: "array", maxItems: 12,
    items: object({
      id: text(60, 1), kind: { type: "string", enum: [...DATE_KINDS] }, title: text(160, 1), project: text(80),
      sourceRef: text(60, 1), quote: text(400, 1), note: text(300)
    })
  }
});

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
  const q = quote.toLowerCase();
  if (new RegExp(`(^|[^0-9])0?${month}\\s*[/\\-.]\\s*0?${day}(?![0-9])`).test(q)) return true;
  if (new RegExp(`0?${month}\\s*月\\s*0?${day}`).test(q)) return true;
  for (const name of [MONTHS[month - 1]!, MONTH_NAMES[month - 1]!]) {
    if (new RegExp(`(^|[^a-z])${name}[a-z]*\\.?\\s*0?${day}(?![0-9])`).test(q)) return true;
    if (new RegExp(`(^|[^0-9])0?${day}(st|nd|rd|th)?\\s*(of\\s+)?${name}`).test(q)) return true;
  }
  return false;
}

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
  if (!(sourceRef in known.sources)) reject("DATE_UNKNOWN_SOURCE", `「${label}」引用了不存在的文件「${sourceRef}」。`);
  if (!squash(known.sources[sourceRef]!).includes(squash(quote))) {
    reject("DATE_QUOTE_NOT_VERBATIM", `「${label}」的引用不是 ${sourceRef} 的原文逐字内容：「${quote.slice(0, 60)}」`);
  }
}

function checkDate(item: DateCandidate, known: Known): void {
  const inRange = rangeCheck(known);
  if (!validDate(item.date)) reject("DATE_INVALID", `「${item.title}」的日期「${item.date}」不是有效的 YYYY-MM-DD。`);
  if (!inRange(item.date)) reject("DATE_OUT_OF_RANGE", `「${item.title}」的日期 ${item.date} 离今天太远，很可能年份推错了。`);
  for (const time of [item.startTime, item.endTime]) {
    if (time && !TIME.test(time)) reject("DATE_TIME_INVALID", `「${item.title}」的时间「${time}」必须是 24 小时制 HH:MM 或留空。`);
  }
  if (item.endTime && !item.startTime) reject("DATE_TIME_INVALID", `「${item.title}」有结束时间却没有开始时间。`);
  if (item.startTime && item.endTime && item.endTime <= item.startTime) reject("DATE_TIME_INVALID", `「${item.title}」的结束时间不晚于开始时间。`);
  checkSource(known, item.sourceRef, item.quote, item.title);
  if (!quoteSupportsDate(item.date, item.quote)) {
    reject("DATE_QUOTE_DOES_NOT_SUPPORT_DATE", `「${item.title}」的引用「${item.quote.slice(0, 60)}」里找不到 ${item.date} 这一天。`);
  }
}

function checkMeeting(meeting: RecurringMeeting, known: Known): void {
  const inRange = rangeCheck(known);
  if (!validDate(meeting.from) || !validDate(meeting.to) || meeting.to < meeting.from) {
    reject("DATE_INVALID", `「${meeting.title}」的起止日期不是有效区间。`);
  }
  if (!inRange(meeting.from) || !inRange(meeting.to)) reject("DATE_OUT_OF_RANGE", `「${meeting.title}」的起止日期离今天太远。`);
  if (!TIME.test(meeting.startTime) || !TIME.test(meeting.endTime) || meeting.endTime <= meeting.startTime) {
    reject("DATE_TIME_INVALID", `「${meeting.title}」的上课时间必须是 24 小时制 HH:MM，且结束晚于开始。`);
  }
  for (const exception of meeting.exceptions) {
    if (!validDate(exception)) reject("DATE_INVALID", `「${meeting.title}」的例外日期「${exception}」无效。`);
  }
  checkSource(known, meeting.sourceRef, meeting.quote, meeting.title);
}

function shape(value: unknown): DateExtraction {
  const out = value as DateExtraction | undefined;
  if (!out || !Array.isArray(out.dates) || !Array.isArray(out.recurring) || !Array.isArray(out.questions)) {
    reject("DATE_SCHEMA_INVALID", "输出结构不符合要求。");
  }
  return out;
}

/** Strict: one bad item rejects the whole answer. Used where an answer must be exactly right. */
export function validateDateExtraction(value: unknown, known: Known): DateExtraction {
  const out = shape(value);
  const ids = new Set<string>();
  const checkId = (id: string) => { if (ids.has(id)) reject("DATE_DUPLICATE_ID", `id「${id}」重复。`); ids.add(id); };
  for (const item of out.dates) { checkId(item.id); checkDate(item, known); }
  for (const meeting of out.recurring) { checkId(meeting.id); checkMeeting(meeting, known); }
  return out;
}

/**
 * Per-item: every date stands on its own quote, so one that cannot be verified is dropped and the rest are
 * kept. Failing the whole answer for one misquoted row (a model joining two lines that are not adjacent in
 * the file) threw away a hundred good rows and a four-minute run. What was dropped is reported, never hidden.
 * An answer in which nothing survives is still an error, because that is a model that misread the file.
 */
export function sanitizeDateExtraction(value: unknown, known: Known):
  { extraction: DateExtraction; dropped: Array<{ id: string; title: string; reason: string }> } {
  const out = shape(value);
  const ids = new Set<string>();
  const dropped: Array<{ id: string; title: string; reason: string }> = [];
  const attempt = <T extends { id: string; title: string }>(items: T[], check: (item: T) => void): T[] => items.filter((item) => {
    try {
      if (ids.has(item.id)) reject("DATE_DUPLICATE_ID", `id「${item.id}」重复。`);
      check(item);
      ids.add(item.id);
      return true;
    } catch (error) {
      dropped.push({ id: item.id, title: item.title, reason: (error as Error & { detail?: string }).detail ?? (error as Error).message });
      return false;
    }
  });
  const dates = attempt(out.dates, (item) => checkDate(item, known));
  const recurring = attempt(out.recurring, (meeting) => checkMeeting(meeting, known));
  const undated = attempt(out.undated ?? [], (item) => checkSource(known, item.sourceRef, item.quote, item.title));
  if (out.dates.length + out.recurring.length > 0 && dates.length + recurring.length === 0) {
    reject("DATE_NOTHING_VERIFIABLE", `一条都没能在原文里核实：${dropped.slice(0, 3).map((item) => item.reason).join("；")}`);
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
 * Weekly arrangements that fall wholly outside the hours the person works and belong to no project — meals, sleep — say nothing the
 * available hours do not already say. Kept out of the batch, they are not offered for confirmation or for the calendar. A course's
 * class is kept even outside those hours: it is still an arrangement the person may want on the calendar.
 */
export function withoutOffHours(recurring: RecurringMeeting[], windows: Array<{ days: number[]; start: string; end: string }>,
  projects: Array<{ id: string; name: string }>): RecurringMeeting[] {
  const belongs = (item: RecurringMeeting) => Boolean(item.project) && projects.some((project) =>
    item.project === project.id || item.project === project.name || item.project.includes(project.name));
  const overlaps = (item: RecurringMeeting) => item.weekdays.some((day) => windows.some((window) =>
    window.days.includes(day) && window.start < item.endTime && window.end > item.startTime));
  return recurring.filter((item) => belongs(item) || overlaps(item));
}
