import { expect, test } from "vitest";
import type { ForecastResult } from "@crossline/planner";
import { forecastDiff } from "./forecast-diff";

const baseline: ForecastResult = { weeks: [{ week: 1, netMinutes: 700, reservedMinutes: 105, usableMinutes: 595, demand: [] }],
  goals: [{ milestoneId: "a", title: "原目标", p50Day: "2026-09-20", p85Day: "2026-09-25",
    suggestedTargetDay: "2026-09-25", confirmedDeadline: null, bottleneck: null, slackDays: null,
    p50Minutes: 100, p85Minutes: 200 }] };

test("a new goal and changed real capacity show differences against the last viewed forecast", () => {
  const changed: ForecastResult = { weeks: [{ week: 1, netMinutes: 600,
    reservedMinutes: 90, usableMinutes: 510, demand: [] }], goals: [
    { ...baseline.goals[0]!, p85Day: "2026-09-27" },
    { ...baseline.goals[0]!, milestoneId: "b", title: "新目标" }
  ] };
  expect(forecastDiff(baseline, changed)).toEqual([
    "「原目标」保守完成日 2026-09-25 → 2026-09-27",
    "新增里程碑「新目标」",
    "第 1 周净可用时间 11.7 小时 → 10 小时"
  ]);
});

// 2026-10-15 walkthrough: approving fifteen drafts listed fifteen 「新增里程碑」 lines and eight weeks of 「3330 → 4770 分钟」.
test("many new milestones are one line, the same change in every week is one line, and the list is short", () => {
  const goals = Array.from({ length: 15 }, (_, index) => ({ ...baseline.goals[0]!, milestoneId: `m${index}`, title: `目标 ${index}` }));
  const weeks = (net: number) => Array.from({ length: 8 }, (_, index) => ({ week: index + 1, netMinutes: net }));
  expect(forecastDiff({ goals: [], weeks: weeks(3330) }, { goals, weeks: weeks(4770) })).toEqual(["新增 15 个里程碑", "每周净可用时间 增加 24 小时（共 8 周）"]);
});
