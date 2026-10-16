import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { LocaleProvider } from "../locale-context";
import { minuteLabel, monthTicks, scatterMargins } from "./chart-geometry";
import { PlanView, type PlanVersionData } from "./plan-view";
import { RankingTable } from "./ranking-table";
import { evidenceLine, LongTermGoals } from "./plan-controls";
import type { RankedTask } from "../../lib/crossline";

const plan: PlanVersionData = { id: "plan-7", version: 7, blocks: [{ id: "scheduled:w1:v1s1", lane: "human", title: "Read", start: "09:00", end: "10:00", source: "排程", readOnly: false }] };
const task = (over: Partial<RankedTask>): RankedTask => ({ id: "w1", title: "Problem set 3", line: "research", milestoneId: "m1", tier: 2, weight: 50, deadline: "2026-10-20",
  notBefore: null, firstDay: "2026-10-14", firstStart: "09:00", weekMinutes: 90, blocker: null, libraryUntil: null, p50Minutes: 60, p85Minutes: 90, ...over });

describe("the plan page's geometry in both languages", () => {
  test("minute ticks and month ticks: Chinese as before, English in English", () => {
    expect([minuteLabel(30), minuteLabel(120)]).toEqual(["30 分", "2 时"]);
    expect([minuteLabel(30, "en"), minuteLabel(120, "en")]).toEqual(["30 min", "2 h"]);
    expect(monthTicks("2026-10-01", "2027-01-15").map((tick) => tick.label)).toEqual(["2026年10月", "11月", "12月", "2027年1月"]);
    expect(monthTicks("2026-10-01", "2027-01-15", "en").map((tick) => tick.label)).toEqual(["Oct 2026", "Nov", "Dec", "Jan 2027"]);
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
  test("the top row and the schedule's status", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><PlanView plan={{ ...plan,
      schedule: { status: "partial", blockers: [{ taskId: "w2", code: "NO_CAPACITY", message: "" }], solver: "feasible_time_limit" } }} /></LocaleProvider>);
    expect(html).toContain("Sync calendar now");
    expect(html).toContain("Publish to the Crossline calendar");
    expect(html).toContain("Some tasks are not scheduled");
    expect(html).toContain("1 task not scheduled; see &quot;Schedule order&quot; for why");
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

  test("long-term goals: a missing goal and the share in English", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><LongTermGoals goals={[{ line: "research", label: "Researcher", goal: null }]} shares={{ research: 30 }} /></LocaleProvider>);
    expect(html).toContain("Why this order");
    expect(html).toContain("No long-term goal chosen yet");
    expect(html).toContain("Share 30%");
  });
});
