import { expect, test } from "vitest";
import { DATE_EXTRACTION_SCHEMA, expandRecurring, quoteSupportsDate, sanitizeDateExtraction, validateDateExtraction, type DateExtraction } from "./date-schema";

const known = {
  today: "2026-10-02",
  sources: {
    "src-1": "9/28 DC Inverter #2 #1\n10/9 Review/Slack #2 Out\n12/7 Final Exam (in class)",
    "src-2": "Week-8: 27th Oct.\nL15: Mid-term-1\nL16: BJT-3\nExam: 17th December Wednesday",
    "src-3": "Meeting Time and Location\nMon and Fri 2:30PM - 3:45PM Plant Sci 108"
  }
};
const item = (over: object = {}) => ({ id: "d1", date: "2026-10-27", startTime: "", endTime: "", kind: "exam" as const,
  title: "ECE 548 期中 1", project: "ece548", sourceRef: "src-2", quote: "27th Oct. L15: Mid-term-1", confidence: "high" as const, note: "", ...over });
const out = (over: Partial<DateExtraction> = {}): DateExtraction => ({ dates: [item()], recurring: [], questions: [], ...over });
const rejected = (value: unknown, code: string) => {
  try { validateDateExtraction(value, known); } catch (error) { expect((error as Error).message).toBe(code); return; }
  throw new Error(`expected ${code}`);
};

test("a date whose quote really contains that day is accepted", () => {
  expect(validateDateExtraction(out(), known).dates).toHaveLength(1);
});

test("quotes may spell the day many ways", () => {
  expect(quoteSupportsDate("2026-10-27", "27th Oct. L15")).toBe(true);
  expect(quoteSupportsDate("2026-10-27", "Oct 27: midterm")).toBe(true);
  expect(quoteSupportsDate("2026-10-27", "October 27th")).toBe(true);
  expect(quoteSupportsDate("2026-10-27", "10/27 Mid-term")).toBe(true);
  expect(quoteSupportsDate("2026-10-27", "10月27日 期中")).toBe(true);
  expect(quoteSupportsDate("2026-12-07", "12/7 Final Exam")).toBe(true);
});

test("a quote that names a different day does not support the date", () => {
  expect(quoteSupportsDate("2026-10-27", "10/2 DC Inverter")).toBe(false);
  expect(quoteSupportsDate("2026-10-27", "Week-8: 28th Oct.")).toBe(false);
  expect(quoteSupportsDate("2026-12-07", "12/17 Final")).toBe(false);
});

test("a misread row is refused: the quote is real but does not say this date", () => {
  rejected(out({ dates: [item({ date: "2026-11-03", quote: "27th Oct. L15: Mid-term-1" })] }), "DATE_QUOTE_DOES_NOT_SUPPORT_DATE");
});

test("an invented quote, an unknown file and an impossible date are all refused", () => {
  rejected(out({ dates: [item({ quote: "27th Oct. Midterm in room 5" })] }), "DATE_QUOTE_NOT_VERBATIM");
  rejected(out({ dates: [item({ sourceRef: "src-9" })] }), "DATE_UNKNOWN_SOURCE");
  rejected(out({ dates: [item({ date: "2026-02-30" })] }), "DATE_INVALID");
});

test("a quote that drops the source's punctuation still counts as verbatim", () => {
  const source = "Week-8: 27th Oct.\n\nL15: Mid-term-1";
  const known = { sources: { "src-1": source }, today: "2026-10-02" };
  const dates = [item({ date: "2026-10-27", sourceRef: "src-1", quote: "Week-8: 27th Oct\n\nL15: Mid-term-1" })];
  expect(sanitizeDateExtraction(out({ dates }), known).dropped).toEqual([]);
});

test("a year the document never states cannot drift the date far from today", () => {
  rejected(out({ dates: [item({ date: "2031-10-27" })] }), "DATE_OUT_OF_RANGE");
});

test("times must be 24-hour HH:MM and end after start", () => {
  rejected(out({ dates: [item({ startTime: "2:30PM", endTime: "3:45PM" })] }), "DATE_TIME_INVALID");
  rejected(out({ dates: [item({ startTime: "15:45", endTime: "14:30" })] }), "DATE_TIME_INVALID");
  expect(validateDateExtraction(out({ dates: [item({ startTime: "14:30", endTime: "15:45" })] }), known).dates[0]?.startTime).toBe("14:30");
});

test("duplicate ids are refused", () => {
  rejected(out({ dates: [item(), item()] }), "DATE_DUPLICATE_ID");
});

test("a weekly meeting needs a grounded quote and a sane range", () => {
  const meeting = { id: "m1", title: "ECE 555 上课", project: "ece555", weekdays: [1, 5], startTime: "14:30", endTime: "15:45",
    from: "2026-09-04", to: "2026-12-07", exceptions: ["2026-09-07"], location: "Plant Sci 108", sourceRef: "src-3",
    quote: "Mon and Fri 2:30PM - 3:45PM", confidence: "high" as const };
  expect(validateDateExtraction(out({ dates: [], recurring: [meeting] }), known).recurring).toHaveLength(1);
  rejected(out({ dates: [], recurring: [{ ...meeting, quote: "Tue and Thu 2:30PM" }] }), "DATE_QUOTE_NOT_VERBATIM");
  rejected(out({ dates: [], recurring: [{ ...meeting, to: "2026-08-01" }] }), "DATE_INVALID");
});

test("a weekly pattern expands to exactly its meeting days, minus exceptions", () => {
  const days = expandRecurring({ weekdays: [1, 5], from: "2026-09-04", to: "2026-09-18", exceptions: ["2026-09-07"] });
  // Fri 9/4, (Mon 9/7 skipped), Fri 9/11, Mon 9/14, Fri 9/18
  expect(days).toEqual(["2026-09-04", "2026-09-11", "2026-09-14", "2026-09-18"]);
});

test("the schema is strict", () => {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; items?: unknown };
    if (n.type === "object") {
      expect(n.additionalProperties).toBe(false);
      expect([...(n.required ?? [])].sort()).toEqual(Object.keys(n.properties ?? {}).sort());
      Object.values(n.properties ?? {}).forEach(walk);
    }
    walk(n.items);
  };
  walk(DATE_EXTRACTION_SCHEMA);
});

test("sanitizing keeps the verifiable dates and drops, with a reason, the ones whose quote is not real", () => {
  const joined = item({ id: "bad", title: "感恩节", date: "2026-11-24", quote: "Week-8: 27th Oct.  Thanksgiving" });
  const { extraction, dropped } = sanitizeDateExtraction(out({ dates: [item(), joined] }), known);
  expect(extraction.dates.map((entry) => entry.id)).toEqual(["d1"]);
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toMatchObject({ id: "bad", title: "感恩节" });
  expect(dropped[0]!.reason).toContain("逐字");
});

test("an answer in which nothing can be verified is still an error, not an empty success", () => {
  try { sanitizeDateExtraction(out({ dates: [item({ quote: "invented text 27th Oct." })] }), known); } catch (error) {
    expect((error as Error).message).toBe("DATE_NOTHING_VERIFIABLE");
    return;
  }
  throw new Error("expected DATE_NOTHING_VERIFIABLE");
});

test("an empty answer is a legitimate answer: a file with no dates", () => {
  expect(sanitizeDateExtraction(out({ dates: [], recurring: [] }), known).extraction.dates).toEqual([]);
});

test("a duplicate id keeps the first and drops the repeat", () => {
  const { extraction, dropped } = sanitizeDateExtraction(out({ dates: [item(), item()] }), known);
  expect(extraction.dates).toHaveLength(1);
  expect(dropped[0]!.reason).toContain("重复");
});

test("a graded part the file marks TBD is kept as undated, with a quote from the file, not turned into a date and not lost", () => {
  const withTbd = { ...known, sources: { ...known.sources, "src-4": "11/23 SRAM #5\nTBD Final Project Report Due" } };
  const tbd = (over: object = {}) => ({ id: "u1", kind: "project_due" as const, title: "Final Project Report", project: "ece555", sourceRef: "src-4", quote: "TBD Final Project Report Due", note: "", ...over });
  const { extraction, dropped } = sanitizeDateExtraction(out({ dates: [], undated: [tbd(), tbd({ id: "u2", quote: "Final Project due Dec 11" })] }), withTbd);
  expect(extraction.undated?.map((entry) => entry.id)).toEqual(["u1"]);
  expect(extraction.dates).toEqual([]);
  expect(dropped.map((entry) => entry.id)).toEqual(["u2"]);
});

test("an answer from before undated existed still passes", () => {
  const legacy = { dates: [item()], recurring: [], questions: [] } as DateExtraction;
  expect(sanitizeDateExtraction(legacy, known).extraction.undated).toEqual([]);
});

test("a kept date names its course: a bare 「课堂期末考试」 under ECE 555 becomes 「ECE 555 课堂期末考试」, an uncertain course is not guessed in", () => {
  const { extraction } = sanitizeDateExtraction(out({ dates: [
    item({ id: "f", date: "2026-12-07", title: "课堂期末考试", project: "ECE 555", sourceRef: "src-1", quote: "12/7 Final Exam (in class)" }),
    item({ id: "m", title: "期中考试 1", project: "课程待确认（可能为 ECE 548）" })] }), known);
  expect(extraction.dates.map((date) => date.title)).toEqual(["ECE 555 课堂期末考试", "期中考试 1"]);
});
