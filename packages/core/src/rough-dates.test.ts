import { expect, test } from "vitest";
import { inRoughWindow, roughWindow, settleRoughDay } from "./rough-dates";

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

test("a window already over names none, unless the caller asks for one in the past (an overdue deadline)", () => {
  expect(roughWindow("11 月上旬", "2026-11-26")).toBeUndefined();
  expect(roughWindow("十一月中旬，已经过了", "2026-11-26", { past: true })).toEqual({ from: "2026-11-11", to: "2026-11-20", precision: "part" });
  // A window still to come is the same either way.
  expect(roughWindow("12 月中", "2026-11-26", { past: true })).toEqual(roughWindow("12 月中", "2026-11-26"));
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
  // Every clause names its own window (replay 14).
  const plan = "这周改简历，下周开始投，年前投出去";
  for (const day of ["2026-11-15", "2026-11-22", "2027-02-05"]) expect(inRoughWindow(day, plan, today)).toBe(true);
  expect(inRoughWindow("2027-02-06", plan, today)).toBe(false);
  expect(roughWindow("春节前", today)).toEqual({ from: "2026-11-14", to: "2027-02-05", precision: "term" });
  expect(roughWindow("一年前投过", today)).toBeUndefined();
});

test("a rough day settles on the window's first day for a start and its last for a deadline, 「年前」 before the Spring Festival (W-268)", () => {
  const plan = "这周改简历，下周开始投，年前投出去";
  // 「下周开始投递」 was kept as that week's Saturday: a start is the window's first day.
  expect(settleRoughDay("2026-11-21", "下周开始投递", today)).toBe("2026-11-16");
  expect(settleRoughDay("2026-11-21", plan, today)).toBe("2026-11-16");
  // 「年前」 was kept as 12-31: a deadline is the window's last day, the day before the Spring Festival.
  expect(settleRoughDay("2026-12-31", plan, today)).toBe("2027-02-05");
  expect(settleRoughDay("2026-12-31", "年前投出去", today)).toBe("2027-02-05");
  expect(settleRoughDay("2026-11-15", plan, today)).toBe("2026-11-15");
  expect(settleRoughDay("2026-11-20", "11 月底前", today)).toBe("2026-11-30");
  // The caller's role wins over the clause's words; a day no window holds is left alone.
  expect(settleRoughDay("2026-11-20", "下周", today, "start")).toBe("2026-11-16");
  expect(settleRoughDay("2027-03-01", "年前投出去", today)).toBeUndefined();
  expect(settleRoughDay("2026-11-18", "下周三", today)).toBeUndefined();
});
