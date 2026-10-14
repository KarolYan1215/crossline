import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CapacityWeek, GoalRow, Investment } from "../../lib/plan-stats";
import { CapacityChart, EstimateRhythm, InvestmentChart, MilestoneForecast } from "./plan-stats-charts";

const labels = { research: "科研", media: "自媒体" };
const week = (index: number, extra: Partial<CapacityWeek> = {}): CapacityWeek => ({ week: index + 1, start: `2026-10-${String(10 + index * 7).padStart(2, "0")}`,
  end: `2026-10-${String(16 + index * 7).padStart(2, "0")}`, netMinutes: 750, usableMinutes: 600, lines: [], totalP50: 0, totalP85: 0,
  overloadMinutes: 0, overloadP85Minutes: 0, overdueMinutes: 0, top: null, ...extra });

describe("plan charts", () => {
  test("capacity and demand: bars by line, the usable line, and an overloaded week labelled with its hours", () => {
    const html = renderToStaticMarkup(<CapacityChart labels={labels} statedWeekly={null} configuredWeekly={39} usingDefault={false} weeks={[
      week(0, { lines: [{ line: "research", scheduled: 120, pending: 600, extra: 120 }, { line: "media", scheduled: 0, pending: 150, extra: 0 }],
        totalP50: 870, totalP85: 990, overloadMinutes: 270, overloadP85Minutes: 390, top: { milestoneId: "m1", title: "论文初稿", minutes: 600 } }),
      week(1)]} />);
    expect(html).toContain('data-scheduled-minutes="120"');
    expect(html).toContain("科研 · 已排 2 h");
    expect(html).toContain("科研 · 待排 10 h");
    expect(html).toContain("科研 · 保守估时多出 2 h");
    expect(html).toContain("超载 4.5 小时");
    expect(html).toContain("可用小时");
    expect(html).not.toContain("各周需求均在可用小时内");
  });

  test("milestone ranges: grouped by line, each row opens its milestone, risk and the library day are drawn", () => {
    const row = (extra: Partial<GoalRow>): GoalRow => ({ id: "m", title: "里程碑", line: "research", p50Day: null, p85Day: null, deadline: null, slackDays: null, atRisk: false,
      remainingP50Minutes: 0, remainingP85Minutes: 0, libraryDay: null, status: "no_tasks", bottleneck: null, proposals: 0, ...extra });
    const html = renderToStaticMarkup(<MilestoneForecast today="2026-10-10" spanDays={56} weeks={8} labels={labels} inferredRegularBlocks={0} rows={[
      row({ id: "a", title: "期中考试", p50Day: "2026-10-20", p85Day: "2026-10-24", deadline: "2026-10-25", slackDays: 1, atRisk: true, remainingP50Minutes: 600, remainingP85Minutes: 900, status: "forecast" }),
      row({ id: "b", title: "论文投稿", deadline: "2027-02-01", libraryDay: "2026-11-02", remainingP50Minutes: 1200, status: "unfinished", bottleneck: "八周内容量或步骤依赖不足" }),
      row({ id: "c", title: "首期视频", line: "media" }),
      row({ id: "d", title: "导师评审", proposals: 1 })
    ]} />);
    // Proposed work waiting for approval is said, not 「尚无任务」.
    expect(html).toContain("1 项提案待批准");
    expect(html).toContain('href="/milestones?open=a"');
    expect(html).toContain('data-risk="true"');
    expect(html).toContain("余量 1 天");
    expect(html).toContain('data-deadline="2026-10-25"');
    // A deadline past the horizon is held at the edge and says so.
    expect(html).toContain('data-clipped="after"');
    expect(html).toContain('data-library="2026-11-02"');
    expect(html).toContain("8 周内未完成");
    expect(html).toContain("尚无任务");
    expect(html).toContain("剩 10 h");
    expect(html.indexOf("科研")).toBeLessThan(html.indexOf("自媒体"));
  });

  test("planned against timed: a row per line with each week's two points, the shares, and 「尚无实测」 when nothing is recorded", () => {
    const data: Investment = { weeks: [0, 1, 2, 3].map((index) => ({ start: `2026-09-${13 + index * 7}`, end: `2026-09-${19 + index * 7}`, recordedDays: index === 3 ? 2 : 0,
      planned: index === 3 ? { research: 240 } : {}, actual: index === 3 ? { research: 180, media: 60 } : {} })),
      next7: { research: 300 }, hasActual: true, hasPlanned: true,
      lines: [{ line: "research", stated: 60, actualShare: 75, plannedShare: 100 }, { line: "media", stated: 40, actualShare: 25, plannedShare: 0 }] };
    const html = renderToStaticMarkup(<InvestmentChart data={data} labels={labels} />);
    expect(html).toContain("科研");
    expect(html).toContain("所述 60%");
    expect(html).toContain("实际 75%");
    expect(html).toContain("计划 4 h（记录 2 天）");
    expect(html).toContain("未来 7 天计划 5 h");
    const empty = renderToStaticMarkup(<InvestmentChart labels={labels} data={{ weeks: [], next7: {}, hasActual: false, hasPlanned: false, lines: [] }} />);
    expect(empty).toContain("尚无实测");
  });

  test("estimates and rhythm: log scatter with the diagonal and coverage, the heatmap over availability; 「尚无实测」 without data", () => {
    const worked = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    worked[1]![9] = 45;
    const available = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    available[1]![9] = 1;
    const html = renderToStaticMarkup(<EstimateRhythm labels={labels} rhythm={{ worked, available }} estimates={{ covered: 1, coverage: 0.5, points: [
      { id: "a", line: "research", estimate: 40, p85: 60, actual: 50, covered: true }, { id: "b", line: "media", estimate: 30, p85: 45, actual: 80, covered: false }] }} />);
    expect(html).toContain("对角线：实际等于估时");
    expect(html).toContain("1/2");
    expect(html).toContain("保守估时覆盖率");
    expect(html).toContain("周一 9–10 时 · 实际 45 分 · 可用时段内");
    expect(html).not.toContain("尚无实测");
    const none = renderToStaticMarkup(<EstimateRhythm labels={labels} rhythm={{ worked: available.map((row) => row.map(() => 0)), available }}
      estimates={{ covered: 0, coverage: null, points: [] }} />);
    expect(none.match(/尚无实测/g)).toHaveLength(2);
  });
});
