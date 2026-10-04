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
