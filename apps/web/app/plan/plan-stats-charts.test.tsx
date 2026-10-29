import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CapacityWeek } from "../../lib/plan-stats";
import { CapacityChart, EstimateChart, RhythmMini } from "./plan-stats-charts";
import { LineShareChart, PlanKpiRow, UnplacedCard } from "./plan-head";

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

  test("the four figures: usable, scheduled with its bar, unplaced linked to its reasons, and the estimate bias or 「尚无实测」", () => {
    const html = renderToStaticMarkup(<PlanKpiRow configuredWeekly={39} labels={labels} estimates={{ covered: 0, coverage: null, points: [] }}
      kpis={{ usableMinutes: 2340, scheduledMinutes: 1860, unplaced: { count: 2, minutes: 270, earliest: "2026-11-02" }, bias: null }} />);
    expect(html).toContain("本周可用");
    expect(html).toContain(">39<");
    expect(html).toContain("/ 39 h");
    expect(html).toContain("--pct:79%");
    expect(html).toContain("项 · 4.5 h");
    expect(html).toContain('href="#why"');
    expect(html).toContain("最早截止 11/2 · 看原因");
    expect(html).toContain("尚无实测");
    expect(html).toContain('href="/settings#usage"');
    const timed = renderToStaticMarkup(<PlanKpiRow configuredWeekly={39} labels={labels} estimates={{ covered: 1, coverage: 1, points: [{ id: "a", line: "research", estimate: 40, p85: 60, actual: 50, covered: true }] }}
      kpis={{ usableMinutes: 600, scheduledMinutes: 0, unplaced: { count: 0, minutes: 0, earliest: null }, bias: { percent: 18, samples: 9 } }} />);
    expect(timed).toContain(">+18<");
    expect(timed).toContain("实测 9 次，中位数");
    expect(timed).toContain("全部排进");
  });

  test("排不下的原因: each task with its line, hours, deadline and the planner's reason; its one action is more hours, push or drop is the weekly commitment's", () => {
    const html = renderToStaticMarkup(<UnplacedCard labels={labels} today="2026-10-28" items={[
      { id: "w1", title: "整理关注清单", line: "research", deadline: "2026-11-03", notBefore: null, minutes: 150, partial: false, reason: "截止前的「中」精力时段只剩 1.5h" },
      { id: "w2", title: "可验证假设", line: "media", deadline: null, notBefore: "2026-10-30", minutes: 120, partial: false, reason: null },
      { id: "w3", title: "期中复习", line: "research", deadline: null, notBefore: null, minutes: 60, partial: true, reason: null }]} />);
    expect(html).toContain('id="why"');
    expect(html).toContain('href="/workbench/w1"');
    expect(html).toContain("截止前的「中」精力时段只剩 1.5h");
    expect(html).toContain("10/30 前不可开始");
    expect(html).toContain("部分步骤未排入");
    expect(html).toContain("2.5 h");
    expect(html.match(/href="#time"/g)).toHaveLength(3);
    expect(html).toContain('href="/commit"');
    expect(html).not.toContain("推迟");
    expect(renderToStaticMarkup(<UnplacedCard labels={labels} today="2026-10-28" items={[]} />)).toContain("都排进了可用时段");
  });

  test("lines against their share over the coming weeks only, with the look back linked to the weekly review", () => {
    const html = renderToStaticMarkup(<LineShareChart labels={labels} lineOrder={["research", "media"]} shares={{ research: 50 }}
      capacity={[week(0, { lines: [{ line: "research", scheduled: 240, pending: 60, extra: 0 }, { line: "media", scheduled: 60, pending: 0, extra: 0 }] }), week(1)]} />);
    expect(html).toContain("未来 2 周 · 每周小时");
    // Half of 600 usable minutes a week is 5 hours; 300 planned minutes over two weeks is 2.5 hours a week, 2 of them scheduled.
    expect(html).toContain("份额 50%，约 5 小时/周");
    expect(html).toContain("计划 2.5 小时/周，其中已排 2 小时");
    expect(html).toContain('data-line="media"');
    expect(html).toContain('href="/review"');
    expect(html).not.toContain("实际计时");
  });

  test("estimates: log scatter with the diagonal and coverage; 「尚无实测」 without data", () => {
    const html = renderToStaticMarkup(<EstimateChart labels={labels} estimates={{ covered: 1, coverage: 0.5, points: [
      { id: "a", line: "research", estimate: 40, p85: 60, actual: 50, covered: true }, { id: "b", line: "media", estimate: 30, p85: 45, actual: 80, covered: false }] }} />);
    expect(html).toContain("对角线：实际等于估时");
    expect(html).toContain("1/2");
    expect(html).toContain("保守估时覆盖率");
    expect(renderToStaticMarkup(<EstimateChart labels={labels} estimates={{ covered: 0, coverage: null, points: [] }} />)).toContain("尚无实测");
  });

  test("rhythm: timed minutes per weekday and hour, each hour underlined by the energy the pattern gives it", () => {
    const worked = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    worked[1]![9] = 45;
    const pattern = Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => 0));
    pattern[1]![18] = 3;
    const html = renderToStaticMarkup(<RhythmMini worked={worked} pattern={pattern} title="现状" />);
    expect(html).toContain("周一 9–10 时 · 实际 45 分 · 高精力");
    expect(html).toContain('class="pl-lv" data-level="3"');
    expect(html).toContain(">24</text>");
  });
});
