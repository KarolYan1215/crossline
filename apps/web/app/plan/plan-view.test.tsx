import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PlanView, type PlanVersionData } from "./plan-view";

const plan: PlanVersionData = {
  id: "plan-7",
  version: 7,
  blocks: [
    { id: "fixed-1", lane: "human", title: "组会", start: "09:00", end: "10:00", source: "UW Outlook", readOnly: true },
    { id: "ai-1", lane: "ai", title: "整理组会材料", start: "08:15", end: "08:50", source: "Codex", readOnly: false }
  ]
};

describe("PlanView", () => {
  test("the top row: reading and writing the calendar and the horizon — no calendar, no version to approve", () => {
    const html = renderToStaticMarkup(<PlanView plan={plan} aside={<span>统计范围</span>} calendarWrite />);
    expect(html).toContain('data-plan-version="plan-7"');
    expect(html).toContain("立即同步日历");
    expect(html).toContain("发布到 Crossline 日历");
    // Without a writer account (the hosted beta) there is no Crossline calendar to publish to (W-20).
    expect(renderToStaticMarkup(<PlanView plan={plan} />)).not.toContain("Crossline 日历");
    expect(html).toContain("统计范围");
    // The calendar lives on Today only (decided 2026-10-10).
    for (const view of [">日<", ">周<", ">月<"]) expect(html).not.toContain(view);
    expect(html).not.toContain("组会</");
    // The plan takes effect by default (docs/loop-and-scout.md §1): nothing to approve, no differences to settle.
    expect(html).not.toContain("批准");
    expect(html).not.toContain("差异");
  });

  test("what the scheduler could not place is counted, with a link to the reasons under 「排程顺序」", () => {
    const html = renderToStaticMarkup(<PlanView plan={{ ...plan,
      schedule: { status: "partial", blockers: [{ taskId: "w2", code: "NO_CAPACITY", message: "复核数据没有可用容量" }], solver: "feasible_time_limit" }
    }} />);
    expect(html).toContain("部分任务未排入");
    expect(html).toContain("1 个任务未排入，原因见「排程顺序」");
    expect(html).toContain("未证明最优");
  });
});
