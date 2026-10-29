import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { LocaleProvider } from "../locale-context";
import { minuteLabel, scatterMargins } from "./chart-geometry";
import { PlanActions, ScheduleStatus, type PlanVersionData } from "./plan-view";
import { RankingTable } from "./ranking-table";
import { evidenceLine } from "./plan-controls";
import { PlanKpiRow, UnplacedCard } from "./plan-head";
import type { RankedTask } from "../../lib/crossline";

const plan: PlanVersionData = { id: "plan-7", version: 7, blocks: [{ id: "scheduled:w1:v1s1", lane: "human", title: "Read", start: "09:00", end: "10:00", source: "排程", readOnly: false }] };
const task = (over: Partial<RankedTask>): RankedTask => ({ id: "w1", title: "Problem set 3", line: "research", milestoneId: "m1", tier: 2, weight: 50, deadline: "2026-10-20",
  notBefore: null, firstDay: "2026-10-14", firstStart: "09:00", weekMinutes: 90, blocker: null, libraryUntil: null, p50Minutes: 60, p85Minutes: 90, ...over });

describe("the plan page's geometry in both languages", () => {
  test("minute ticks: Chinese as before, English in English", () => {
    expect([minuteLabel(30), minuteLabel(120)]).toEqual(["30 分", "2 时"]);
    expect([minuteLabel(30, "en"), minuteLabel(120, "en")]).toEqual(["30 min", "2 h"]);
  });

  test("the scatter's margins are measured on the labels it draws in the page's language", () => {
    // 「16 时」 is a CJK character wider than "16 h": the right margin follows the label actually drawn.
    expect(scatterMargins([5, 960], 12, "en").right).toBeLessThan(scatterMargins([5, 960]).right);
  });

  test("the advice's footing in English, with plurals", () => {
    expect(evidenceLine({ nights: 1, reports: 1 }, "en")).toBe("Based on 1 self-report and 1 night of sleep records; thin evidence");
    expect(evidenceLine({ nights: 0, reports: 5 }, "en")).toBe("Based on 5 self-reports and no sleep records; thin evidence");
    expect(evidenceLine({ nights: 8, reports: 5 })).toBe("依据：5 次自评、8 晚睡眠记录");
  });
});

describe("the plan page in English", () => {
  test("the head's actions and the schedule's status", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><PlanActions calendarWrite /><ScheduleStatus plan={{ ...plan,
      schedule: { status: "partial", blockers: [{ taskId: "w2", code: "NO_CAPACITY", message: "" }], solver: "feasible_time_limit" } }} /></LocaleProvider>);
    expect(html).toContain("Sync calendar now");
    expect(html).toContain("Publish to the Crossline calendar");
    expect(html).toContain("Some tasks are not scheduled");
    expect(html).toContain("1 task not scheduled; see &quot;Why it doesn&#x27;t fit&quot;");
    expect(html).not.toMatch(/[一-鿿]/);
  });

  test("the four figures and the unplaced card in English", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en">
      <PlanKpiRow configuredWeekly={39} labels={{ research: "Researcher" }} estimates={{ covered: 0, coverage: null, points: [] }}
        kpis={{ usableMinutes: 2340, scheduledMinutes: 1860, unplaced: { count: 1, minutes: 150, earliest: "2026-11-03" }, bias: null }} />
      <UnplacedCard labels={{ research: "Researcher" }} today="2026-10-28" items={[{ id: "w1", title: "Watchlist", line: "research", deadline: "2026-11-03",
        notBefore: null, minutes: 150, partial: true, reason: null }]} />
    </LocaleProvider>);
    expect(html).toContain("Available this week");
    expect(html).toContain("Not scheduled");
    expect(html).toContain("Earliest due 11/3 · see why");
    expect(html).toContain("Some steps not scheduled");
    expect(html).toContain("Push or drop this week&#x27;s work in the weekly commitment →");
    expect(html).not.toMatch(/[一-鿿]/);
  });

  test("the ordering table: tiers, columns and the library in English", () => {
    const html = renderToStaticMarkup(<RankingTable locale="en" today="2026-10-12" ranking={[task({}), task({ id: "w2", title: "Outline", libraryUntil: "2026-11-02", firstDay: null })]} />);
    expect(html).toContain(">Has a deadline<");
    expect(html).toContain(">Priority tier<");
    expect(html).toContain("1.5 h this week");
    expect(html).toContain("Library · 1 (scheduled once the milestone is due within three weeks)");
    expect(html).toContain("Scheduled from 11/2 · Due 10/20");
    expect(html).not.toMatch(/[一-鿿]/);
  });

});
