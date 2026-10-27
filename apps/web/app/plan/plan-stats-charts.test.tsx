import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CapacityWeek, GoalRow, Investment } from "../../lib/plan-stats";
import { CapacityChart, EstimateChart, InvestmentChart, MilestoneTimeline, RhythmMini } from "./plan-stats-charts";

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

  test("milestone timeline: one axis per line, each mark opens its milestone and carries its state; several states make a split square", () => {
    const row = (extra: Partial<GoalRow>): GoalRow => ({ id: "m", title: "里程碑", line: "research", p50Day: null, p85Day: null, deadline: null, slackDays: null, atRisk: false,
      remainingP50Minutes: 0, remainingP85Minutes: 0, libraryDay: null, status: "no_tasks", bottleneck: null, proposals: 0, ...extra });
    const rows = [
      row({ id: "a", title: "期中考试", p50Day: "2026-10-20", p85Day: "2026-10-24", deadline: "2026-10-25", slackDays: 1, atRisk: true, remainingP50Minutes: 600, remainingP85Minutes: 900, status: "forecast" }),
      row({ id: "b", title: "论文投稿", deadline: "2027-02-01", libraryDay: "2026-11-02", remainingP50Minutes: 1200, status: "unfinished", bottleneck: "八周内容量或步骤依赖不足" }),
      row({ id: "c", title: "首期视频", line: "media" }),
      row({ id: "d", title: "导师评审", proposals: 1, deadline: "2026-11-20" })
    ];
    const html = renderToStaticMarkup(<MilestoneTimeline today="2026-10-10" weeks={26} spanDays={182} labels={labels} lineOrder={["research", "media"]} rows={rows} />);
    // The server render draws the wide axis (the measured width starts wide); full names are on the marks.
    for (const title of ["期中考试", "论文投稿", "导师评审"]) expect(html).toContain(`>${title}</text>`);
    // Undated milestones are counted, not drawn.
    expect(html).not.toContain("首期视频");
    expect(html).toContain('href="/milestones?open=a"');
    expect(html).toContain('data-deadline="2026-10-25"');
    expect(html).toContain('data-states="risk"');
    expect(html).toContain('data-states="risk library"');
    expect(html).toContain("pl-ms-combo");
    expect(html).toContain('data-states="unprepared"');
    expect(html).toContain("1 项提案待批准");
    expect(html).toContain("2026年11月");
    expect(html).toContain("2027年1月");
    expect(html).toContain("范围内未完成 3 个 · 范围外或已完成 1 个 · 有完不成风险 2 · 待准备 1");
  });

  test("milestone timeline: only the horizon's unfinished and the overdue are drawn; a line keeps three rows of names and counts the rest", () => {
    const row = (id: string, deadline: string): GoalRow => ({ id, title: `里程碑名称很长的一项第${id}号`, line: "research", p50Day: null, p85Day: null, deadline, slackDays: 5,
      atRisk: false, remainingP50Minutes: 60, remainingP85Minutes: 90, libraryDay: null, status: "forecast", bottleneck: null, proposals: 0 });
    const crowded = ["a", "b", "c", "d", "e", "f"].map((id, index) => row(id, `2026-10-${String(20 + index).padStart(2, "0")}`));
    const html = renderToStaticMarkup(<MilestoneTimeline today="2026-10-10" weeks={8} spanDays={56} labels={labels} lineOrder={["research"]}
      rows={[...crowded, row("late", "2027-03-01"), row("overdue", "2026-10-01"), row("done", "2026-10-15")]} done={["done"]} />);
    // Six markers a day apart stack as a staircase in three lanes, a name cut short where the next leader rises; the overdue one at the
    // left edge shares a lane; the three left without a name are counted, and the late and the done ones are counted apart.
    expect(html.match(/class="pl-ms-label"/g)!.length).toBe(4);
    expect(html.match(/class="pl-ms-point"/g)!.length).toBe(7);
    expect(html).toContain(">+3<");
    expect(html).toContain("另有 3 个里程碑未标名称");
    // The strip above the axis says how to read a name in full.
    expect(html).toContain("指向或聚焦圆点，这里显示里程碑全名");
    expect(html).toContain("范围内未完成 7 个 · 范围外或已完成 2 个");
    expect(html).not.toContain("open=late");
  });

  test("planned against timed: a histogram per line with planned, timed and next-seven-days bars; 「尚无实测」 when nothing is recorded", () => {
    const data: Investment = { weeks: [0, 1, 2, 3].map((index) => ({ start: `2026-09-${13 + index * 7}`, end: `2026-09-${19 + index * 7}`, recordedDays: index === 3 ? 2 : 0,
      planned: index === 3 ? { research: 240 } : {}, actual: index === 3 ? { research: 180, media: 60 } : {} })),
      next7: { research: 300 }, hasActual: true, hasPlanned: true,
      lines: [{ line: "research", stated: 60, actualShare: 75, plannedShare: 100 }, { line: "media", stated: 40, actualShare: 25, plannedShare: 0 }] };
    const html = renderToStaticMarkup(<InvestmentChart data={data} labels={labels} />);
    expect(html).toContain("科研");
    expect(html).toContain("所述 60%");
    // 240 planned minutes over 2 recorded days is 14 hours a week; 180 timed over four weeks is 0.75 hours a week.
    expect(html).toContain("科研 · 计划 14 h/周（按有记录的 2 天折算） · 所述 60% · 实际 75% · 计划 100%");
    expect(html).toContain("科研 · 实际计时 0.8 h/周（近 4 周平均）");
    expect(html).toContain("科研 · 未来 7 天计划 5 h");
    expect(html).toContain("pl-bar-planned");
    expect(html).toContain("pl-bar-actual");
    // The top tick's label (12px, centred on its grid line) stays clear of the unit 「h/周」, whose baseline is at 10.
    const gridTops = [...html.matchAll(/<line x1="[\d.]+" x2="[\d.]+" y1="([\d.]+)"[^>]*class="pl-grid-line"/g)].map((match) => Number(match[1]));
    expect(gridTops.length).toBeGreaterThan(1);
    expect(Math.min(...gridTops) - 6).toBeGreaterThanOrEqual(10 + 3 + 2);
    const empty = renderToStaticMarkup(<InvestmentChart labels={labels} data={{ weeks: [], next7: {}, hasActual: false, hasPlanned: false, lines: [] }} />);
    expect(empty).toContain("尚无实测");
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
