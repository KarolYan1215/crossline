import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { TaskDetail } from "../../lib/task-detail";
import type { TimelineItem } from "./model";
import { DayQuickActions } from "./quick-actions";

const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90 };
const step = (id: string, title: string, executor: "human" | "agent" | "mixed", status: "planned" | "done" = "planned") => ({
  id, title, executor, status, schedulable: executor !== "agent", role: "draft", deliverable: "", doneCriterion: "", share: 0.5, estimate, dependsOn: [], notBefore: "",
  dueBy: "", tickOutcome: "", workOrderId: "wo-1", seq: 0, progressQuarter: 0, updatedAt: "2026-10-10T00:00:00.000Z" });
const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  id: "wo-1", ownerId: "o", viewerId: "o", workspaceId: "w", paused: false, identityId: "research", identityLabel: "研究者", accent: "#000",
  title: "撰写综述初稿", intent: "撰写综述初稿", state: "ready_for_human", riskTier: "routine",
  estimate: { ...estimate, confidence: "low", source: "identity_prior", observationCount: 0 } as TaskDetail["estimate"],
  manualPromotion: false, seeded: false, milestone: { id: "m1", title: "综述投稿" }, humanCore: [{ id: "h", intent: "确定综述的论证主线" }], automationParts: [],
  estimateBreakdown: [], byproducts: [], materialContract: [], evidenceContract: [], evidenceChecklist: [], preparedMaterials: [], executions: [], relatedFlywheel: [], background: null,
  window: { dueBy: "2026-10-20" }, supports: [], workedMinutes: 0, criteria: [], sources: [], agentOutputs: [], agentSteps: [{ id: "v1s2", title: "整理对照表" }], notes: [],
  stepPlan: { archetypeLabel: "写作产出", quantity: { basis: "篇", amount: 1, unit: "篇" }, rationale: "", progress: 0.25,
    steps: [step("v1s1", "确定论证主线", "human"), step("v1s2", "整理 8 篇文献的方法对照表", "mixed")], units: [], questions: [] },
  ...over
});
const block = (over: Partial<TimelineItem> = {}): TimelineItem => ({ id: "scheduled:wo-1:v1s2", title: "撰写综述初稿", day: "2026-10-12", start: "14:00", end: "15:00",
  kind: "scheduled", workOrderId: "wo-1", stepId: "v1s2", step: "整理 8 篇文献的方法对照表", identityId: "research", milestone: "综述投稿", source: "排程", readOnly: false, ...over });
const render = (props: Partial<Parameters<typeof DayQuickActions>[0]>) => renderToStaticMarkup(<DayQuickActions day="2026-10-12" today="2026-10-12" items={[block()]}
  proposals={[]} nowMinute={9 * 60} labels={{ research: "研究者" }} details={{ "wo-1": detail() }} {...props} />);

describe("the panel beside the day", () => {
  test("today's recommended work without a block of its own is listed under the next block; with nothing at all, the empty note says why", () => {
    const html = render({ suggestions: [{ id: "wo-1", title: "撰写综述初稿", label: "下一步" }, { id: "wo-2", title: "准备晚饭", label: "低精力备选", line: "research" }] });
    expect(html).toContain("也可以先做");
    expect(html).toContain('href="/workbench/wo-2"');
    expect(html).toContain("低精力备选");
    // The next block's own task is not listed twice.
    expect(html).not.toContain('href="/workbench/wo-1"');
    const none = render({ items: [], suggestions: [], emptyNote: "两项提案待批准" });
    expect(none).toContain("两项提案待批准");
  });

  test("with nothing picked: the load on top, the next block with its start, and the row of ways out at the bottom", () => {
    const html = render({ proposals: [{ id: "p1", title: "提案" }] });
    expect(html).toContain("当日负荷");
    expect(html).toContain("已排 1 小时");
    expect(html).toContain("下一项");
    expect(html).toContain("开始计时");
    // Opened by default with the block's actions (2026-10-29), without the in-place edits and the person's part.
    for (const action of ["完成并提交材料", "推迟", "锁定在此时间"]) expect(html).toContain(action);
    expect(html).not.toContain("本人负责");
    expect(html).toContain("待批准任务 · ");
    expect(html).toContain("全部批准");
    expect(html).toContain("调整可用时段");
  });

  test("a picked block shows its task: 主线 · 里程碑, the step and progress, the due date, the step's duration, the person's part and the actions", () => {
    const html = render({ selected: block(), onDeselect: () => {} });
    expect(html).toContain("选中的日程");
    expect(html).toContain("研究者");
    expect(html).toContain("综述投稿");
    expect(html).toContain("整理 8 篇文献的方法对照表");
    expect(html).toContain("本步 · 系统可做");
    expect(html).toContain("25%");
    expect(html).toContain("截止");
    expect(html).toContain("本步时长");
    expect(html).toContain("本人负责");
    expect(html).toContain("确定综述的论证主线");
    for (const action of ["开始计时", "完成并提交材料", "推迟", "交给 Agent", "返回下一项"]) expect(html).toContain(action);
  });

  test("a picked work block can be locked at its time, and a locked one unlocked", () => {
    expect(render({ selected: block(), onDeselect: () => {} })).toContain("锁定在此时间");
    const locked = render({ selected: block({ tag: "已锁定" }), onDeselect: () => {} });
    expect(locked).toContain("解除锁定");
    expect(locked).toContain('aria-pressed="true"');
  });

  test("交给 Agent only for a step the system can do; a block the assistant has says so instead", () => {
    expect(render({ selected: block({ id: "scheduled:wo-1:v1s1", stepId: "v1s1", step: "确定论证主线" }) })).not.toContain("交给 Agent");
    const running = render({ selected: block({ agent: "running" }) });
    expect(running).toContain("Agent 执行中");
    expect(running).not.toContain("交给 Agent");
    expect(render({ selected: block({ agent: "planned" }) })).toContain("Agent 将执行");
  });

  test("a running task offers pause and completion; an accepted one offers neither completion nor postponing", () => {
    const active = render({ selected: block(), details: { "wo-1": detail({ state: "active" }) } });
    expect(active).toContain("暂停");
    expect(active).toContain("完成并提交材料");
    const accepted = render({ selected: block(), details: { "wo-1": detail({ state: "accepted" }) } });
    expect(accepted).not.toContain("完成并提交材料");
    expect(accepted).not.toContain(">推迟<");
  });

  test("a calendar event shows what it is and where it came from, with nothing to act on", () => {
    const html = render({ selected: { id: "graph_calendar:x", kind: "calendar", title: "组会", day: "2026-10-12", start: "16:00", end: "17:00", source: "日历", readOnly: true } });
    expect(html).toContain("组会");
    expect(html).toContain("来自日历");
    expect(html).not.toContain("开始计时");
  });

  test("a task not read with the page is shown from the block while it loads", () => {
    const html = render({ selected: block(), details: {} });
    expect(html).toContain("撰写综述初稿");
    expect(html).toContain("读取任务");
  });
});
