import { expect, test } from "vitest";
import type { ForecastResult } from "@crossline/planner";
import { forecastDiff } from "./forecast-diff";

const baseline: ForecastResult = { weeks: [{ week: 1, netMinutes: 700, reservedMinutes: 105, usableMinutes: 595 }],
  goals: [{ milestoneId: "a", title: "原目标", p50Day: "2026-09-20", p85Day: "2026-09-25",
    suggestedTargetDay: "2026-09-25", confirmedDeadline: null, bottleneck: null,
    p50Minutes: 100, p85Minutes: 200 }] };

test("a new goal and changed real capacity show differences against the last viewed forecast", () => {
  const changed: ForecastResult = { weeks: [{ week: 1, netMinutes: 600,
    reservedMinutes: 90, usableMinutes: 510 }], goals: [
    { ...baseline.goals[0]!, p85Day: "2026-09-27" },
    { ...baseline.goals[0]!, milestoneId: "b", title: "新目标" }
  ] };
  expect(forecastDiff(baseline, changed)).toEqual([
    "「原目标」p85 情景 2026-09-25 → 2026-09-27",
    "新增目标「新目标」",
    "第 1 周净可用时间 700 → 600 分钟"
  ]);
});
