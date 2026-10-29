import { describe, expect, test } from "vitest";
import { hoursFromText } from "@crossline/core";
import type { ForecastWeek } from "@crossline/planner";
import { availabilityGrid, capacityWeeks, estimatePoints, goalRows, horizonFor, investment, lineShareRows, milestoneMarks, milestoneSummary, planKpis, rhythmGrid, statedShares,
  timelineMarks, unplacedItems, workedMinutes, type CapacityWeek, type GoalRow, type RankedLike } from "./plan-stats";

describe("horizon", () => {
  test("eight weeks by default, four on request, and 「到最远截止」 rounded up to whole weeks and capped at six months", () => {
    expect(horizonFor(undefined, "2026-10-10", [])).toMatchObject({ choice: "8", days: 56, weeks: 8, farthest: null });
    expect(horizonFor("4", "2026-10-10", ["2026-12-01"])).toMatchObject({ choice: "4", days: 28, farthest: "2026-12-01" });
    // 10/10 → 12/01 is 53 days inclusive: eight weeks.
    expect(horizonFor("far", "2026-10-10", ["2026-11-01", "2026-12-01", "2026-09-01"])).toMatchObject({ choice: "far", days: 56, weeks: 8, capped: false });
    expect(horizonFor("far", "2026-10-10", ["2027-09-01"])).toMatchObject({ days: 182, weeks: 26, capped: true });
    // A deadline within a few days still shows a whole week.
    expect(horizonFor("far", "2026-10-10", ["2026-10-12"])).toMatchObject({ days: 7, weeks: 1 });
  });

  test("without a future deadline 「到最远截止」 falls back to eight weeks", () => {
    expect(horizonFor("far", "2026-10-10", ["2026-09-01", null])).toMatchObject({ choice: "8", days: 56, farthest: null });
  });
});

const week = (index: number, usable: number, demand: ForecastWeek["demand"]): ForecastWeek =>
  ({ week: index + 1, netMinutes: Math.round(usable / 0.8), reservedMinutes: 0, usableMinutes: usable, demand });

describe("capacity and demand", () => {
  test("demand is stacked by line, blocks already placed are told apart, and the cautious extra and the overload are counted", () => {
    const weeks = capacityWeeks({ today: "2026-10-10", lineOrder: ["research", "media"],
      lineOf: { m1: "research", m2: "media", m3: "research" }, titleOf: { m1: "论文初稿", m2: "首期视频", m3: "组会报告" },
      weeks: [week(0, 600, [
        { milestoneId: "m1", p50Minutes: 400, p85Minutes: 520, p50OverdueMinutes: 60, p85OverdueMinutes: 60 },
        { milestoneId: "m2", p50Minutes: 300, p85Minutes: 300, p50OverdueMinutes: 0, p85OverdueMinutes: 0 },
        { milestoneId: "m3", p50Minutes: 100, p85Minutes: 200, p50OverdueMinutes: 0, p85OverdueMinutes: 0 }
      ]), week(1, 600, [])],
      scheduled: [{ day: "2026-10-11", line: "research", minutes: 120 }, { day: "2026-10-12", line: "media", minutes: 500 }, { day: "2026-10-20", line: "media", minutes: 90 }] });
    expect(weeks[0]).toMatchObject({ start: "2026-10-10", end: "2026-10-16", usableMinutes: 600, overdueMinutes: 60,
      top: { milestoneId: "m1", title: "论文初稿", minutes: 400 } });
    expect(weeks[0]!.lines).toEqual([
      { line: "research", scheduled: 120, pending: 380, extra: 220 },
      // More placed than the forecast followed: the bar is never drawn below the blocks that exist.
      { line: "media", scheduled: 500, pending: 0, extra: 0 }
    ]);
    expect(weeks[0]).toMatchObject({ totalP50: 1000, totalP85: 1220, overloadMinutes: 400, overloadP85Minutes: 620 });
    // The second week has only a block, no forecast demand.
    expect(weeks[1]!.lines).toEqual([{ line: "media", scheduled: 90, pending: 0, extra: 0 }]);
    expect(weeks[1]).toMatchObject({ overloadMinutes: 0, top: null, start: "2026-10-17" });
  });
});

describe("milestone rows", () => {
  test("grouped by line order then deadline, with risk, the earliest library day and why a row has no range", () => {
    const goal = (id: string, extra: Partial<Parameters<typeof goalRows>[0]["goals"][number]>) => ({ milestoneId: id, title: id, p50Day: null, p85Day: null,
      suggestedTargetDay: null, confirmedDeadline: null, bottleneck: null, slackDays: null, p50Minutes: 0, p85Minutes: 0, ...extra });
    const rows = goalRows({ lineOrder: ["research", "media"], marginDays: 2, lineOf: { a: "media", b: "research", c: "research", d: "research", e: "media" },
      unforecast: new Set(["e"]),
      library: [{ milestoneId: "b", libraryUntil: "2026-11-02" }, { milestoneId: "b", libraryUntil: "2026-10-30" }, { milestoneId: "c", libraryUntil: null }],
      goals: [
        goal("a", { p50Day: "2026-10-20", p85Day: "2026-10-25", confirmedDeadline: "2026-10-26", slackDays: 1, p50Minutes: 300, p85Minutes: 500 }),
        goal("b", { p50Day: "2026-11-10", p85Day: "2026-11-15", confirmedDeadline: "2026-11-30", slackDays: 15, p50Minutes: 600, p85Minutes: 900 }),
        goal("c", { confirmedDeadline: "2026-11-01" }),
        goal("d", { confirmedDeadline: "2026-10-20", p50Minutes: 900, p85Minutes: 1500, bottleneck: "八周内容量或步骤依赖不足" }),
        goal("e", { p50Minutes: 120, p85Minutes: 200 })
      ] });
    expect(rows.map((row) => row.id)).toEqual(["d", "c", "b", "a", "e"]);
    expect(rows.find((row) => row.id === "a")).toMatchObject({ atRisk: true, status: "forecast", line: "media" });
    expect(rows.find((row) => row.id === "b")).toMatchObject({ atRisk: false, libraryDay: "2026-10-30", remainingP50Minutes: 600 });
    expect(rows.find((row) => row.id === "c")).toMatchObject({ status: "no_tasks", libraryDay: null });
    expect(rows.find((row) => row.id === "d")).toMatchObject({ status: "unfinished" });
    expect(rows.find((row) => row.id === "e")).toMatchObject({ status: "unforecast" });
  });
});

describe("planned against timed hours", () => {
  test("an order filed under something that is not one of the person's lines does not become a line of its own", () => {
    const result = investment({ today: "2026-10-10", zone: "America/Chicago", now: "2026-10-10T20:00:00Z", lineOrder: ["research"],
      orderLine: { w1: "research", bad: "\\" }, plannedByDay: { "2026-10-10": { w1: 60, bad: 30 } },
      executions: [{ workOrderId: "bad", startedAt: "2026-10-09T14:00:00Z", endedAt: "2026-10-09T15:00:00Z", pauseMinutes: 0 }], next7: {}, stated: null });
    expect(result.lines.map((line) => line.line)).toEqual(["research"]);
  });

  test("four weeks ending today, planned from the recorded day lengths and actual from the timer, with each line's shares", () => {
    const result = investment({ today: "2026-10-10", zone: "America/Chicago", now: "2026-10-10T20:00:00Z", lineOrder: ["research", "media", "startup"],
      orderLine: { w1: "research", w2: "media" },
      plannedByDay: { "2026-10-10": { w1: 120, w2: 60 }, "2026-10-04": { w1: 90 }, "2026-10-03": { w2: 30 }, "2026-09-20": null, "2026-09-12": { w1: 999 } },
      executions: [
        { workOrderId: "w1", startedAt: "2026-10-09T14:00:00Z", endedAt: "2026-10-09T16:00:00Z", pauseMinutes: 30 },
        // 01:00 UTC on 10/04 is still 10/03 in Chicago: the week is read in the person's zone.
        { workOrderId: "w2", startedAt: "2026-10-04T01:00:00Z", endedAt: "2026-10-04T02:00:00Z", pauseMinutes: 0 },
        { workOrderId: "w1", startedAt: "2026-10-10T19:00:00Z", pauseMinutes: 10 },
        { workOrderId: "unknown", startedAt: "2026-10-09T14:00:00Z", endedAt: "2026-10-09T15:00:00Z", pauseMinutes: 0 }
      ],
      next7: { research: 300 }, stated: { research: 60, media: 40 } });
    expect(result.weeks.map((week) => `${week.start}..${week.end}`)).toEqual(["2026-09-13..2026-09-19", "2026-09-20..2026-09-26", "2026-09-27..2026-10-03", "2026-10-04..2026-10-10"]);
    const [first, second, third, last] = result.weeks;
    expect(first).toMatchObject({ recordedDays: 0, planned: {}, actual: {} });
    // A day with no recorded lengths is not counted as a day planned at zero.
    expect(second).toMatchObject({ recordedDays: 0 });
    expect(third).toMatchObject({ recordedDays: 1, planned: { media: 30 }, actual: { media: 60 } });
    expect(last).toMatchObject({ recordedDays: 2, planned: { research: 210, media: 60 }, actual: { research: 90 + 50 } });
    expect(result.lines).toEqual([
      { line: "research", stated: 60, actualShare: 70, plannedShare: 70 },
      { line: "media", stated: 40, actualShare: 30, plannedShare: 30 },
      { line: "startup", stated: 0, actualShare: 0, plannedShare: 0 }
    ]);
    expect(result).toMatchObject({ hasActual: true, hasPlanned: true, next7: { research: 300 } });
  });

  test("a running timer counts to now, less its pauses", () => {
    expect(workedMinutes({ workOrderId: "w", startedAt: "2026-10-10T10:00:00Z", pauseMinutes: 15 }, "2026-10-10T11:00:00Z")).toBe(45);
  });

  test("stated shares come from the portrait when it has them, else from each line's own weekly hours, never from a total", () => {
    expect(statedShares([{ lineId: "research", share: 50 }, { lineId: "media", share: 30 }, { lineId: "startup" }], [], hoursFromText))
      .toEqual({ research: 63, media: 38 });
    expect(statedShares(null, [
      { identityId: "research", slot: "weekly_hours", status: "confirmed", value: "每周约 15 小时" },
      { identityId: "media", slot: "weekly_hours", status: "confirmed", value: "每周 5 小时" },
      { identityId: "media", slot: "weekly_hours", status: "inferred", value: "每周 50 小时" },
      { identityId: "startup", slot: "weekly_hours", status: "confirmed", value: "所有事情合计每周约 72 小时" }
    ], hoursFromText)).toEqual({ research: 75, media: 25 });
    expect(statedShares(null, [], hoursFromText)).toBeNull();
  });
});

describe("estimates and rhythm", () => {
  test("the estimate is the analysis's own when there is one, the cautious one's coverage is counted, abandoned work is left out", () => {
    const base = { identityId: "research", censored: false, baselineP50Minutes: 30, baselineP85Minutes: 45 };
    const result = estimatePoints([
      { ...base, id: "a", observedMinutes: 50, llmP50Minutes: 40, llmP85Minutes: 60 },
      { ...base, id: "b", observedMinutes: 80, llmP50Minutes: null, llmP85Minutes: null },
      { ...base, id: "c", observedMinutes: 20, llmP50Minutes: 40, llmP85Minutes: 60, censored: true },
      { ...base, id: "d", observedMinutes: 0, llmP50Minutes: 40, llmP85Minutes: 60 }
    ]);
    expect(result.points).toEqual([
      { id: "a", line: "research", estimate: 40, p85: 60, actual: 50, covered: true },
      { id: "b", line: "research", estimate: 30, p85: 45, actual: 80, covered: false }
    ]);
    expect(result).toMatchObject({ covered: 1, coverage: 0.5 });
    expect(estimatePoints([]).coverage).toBeNull();
  });

  test("worked minutes land on the weekday and hour of the person's zone, with pauses cut out", () => {
    // Monday 10/05 08:30–10:00 in Chicago (13:30–15:00 UTC), paused 09:00–09:20.
    const grid = rhythmGrid([{ workOrderId: "w", startedAt: "2026-10-05T13:30:00Z", endedAt: "2026-10-05T15:00:00Z", pauseMinutes: 20,
      interruptions: [{ pausedAt: "2026-10-05T14:00:00Z", resumedAt: "2026-10-05T14:20:00Z" }] }], "America/Chicago", "2026-10-10T00:00:00Z");
    expect(grid[1]![8]).toBe(30);
    expect(grid[1]![9]).toBe(40);
    expect(grid.flat().reduce((sum, value) => sum + value, 0)).toBe(70);
  });

  test("availability on the same grid: the covered share of each hour", () => {
    const grid = availabilityGrid([{ days: [1, 3], start: "09:30", end: "11:00", energy: "high" }]);
    expect(grid[1]![9]).toBe(0.5);
    expect(grid[1]![10]).toBe(1);
    expect(grid[3]![10]).toBe(1);
    expect(grid[2]![10]).toBe(0);
  });
});

describe("milestone marks for the timeline", () => {
  const row = (extra: Partial<GoalRow>): GoalRow => ({ id: "m", title: "里程碑", line: "research", p50Day: null, p85Day: null, deadline: null, slackDays: null, atRisk: false,
    remainingP50Minutes: 0, remainingP85Minutes: 0, libraryDay: null, status: "forecast", bottleneck: null, proposals: 0, ...extra });
  test("states: at risk, not ready, waiting in the library — several at once; placed at the deadline, else the cautious finish", () => {
    const marks = milestoneMarks([
      row({ id: "a", deadline: "2026-11-01", p85Day: "2026-11-03", atRisk: true, libraryDay: "2026-10-20" }),
      row({ id: "b", status: "no_tasks" }),
      row({ id: "c", p50Day: "2026-10-30", p85Day: "2026-11-05" }),
      row({ id: "d", status: "unfinished", p50Day: "2026-12-01", libraryDay: "2026-10-01" })
    ], "2026-10-10");
    expect(marks.map((mark) => [mark.id, mark.day, mark.states])).toEqual([
      ["a", "2026-11-01", ["risk", "library"]], ["b", null, ["unprepared"]], ["c", "2026-11-05", []], ["d", "2026-12-01", ["risk"]]]);
    const { shown, outside } = timelineMarks(marks, "2026-10-10", 28, new Set(["c"]));
    expect(shown.map((mark) => mark.id)).toEqual(["a"]);
    expect(outside).toBe(3);
    // The plan page's one line: what falls in the horizon, and which of it is in trouble.
    const summary = milestoneSummary([row({ id: "a", title: "投稿", deadline: "2026-11-01", atRisk: true }), row({ id: "b", deadline: "2026-10-20", status: "no_tasks" }),
      row({ id: "c", deadline: "2027-03-01" })], "2026-10-10", 56, new Set());
    expect([summary.shown, summary.outside, summary.risk.map((mark) => mark.title), summary.unprepared]).toEqual([2, 1, ["投稿"], 1]);
  });
});

describe("the plan page's head", () => {
  const ranked = (over: Partial<RankedLike>): RankedLike => ({ id: "t", title: "任务", line: "research", deadline: null, notBefore: null, firstDay: "2026-10-12",
    blocker: null, libraryUntil: null, p50Minutes: 60, ...over });
  const week = (lines: Array<[string, number, number]>, usable = 600): CapacityWeek => ({ week: 1, start: "2026-10-10", end: "2026-10-16", netMinutes: usable,
    usableMinutes: usable, lines: lines.map(([line, scheduled, pending]) => ({ line, scheduled, pending, extra: 0 })), totalP50: 0, totalP85: 0,
    overloadMinutes: 0, overloadP85Minutes: 0, overdueMinutes: 0, top: null });

  test("unplaced: with no block, or with a step the planner could not place; never library work; soonest deadline first", () => {
    const items = unplacedItems([ranked({ id: "placed" }), ranked({ id: "none", title: "整理关注清单", firstDay: null, deadline: "2026-11-03", blocker: "可用时段不足" }),
      ranked({ id: "part", title: "可验证假设", deadline: "2026-11-02" }), ranked({ id: "lib", firstDay: null, libraryUntil: "2026-11-20" })], new Set(["part"]));
    expect(items.map((item) => [item.id, item.partial, item.reason])).toEqual([["part", true, null], ["none", false, "可用时段不足"]]);
  });

  test("the four figures: this week's usable and scheduled minutes, the unplaced count with its earliest deadline, and the median estimate bias", () => {
    const kpis = planKpis({ capacity: [week([["research", 120, 60], ["media", 30, 0]])],
      unplaced: [{ id: "a", title: "", line: "research", deadline: "2026-11-03", notBefore: null, minutes: 90, partial: false, reason: null },
        { id: "b", title: "", line: "media", deadline: null, notBefore: null, minutes: 30, partial: true, reason: null }],
      estimates: [{ id: "1", line: "research", estimate: 60, p85: 90, actual: 60, covered: true }, { id: "2", line: "research", estimate: 60, p85: 90, actual: 90, covered: true },
        { id: "3", line: "research", estimate: 30, p85: 45, actual: 60, covered: false }] });
    expect(kpis).toEqual({ usableMinutes: 600, scheduledMinutes: 150, unplaced: { count: 2, minutes: 120, earliest: "2026-11-03" }, bias: { percent: 50, samples: 3 } });
    expect(planKpis({ capacity: [], unplaced: [], estimates: [] }).bias).toBeNull();
  });

  test("lines against their share: the share of the coming weeks' usable hours beside the work planned, with the pre-preview figure", () => {
    const rows = lineShareRows({ capacity: [week([["research", 300, 60]]), week([["research", 0, 240], ["media", 60, 0]])], shares: { research: 50, investment: 10 },
      lineOrder: ["research", "media", "investment", "startup"], before: [week([["research", 300, 0]]), week([])] });
    expect(rows.map((row) => [row.line, row.shareMinutes, row.plannedMinutes, row.scheduledMinutes, row.beforeMinutes])).toEqual([
      ["research", 300, 300, 150, 150], ["media", 0, 30, 30, 0], ["investment", 60, 0, 0, 0]]);
  });
});
