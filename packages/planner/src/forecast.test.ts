import { expect, test } from "vitest";
import { forecastGoals, type ForecastDay, type PlannerTask } from "./index";

const days: ForecastDay[] = Array.from({ length: 56 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 8, 18 + index)).toISOString().slice(0, 10),
  netMinutes: 100, source: "declared"
}));
const task = (id: string, milestoneId: string, minutes: number): PlannerTask => ({
  id, title: id, milestoneId, estimate: { p25Minutes: minutes / 2,
    p50Minutes: minutes, p85Minutes: minutes * 2, confidence: "low" },
  inputsReady: true, deadlineTier: 3
});

test("eight-week projection reserves capacity and a new important goal moves another goal's date", () => {
  const later = { id: "later", title: "Later", importance: "important" as const, confirmedDeadline: null };
  const before = forecastGoals([later], [task("later-work", "later", 250)], days);
  const after = forecastGoals([{ id: "urgent", title: "Urgent", importance: "important",
    confirmedDeadline: "2026-09-20" }, later],
  [task("urgent-work", "urgent", 300), task("later-work", "later", 250)], days);
  expect(before.weeks[0]).toMatchObject({ netMinutes: 700, reservedMinutes: 105, usableMinutes: 595 });
  expect(before.weeks[1]).toMatchObject({ netMinutes: 700, reservedMinutes: 140, usableMinutes: 560 });
  expect((after.goals.find((goal) => goal.milestoneId === "later")?.p85Day ?? "")
    > (before.goals[0]?.p85Day ?? "")).toBe(true);
  expect(before.goals[0]?.suggestedTargetDay).toBe(before.goals[0]?.p85Day);
});

test("calendar-adjusted capacity delays a scenario; undated fourth-quadrant work stays held", () => {
  const goal = { id: "g", title: "G", importance: "important" as const, confirmedDeadline: null };
  const baseline = forecastGoals([goal], [task("w", "g", 100)], days);
  const busy = forecastGoals([goal], [task("w", "g", 100)],
    [{ ...days[0]!, netMinutes: 0, source: "calendar_adjusted" }, ...days.slice(1)]);
  expect((busy.goals[0]?.p50Day ?? "") > (baseline.goals[0]?.p50Day ?? "")).toBe(true);
  const q4 = forecastGoals([{ ...goal, importance: "ordinary" }], [task("w", "g", 100)], days);
  expect(q4.goals[0]).toMatchObject({ p50Day: null, p85Day: null,
    bottleneck: "第四象限暂缓；请确认日期或提升重要性" });
});

test("dependency is completed before its dependent even when the dependent goal is more urgent", () => {
  const goals = [
    { id: "base", title: "Base", importance: "important" as const, confirmedDeadline: null },
    { id: "urgent", title: "Urgent", importance: "important" as const, confirmedDeadline: "2026-09-20" }
  ];
  const base = task("base-work", "base", 100);
  const dependent = { ...task("dependent", "urgent", 100), dependsOn: ["base-work"] };
  const forecast = forecastGoals(goals, [dependent, base], days);
  expect((forecast.goals.find((goal) => goal.milestoneId === "urgent")?.p50Day ?? "")
    >= (forecast.goals.find((goal) => goal.milestoneId === "base")?.p50Day ?? "")).toBe(true);
  expect(forecast.goals.find((goal) => goal.milestoneId === "urgent")?.bottleneck)
    .toBe("p85 情景晚于已确认截止时间");
  const blocked = forecastGoals(goals, [dependent], days);
  expect(blocked.goals.find((goal) => goal.milestoneId === "urgent")?.bottleneck)
    .toBe("八周内容量或步骤依赖不足");
});

test("finishing at p85 with no days to spare is flagged: a deadline is met with room left, not on the last day", () => {
  const goal = (confirmedDeadline: string) => [{ id: "g", title: "G", importance: "important" as const, confirmedDeadline }];
  const work = [task("w", "g", 100)];
  const finish = forecastGoals(goal("2026-12-31"), work, days).goals[0]!;
  expect(finish.p85Day).toBeTruthy();
  const wide = forecastGoals(goal("2026-12-31"), work, days).goals[0]!;
  expect(wide.slackDays).toBeGreaterThan(2);
  expect(wide.bottleneck).toBeNull();
  const tight = forecastGoals(goal(finish.p85Day!), work, days).goals[0]!;
  expect(tight.slackDays).toBe(0);
  expect(tight.bottleneck).toContain("没有留出 2 天的余量");
});

const total = (weeks: ReturnType<typeof forecastGoals>["weeks"], field: "p50Minutes" | "p85Minutes" | "p50OverdueMinutes") =>
  weeks.reduce((sum, week) => sum + week.demand.reduce((inner, item) => inner + item[field], 0), 0);

test("each week records the minutes each milestone uses, usual and cautious", () => {
  const goal = { id: "g", title: "G", importance: "important" as const, confirmedDeadline: null };
  const forecast = forecastGoals([goal], [task("w", "g", 250)], days);
  expect(forecast.weeks).toHaveLength(8);
  expect(forecast.weeks[0]!.demand).toEqual([{ milestoneId: "g", p50Minutes: 250, p85Minutes: 500, p50OverdueMinutes: 0, p85OverdueMinutes: 0 }]);
  expect(forecast.weeks[1]!.demand).toEqual([]);
  // A cautious run that spills into the next week records it there.
  const long = forecastGoals([goal], [task("w", "g", 400)], days);
  expect(long.weeks[0]!.demand[0]).toMatchObject({ p50Minutes: 400, p85Minutes: 595 });
  expect(long.weeks[1]!.demand[0]).toMatchObject({ p50Minutes: 0, p85Minutes: 205 });
});

test("work done after its deadline, or not done at all, counts in the deadline's week, so that week can exceed its usable minutes", () => {
  const goal = { id: "g", title: "G", importance: "important" as const, confirmedDeadline: "2026-09-20" };
  const late = forecastGoals([goal], [task("w", "g", 300)], days);
  // 85 + 85 + 85 by 09-20; the last 45 minutes land on 09-21 and are charged back to the first week as overdue.
  expect(late.weeks[0]!.demand[0]).toMatchObject({ p50Minutes: 300, p50OverdueMinutes: 45 });
  expect(total(late.weeks, "p50Minutes")).toBe(300);

  const huge = forecastGoals([{ ...goal, confirmedDeadline: "2026-09-28" }], [task("w", "g", 10_000)], days);
  // Every minute is accounted for once: what fits before the deadline in its own week, everything else in the deadline's week.
  expect(total(huge.weeks, "p50Minutes")).toBe(10_000);
  const second = huge.weeks[1]!;
  expect(second.demand[0]!.p50Minutes).toBeGreaterThan(second.usableMinutes);
  expect(second.demand[0]!.p50OverdueMinutes).toBe(10_000 - 595 - 4 * 80);
  expect(huge.weeks.slice(2).every((week) => week.demand.length === 0)).toBe(true);
});

test("undone work with no deadline in the horizon is only later, not overdue; held-back work uses nothing", () => {
  const undated = { id: "g", title: "G", importance: "important" as const, confirmedDeadline: null };
  const forecast = forecastGoals([undated], [task("w", "g", 10_000)], days);
  expect(total(forecast.weeks, "p50Minutes")).toBe(595 + 49 * 80);
  expect(total(forecast.weeks, "p50OverdueMinutes")).toBe(0);
  const beyond = forecastGoals([{ ...undated, confirmedDeadline: "2027-03-01" }], [task("w", "g", 10_000)], days);
  expect(total(beyond.weeks, "p50OverdueMinutes")).toBe(0);
  const held = forecastGoals([{ ...undated, importance: "ordinary" }], [task("w", "g", 100)], days);
  expect(held.weeks.every((week) => week.demand.length === 0)).toBe(true);
});

test("the horizon follows the days given: four weeks, or up to six months", () => {
  const goal = { id: "g", title: "G", importance: "important" as const, confirmedDeadline: null };
  const four = forecastGoals([goal], [task("w", "g", 10_000)], days.slice(0, 28));
  expect(four.weeks).toHaveLength(4);
  expect(four.goals[0]!.bottleneck).toBe("4 周内容量或步骤依赖不足");
  const longer = Array.from({ length: 182 }, (_, index) => ({ day: new Date(Date.UTC(2026, 8, 18 + index)).toISOString().slice(0, 10),
    netMinutes: 100, source: "declared" as const }));
  const half = forecastGoals([goal], [task("w", "g", 10_000)], longer);
  expect(half.weeks).toHaveLength(26);
  expect(half.goals[0]!.p50Day).toBeTruthy();
});
