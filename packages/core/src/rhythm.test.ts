import { expect, test } from "vitest";
import { NO_RHYTHM, summarizeRhythm } from "./rhythm";

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString();
const seg = (from: string, to: string, category = "coding", idle = false) => ({ start: from, end: to, category, idle });

test("focus runs are the stretches of work-like activity, with a short glance away not breaking one", () => {
  const rhythm = summarizeRhythm({ finished: [], segments: [
    // 40 minutes, a 2-minute detour to a phone, 20 more: one 62-minute run.
    seg(at(1, 9), at(1, 9, 40)), seg(at(1, 9, 40), at(1, 9, 42), "leisure"), seg(at(1, 9, 42), at(1, 10, 2)),
    // a 30-minute run, and a 3-minute blip too short to count
    seg(at(2, 9), at(2, 9, 30), "writing"), seg(at(2, 14), at(2, 14, 3), "coding"),
    seg(at(3, 9), at(3, 10), "reading")
  ] });
  // Runs: 62, 30, 60 (the 3-minute blip is dropped) -> median 60.
  expect(rhythm.focusRunMinutes).toBe(60);
  expect(rhythm.observedDays).toBe(3);
  // Work-like minutes per day: 60, 33 and 60.
  expect(rhythm.productiveMinutesPerDay).toBe(51);
});

test("a daily figure needs several days, a ratio needs several finished tasks, and nothing is invented before then", () => {
  const few = summarizeRhythm({ segments: [seg(at(1, 9), at(1, 10))], finished: [{ actualMinutes: 30, estimatedMinutes: 60 }, { actualMinutes: 50, estimatedMinutes: 60 }] });
  expect(few.productiveMinutesPerDay).toBe(0);
  expect(few.planActualRatio).toBe(0);
  expect(few.completed).toBe(2);
  expect(summarizeRhythm({ segments: [], finished: [] })).toEqual(NO_RHYTHM);
});

test("the ratio is the median of actual over estimated, held between 0.4 and 2", () => {
  const finished = (pairs: Array<[number, number]>) => pairs.map(([actualMinutes, estimatedMinutes]) => ({ actualMinutes, estimatedMinutes }));
  expect(summarizeRhythm({ segments: [], finished: finished([[30, 60], [36, 60], [42, 60]]) }).planActualRatio).toBe(0.6);
  expect(summarizeRhythm({ segments: [], finished: finished([[5, 60], [6, 60], [7, 60]]) }).planActualRatio).toBe(0.4);
  expect(summarizeRhythm({ segments: [], finished: finished([[300, 60], [200, 60], [400, 60]]) }).planActualRatio).toBe(2);
});
