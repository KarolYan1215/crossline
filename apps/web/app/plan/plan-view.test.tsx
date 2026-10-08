import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PlanView, type CalendarData, type PlanVersionData } from "./plan-view";

const plan: PlanVersionData = {
  id: "plan-7",
  version: 7,
  status: "draft",
  blocks: [
    { id: "fixed-1", lane: "human", title: "组会", start: "09:00", end: "10:00", source: "UW Outlook", readOnly: true },
    { id: "ai-1", lane: "ai", title: "整理组会材料", start: "08:15", end: "08:50", source: "Codex", readOnly: false }
  ],
  changes: [{ id: "change-1", kind: "add", explanation: "为组会准备材料", afterBlockId: "ai-1", status: "pending" }]
};
const calendar: CalendarData = {
  today: "2026-09-15", nowIso: "2026-09-15T15:00:00.000Z", timeZone: "America/Chicago", labels: { research: "科研" }, quietByWeekday: {},
  items: [{ id: "fixed-1", title: "组会", day: "2026-09-15", start: "09:00", end: "10:00", kind: "calendar", source: "UW Outlook", readOnly: true }],
  deadlines: []
};

describe("PlanView", () => {
  test("one plan version, one calendar with day, week and month, and the decisions folded under it", () => {
    const html = renderToStaticMarkup(<PlanView plan={plan} calendar={calendar} />);
    expect(html).toContain('data-plan-version="plan-7"');
    for (const view of [">日<", ">周<", ">月<"]) expect(html).toContain(view);
    expect(html).toContain("组会");
    expect(html).toContain("1 项差异待处理");
    expect(html).toContain("为组会准备材料");
    // A pending difference opens the fold, so what needs a decision is visible without a click.
    expect(html).toContain('<details class="plan-changes" id="plan-changes" open=""');
  });

  test("with nothing to decide the differences stay folded", () => {
    const html = renderToStaticMarkup(<PlanView plan={{ ...plan, changes: [] }} calendar={calendar} />);
    expect(html).not.toContain("差异待处理");
    expect(html).not.toContain('id="plan-changes" open');
  });

  test("an approved plan says so and offers no approve button", () => {
    const html = renderToStaticMarkup(<PlanView plan={{ ...plan, status: "approved", changes: [] }} calendar={calendar} />);
    expect(html).toContain("本版本已批准");
    expect(html).not.toContain("批准本批变更");
  });

  test("what the scheduler could not place is counted, with a link to the reasons under 「为什么这样排」", () => {
    const html = renderToStaticMarkup(<PlanView plan={{ ...plan, status: "approved",
      schedule: { status: "partial", blockers: [{ taskId: "w2", code: "NO_CAPACITY", message: "复核数据没有可用容量" }], solver: "feasible_time_limit" }
    }} calendar={calendar} />);
    expect(html).toContain("部分任务未排入");
    expect(html).toContain("1 项未排入，原因见「为什么这样排」");
    expect(html).toContain("未证明最优");
  });
});
