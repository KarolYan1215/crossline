import { describe, expect, test } from "vitest";
import { DATE_EXTRACTION_SCHEMA, expandRecurring, mergeDateExtractions, withoutOffHours, quoteSupportsDate, relativeDays, sanitizeDateExtraction, validateDateExtraction, type DateExtraction } from "./date-schema";

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

test("a date already past is history, not a plan: kept apart, never offered for the calendar", () => {
  const past = item({ id: "d0", date: "2026-09-28", quote: "9/28 DC Inverter #2 #1", sourceRef: "src-1", title: "ECE 555 作业 2 发布", project: "ECE 555" });
  const { extraction } = sanitizeDateExtraction(out({ dates: [item(), past] }), known);
  expect(extraction.dates.map((entry) => entry.id)).toEqual(["d1"]);
  expect(extraction.past?.map((entry) => entry.id)).toEqual(["d0"]);
});

describe("batches and arrangements", () => {
  const recurring = (over: object) => ({ id: "r", title: "", project: "", weekdays: [1], startTime: "12:00", endTime: "13:00", from: "2026-10-01", to: "2026-12-31",
    exceptions: [], location: "", sourceRef: "reply-1", quote: "", confidence: "medium" as const, ...over });
  test("a later batch adds to an unanswered one, the same id taking the newer item", () => {
    const date = (id: string, title: string) => ({ id, date: "2026-10-27", startTime: "", endTime: "", kind: "exam" as const, title, project: "", sourceRef: "src-1", quote: "", confidence: "high" as const, note: "" });
    const merged = mergeDateExtractions([{ dates: [date("a", "期中 1"), date("b", "旧")], recurring: [], questions: ["哪门课？"] }],
      { dates: [date("b", "新")], recurring: [], questions: ["哪门课？", "几点？"] });
    expect(merged.dates.map((item) => `${item.id}:${item.title}`)).toEqual(["a:期中 1", "b:新"]);
    expect(merged.questions).toEqual(["哪门课？", "几点？"]);
  });
  test("meals outside the working hours are left out; a course's class is kept wherever it falls", () => {
    const windows = [{ days: [1], start: "09:00", end: "12:00" }, { days: [1], start: "14:00", end: "18:00" }];
    const kept = withoutOffHours([recurring({ id: "lunch", title: "午饭", project: "个人安排" }), recurring({ id: "class", title: "上课", project: "ECE 555", startTime: "19:00", endTime: "20:00" }),
      recurring({ id: "group", title: "组会", startTime: "10:00", endTime: "11:00" })], windows, [{ id: "ece555", name: "ECE 555" }]);
    expect(kept.map((item) => item.id)).toEqual(["class", "group"]);
  });

  // The lite run of 2026-10-20: a job has no end date, and the model wrote 「持续进行中，结束时间」 (exactly the field's ten characters) as `to`.
  test("a weekly arrangement with no end date runs 26 weeks from its start instead of being dropped", () => {
    const work = recurring({ id: "work", title: "上班", project: "上班", weekdays: [1, 2, 3, 4, 5], startTime: "09:30", endTime: "18:30",
      from: "2026-10-20", to: "持续进行中，结束时间", sourceRef: "src-3", quote: "Mon and Fri 2:30PM - 3:45PM Plant Sci 108" });
    const { extraction, dropped } = sanitizeDateExtraction({ dates: [], recurring: [work], questions: [] }, { ...known, today: "2026-10-20" });
    expect(dropped).toEqual([]);
    expect(extraction.recurring[0]?.to).toBe("2027-04-20");
  });

  // The lite run of 2026-10-20: 「工作日 9:30–18:30 上班」 lay wholly outside the evening hours the person stated and named no project,
  // so it was dropped and the hard line's fixed schedule could never be collected.
  test("a hard line's own schedule is kept outside the stated hours, by its project or its title", () => {
    const windows = [{ days: [1, 2, 3, 4, 5], start: "20:00", end: "24:00" }];
    const work = { startTime: "09:30", endTime: "18:30", weekdays: [1, 2, 3, 4, 5] };
    const kept = withoutOffHours([recurring({ id: "byProject", title: "到岗", project: "上班", ...work }),
      recurring({ id: "byTitle", title: "上班（工作日）", project: "", ...work }), recurring({ id: "lunch", title: "午饭", project: "" })],
    windows, [], [{ id: "line-x", label: "上班" }]);
    expect(kept.map((item) => item.id)).toEqual(["byProject", "byTitle"]);
  });
});

// A turn after the person confirmed a batch returned the same dates as a new batch to confirm (2026-10-15 walkthrough).
test("dates the person already decided are not offered again, even reworded", async () => {
  const { withoutDecidedDates } = await import("./date-schema");
  const date = (id: string, title: string, day: string, kind: "quiz" | "exam" = "quiz") => ({ id, date: day, startTime: "", endTime: "", kind, title, project: "rbt610",
    sourceRef: "src-1", quote: day, confidence: "high" as const, note: "" });
  const weekly = (id: string, title: string) => ({ id, title, project: "rbt610", weekdays: [2, 4], startTime: "11:00", endTime: "12:15", from: "2026-10-15",
    to: "2026-12-10", exceptions: [], location: "", sourceRef: "src-1", quote: "Tuesday and Thursday", confidence: "high" as const });
  const decided = [date("a", "RBT 610 测验 3", "2026-10-15"), weekly("w", "RBT 610 课程")];
  const next = { dates: [date("b", "RBT 610 第三次测验", "2026-10-15"), date("c", "RBT 610 期中考试", "2026-10-29", "exam")],
    recurring: [weekly("v", "RBT 610 固定课程")], questions: [] };
  const left = withoutDecidedDates(next, decided);
  expect(left.dates.map((item) => item.id)).toEqual(["c"]);
  expect(left.recurring).toEqual([]);
});

describe("what a person says the way people say it is recorded, and what is not is said (W-228)", () => {
  // 2026-10-02 is a Friday.
  test("a reply's relative day is its date; Chinese numerals and 号 count", () => {
    expect([...relativeDays("下周五交报告", "2026-10-02")]).toEqual(["2026-10-09"]);
    expect(relativeDays("明天考试", "2026-10-02").has("2026-10-03")).toBe(true);
    expect(relativeDays("后天", "2026-10-02").has("2026-10-04")).toBe(true);
    expect([...relativeDays("周三组会", "2026-10-02")].sort()).toEqual(["2026-09-30", "2026-10-07"]);
    expect([...relativeDays("这周日休息", "2026-10-02")]).toEqual(["2026-10-04"]);
    expect([...relativeDays("13号截止", "2026-10-02")]).toEqual(["2026-10-13"]);
    expect([...relativeDays("due next Friday", "2026-10-02")]).toEqual(["2026-10-09"]);
    expect(relativeDays("我在做 monitor 和 wedding 相册", "2026-10-02").size).toBe(0);
    expect(quoteSupportsDate("2026-11-13", "十一月十三号考试")).toBe(true);
    expect(quoteSupportsDate("2026-12-25", "十二月二十五日交")).toBe(true);
    expect(quoteSupportsDate("2026-11-13", "十一月十四号考试")).toBe(false);
  });
  test("a relative day is checked against today only in a reply; in a file it becomes a question with the file's words", () => {
    const sources = { ...known.sources, "reply-3": "下周五交报告。", "src-9": "下周五交报告。" };
    const date = (sourceRef: string) => item({ id: sourceRef, date: "2026-10-09", sourceRef, quote: "下周五交报告。", title: "报告" });
    const { extraction, dropped } = sanitizeDateExtraction(out({ dates: [date("reply-3"), date("src-9")] }), { today: known.today, sources });
    expect(extraction.dates.map((entry) => entry.id)).toEqual(["reply-3"]);
    expect(dropped).toEqual([]);
    expect(extraction.undated).toEqual([expect.objectContaining({ id: "src-9", title: "ECE 548 报告", note: "relative:下周五交报告。" })]);
  });
  test("a file's relative day the model already put in undated[] carries the file's words, so it is asked whatever its kind (W-230)", () => {
    const sources = { ...known.sources, "src-9": "因教室冲突，下周五下午 2:30–3:45 补一次课，地点 Engineering Hall B201。" };
    const { extraction } = sanitizeDateExtraction(out({ dates: [], undated: [{ id: "u", kind: "class", title: "ECE 555 补课", project: "ece555", sourceRef: "src-9",
      quote: "下周五下午 2:30–3:45 补一次课", note: "" }] }), { today: known.today, sources }, { allowEmpty: true });
    expect(extraction.undated).toEqual([expect.objectContaining({ kind: "class", note: "relative:下周五下午 2:30–3:45 补一次课" })]);
  });
  test("the model's own note on a relative undated item gives way to the file's words (W-232)", () => {
    const sources = { ...known.sources, "src-9": "因教室冲突，下周五下午 2:30–3:45 补一次课，地点 Engineering Hall B201。" };
    const { extraction } = sanitizeDateExtraction(out({ dates: [], undated: [{ id: "u", kind: "class", title: "ECE 555 补课", project: "ece555", sourceRef: "src-9",
      quote: "下周五下午 2:30–3:45 补一次课", note: "下周五 14:30 至 15:45，Engineering Hall B201。" }] }), { today: known.today, sources }, { allowEmpty: true });
    expect(extraction.undated).toEqual([expect.objectContaining({ note: "relative:下周五下午 2:30–3:45 补一次课" })]);
  });
  test("a deadline written as a span that ends where it starts is kept as the moment (W-230)", () => {
    const sources = { ...known.sources, "src-9": "Homework 5 截止时间：2026-11-21 23:59，在 Canvas 提交。" };
    const due = (id: string, endTime: string) => item({ id, date: "2026-11-21", startTime: "23:59", endTime, sourceRef: "src-9",
      quote: "Homework 5 截止时间：2026-11-21 23:59", title: "Homework 5" });
    const { extraction, dropped } = sanitizeDateExtraction(out({ dates: [due("a", "00:00"), due("b", "23:59")] }), { today: known.today, sources });
    expect(dropped).toEqual([]);
    expect(extraction.dates.map((entry) => [entry.startTime, entry.endTime])).toEqual([["23:59", ""], ["23:59", ""]]);
  });
  test("a night shift is split at midnight, a start in words starts today, and nothing verified is reported, not thrown, when asked", () => {
    const shift = { id: "w", title: "夜班", project: "", weekdays: [1, 3], startTime: "22:00", endTime: "06:00", from: "即日起", to: "", exceptions: [],
      location: "", sourceRef: "src-3", quote: "Mon and Fri 2:30PM - 3:45PM", confidence: "high" as const };
    const { extraction } = sanitizeDateExtraction(out({ dates: [], recurring: [shift] }), known);
    expect(extraction.recurring.map((entry) => [entry.weekdays, entry.startTime, entry.endTime, entry.from])).toEqual([
      [[1, 3], "22:00", "23:59", "2026-10-02"], [[2, 4], "00:00", "06:00", "2026-10-02"]]);
    const bad = out({ dates: [item({ quote: "Week-8: 27th Oct.", date: "2026-10-28" })] });
    expect(() => sanitizeDateExtraction(bad, known)).toThrow("DATE_NOTHING_VERIFIABLE");
    expect(sanitizeDateExtraction(bad, known, { allowEmpty: true }).dropped).toEqual([expect.objectContaining({ code: "DATE_QUOTE_DOES_NOT_SUPPORT_DATE" })]);
  });
});
