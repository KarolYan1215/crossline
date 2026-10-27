import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
// The conversation itself fetches and polls; here only what the panel hands it matters.
vi.mock("../chat/conversation", () => ({
  Conversation: ({ variant, page, placeholder }: { variant: string; page?: { kind: string; entityId: string; stepId?: string }; placeholder?: string }) =>
    <div className="entry-probe" data-variant={variant} data-page={JSON.stringify(page)} data-placeholder={placeholder} />
}));
import type { TaskDetail } from "../../lib/task-detail";
import type { TimelineItem } from "./model";
import { DayQuickActions } from "./quick-actions";

const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90 };
const step = (id: string, title: string, workOrderId: string) => ({
  id, title, executor: "human" as const, status: "planned" as const, schedulable: true, role: "draft", deliverable: "", doneCriterion: "", share: 0.5, estimate, dependsOn: [],
  notBefore: "", dueBy: "", tickOutcome: "", workOrderId, seq: 0, progressQuarter: 0, updatedAt: "2026-10-10T00:00:00.000Z" });
const detail = (id: string, title: string): TaskDetail => ({
  id, ownerId: "o", viewerId: "o", workspaceId: "w", paused: false, identityId: "research", identityLabel: "研究者", accent: "#000",
  title, intent: title, state: "ready_for_human", riskTier: "routine",
  estimate: { ...estimate, confidence: "low", source: "identity_prior", observationCount: 0 },
  manualPromotion: false, seeded: false, milestone: null, humanCore: [], automationParts: [],
  estimateBreakdown: [], byproducts: [], materialContract: [], evidenceContract: [], evidenceChecklist: [], preparedMaterials: [], executions: [], relatedFlywheel: [], background: null,
  window: { dueBy: "2026-10-20" }, supports: [], workedMinutes: 0, criteria: [], sources: [], agentOutputs: [], agentSteps: [], notes: [],
  stepPlan: { archetypeLabel: "写作产出", quantity: { basis: "篇", amount: 1, unit: "篇" }, rationale: "", progress: 0,
    steps: [step(`${id}s1`, "确定论证主线", id), step(`${id}s2`, "整理对照表", id)], units: [], questions: [] }
} as unknown as TaskDetail);
const block = (workOrderId: string, stepId: string, over: Partial<TimelineItem> = {}): TimelineItem => ({ id: `scheduled:${workOrderId}:${stepId}`, title: workOrderId,
  day: "2026-10-12", start: "14:00", end: "15:00", kind: "scheduled", workOrderId, stepId, identityId: "research", source: "排程", readOnly: false, ...over });
const details = { a: detail("a", "撰写综述初稿"), b: detail("b", "ECE 548 作业 3") };
const render = (selected?: TimelineItem, items: TimelineItem[] = [block("a", "as2"), block("b", "bs1", { start: "16:00", end: "17:00" })]) =>
  renderToStaticMarkup(<DayQuickActions day="2026-10-12" today="2026-10-12" items={items} proposals={[]} nowMinute={9 * 60}
    labels={{ research: "研究者" }} details={details} selected={selected} onDeselect={() => {}} />);
const pageOf = (html: string) => {
  const match = /data-page="([^"]*)"/.exec(html);
  return match ? JSON.parse(match[1]!.replaceAll("&quot;", "\"")) as { kind: string; entityId: string; stepId?: string } : undefined;
};

describe("the input box on the picked block", () => {
  test("a picked work block carries its task and step as the conversation's page, in the short block form", () => {
    const html = render(block("a", "as2"));
    expect(pageOf(html)).toEqual({ kind: "task", entityId: "a", stepId: "as2" });
    expect(html).toContain('data-variant="block"');
    expect(html).toContain("关于这项任务：改期、拆细、提问……");
  });

  test("picking another block hands the box that block's task and step", () => {
    expect(pageOf(render(block("b", "bs1")))).toEqual({ kind: "task", entityId: "b", stepId: "bs1" });
  });

  test("the picked block is keyed by its id and the box by its task, so switching remounts it and an unsent draft stays behind", () => {
    const panel = readFileSync(new URL("./quick-actions.tsx", import.meta.url), "utf8");
    const overview = readFileSync(new URL("./block-overview.tsx", import.meta.url), "utf8");
    expect(panel).toContain("<BlockOverview key={selected.id}");
    expect(overview).toContain("<Conversation key={detail.id}");
  });

  test("no box on the 下一项 form or on a calendar event", () => {
    expect(render()).not.toContain("entry-probe");
    const { workOrderId: _, stepId: __, ...event } = block("x", "", { id: "graph_calendar:1", kind: "calendar", title: "组会" });
    expect(render(event, [event])).not.toContain("entry-probe");
  });
});
