import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
vi.mock("./calendar-detail", () => ({ CalendarDetail: () => <div>calendar</div> }));
import { PlanView, type PlanVersionData } from "./plan-view";

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

describe("PlanView", () => {
  test("B, C and A are views over one plan version", () => {
    const html = renderToStaticMarkup(<PlanView today="2026-09-15" plan={plan} />);
    expect(html).toContain('data-plan-version="plan-7"');
    expect(html).toContain("B · 双轨时间轴");
    expect(html).toContain("C · 计划差异");
    expect(html).toContain("A · 日 / 周");
    expect(html).toContain("USER REALITY");
    expect(html).toContain("AI AHEAD");
  });

  test("read-only source events are visibly non-draggable", () => {
    const html = renderToStaticMarkup(<PlanView today="2026-09-15" plan={plan} />);
    expect(html).toContain("UW Outlook · 只读");
    expect(html).toContain("草案 · 仅本地");
    expect(html).toContain('aria-controls="plan-panel-B"');
    expect(html).toContain('role="tabpanel"');
  });
});
