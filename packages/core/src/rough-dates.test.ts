import { expect, test } from "vitest";
import { inRoughWindow, roughWindow } from "./rough-dates";
import { DATE_ASK, undecidedAnswer } from "./question-ledger";

// 2026-11-14 is a Saturday.
const today = "2026-11-14";

test("rough words name a window of days from today; exact days and words with no time name none", () => {
  expect(roughWindow("下周吧", today)).toEqual({ from: "2026-11-16", to: "2026-11-22", precision: "week" });
  expect(roughWindow("这周内", today)).toEqual({ from: "2026-11-14", to: "2026-11-15", precision: "week" });
  expect(roughWindow("11 月底前", today)).toEqual({ from: "2026-11-14", to: "2026-11-30", precision: "part" });
  expect(roughWindow("十二月中", today)).toEqual({ from: "2026-12-11", to: "2026-12-20", precision: "part" });
  expect(roughWindow("1 月上旬", today)).toEqual({ from: "2027-01-01", to: "2027-01-10", precision: "part" });
  expect(roughWindow("下个月", today)).toEqual({ from: "2026-12-01", to: "2026-12-31", precision: "month" });
  expect(roughWindow("期末前", today)?.to).toBe("2027-01-15");
  expect(roughWindow("寒假", today)).toMatchObject({ from: "2027-01-15", to: "2027-02-25" });
  expect(roughWindow("两周内", today)).toEqual({ from: "2026-11-14", to: "2026-11-28", precision: "span" });
  expect(roughWindow("大概两个月", today)?.to).toBe("2027-01-13");
  // Days, not windows: read by the exact-date readers.
  expect(roughWindow("下周三", today)).toBeUndefined();
  expect(roughWindow("12 月 3 日", today)).toBeUndefined();
  expect(roughWindow("还没定", today)).toBeUndefined();
  // A window that has passed names nothing.
  expect(roughWindow("10 月底前", "2026-12-05")).toBeUndefined();
});

test("quarters, halves, seasons and next year are windows too", () => {
  expect(roughWindow("明年一季度", today)).toEqual({ from: "2027-01-01", to: "2027-03-31", precision: "quarter" });
  expect(roughWindow("Q4", today)).toEqual({ from: "2026-11-14", to: "2026-12-31", precision: "quarter" });
  expect(roughWindow("第二季度", today)).toMatchObject({ from: "2027-04-01", to: "2027-06-30" });
  expect(roughWindow("明年上半年", today)).toMatchObject({ from: "2027-01-01", to: "2027-06-30" });
  expect(roughWindow("开春以后", today)).toEqual({ from: "2027-03-01", to: "2027-05-31", precision: "season" });
  expect(roughWindow("冬天", today)).toMatchObject({ from: "2026-12-01", to: "2027-02-28" });
  expect(roughWindow("冬天", "2027-01-10")).toMatchObject({ from: "2027-01-10", to: "2027-02-28" });
  expect(roughWindow("明年年初", today)).toMatchObject({ from: "2027-01-01", to: "2027-02-28" });
  expect(roughWindow("明年底前", today)).toMatchObject({ from: "2026-11-14", to: "2027-12-31" });
  expect(roughWindow("明年 11 月", today)).toMatchObject({ from: "2027-11-01", to: "2027-11-30" });
  expect(roughWindow("明年吧", today)).toEqual({ from: "2027-01-01", to: "2027-12-31", precision: "year" });
  expect(roughWindow("年底", today)).toMatchObject({ to: "2026-12-31" });
});

test("a day inside the window is supported by the words, one outside is not", () => {
  expect(inRoughWindow("2026-11-30", "11 月底前", today)).toBe(true);
  expect(inRoughWindow("2026-12-01", "11 月底前", today)).toBe(false);
  expect(inRoughWindow("2026-11-20", "下周", today)).toBe(true);
});

test("day questions and answers that leave the day open are told apart", () => {
  for (const text of ["简历打算哪天做出来？", "约人聊的事打算什么时候开始？", "截止定在几号？", "投简历这件事，大概哪个时间范围内要投出去？", "打算哪个月开始？"]) expect(DATE_ASK.test(text)).toBe(true);
  for (const text of ["你最想先弄清楚的是什么？", "那段时间你在做什么？", "固定安排之外，每周大概哪些时段可以用来做自己的事？", "每周什么时间段有空？", "一段专注最长多久？", "每周哪几天有课？"]) expect(DATE_ASK.test(text)).toBe(false);
  for (const text of ["还没定", "看情况吧", "要先想好投哪类，再定"]) expect(undecidedAnswer(text)).toBe(true);
  expect(undecidedAnswer("下周三")).toBe(false);
});
