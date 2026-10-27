import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { TaskDetail } from "../../lib/task-detail";
import { TaskCard } from "./task-card";
import { LocaleProvider } from "../locale-context";

type Step = NonNullable<TaskDetail["stepPlan"]>["steps"][number];
const step = (id: string, over: Partial<Step> = {}): Step => ({
  id, workOrderId: "wo-1", seq: 1, role: "do", title: `步骤 ${id}`, deliverable: "", doneCriterion: "", share: 0.25,
  estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 70 }, dependsOn: [], schedulable: true, executor: "human",
  status: "planned", progressQuarter: 0, updatedAt: "2026-10-01T00:00:00Z", ...over
} as Step);

const base = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  id: "wo-1", ownerId: "o", viewerId: "o", workspaceId: "w", paused: false, identityId: "research", identityLabel: "研究", accent: "#000",
  title: "完成 ECE 555 作业 3", intent: "完成 ECE 555 作业 3 的全部题目并提交", state: "approved", riskTier: "milestone",
  estimate: { p25Minutes: 120, p50Minutes: 180, p85Minutes: 260, source: "llm_prior", observationCount: 0, confidence: "low" },
  manualPromotion: false, seeded: false, humanCore: [], automationParts: [], estimateBreakdown: [], byproducts: [], materialContract: [], evidenceContract: [],
  evidenceChecklist: [], preparedMaterials: [], executions: [], relatedFlywheel: [], background: null,
  projectName: "ECE 555", window: { dueBy: "2026-11-02" }, supports: [{ line: "media", lineLabel: "自媒体", target: "首轮发布", pending: false }],
  workedMinutes: 0, criteria: [], sources: [], agentOutputs: [], agentSteps: [], notes: [],
  ...over
} as TaskDetail);

describe("task card", () => {
  test("reads line, task, progress picture, current step with its first move, next block and due day — no percentage, no tag pile", () => {
    const detail = base({ stepPlan: { archetypeLabel: "习题", quantity: { basis: "", amount: 5, unit: "题" }, rationale: "", progress: 0.3, units: [], questions: [],
      steps: [step("a", { status: "done", title: "读题" }), step("b", { title: "解第 2 题", firstAction: "打开讲义第 4 节，抄下题目条件", progressQuarter: 2 }), step("c")] } });
    const html = renderToStaticMarkup(<TaskCard detail={detail} today="2026-10-15" slot={{ day: "2026-10-16", start: "14:00", end: "15:30" }} />);
    expect(html).toContain("研究");
    expect(html).toContain("ECE 555");
    expect(html).toContain("完成 ECE 555 作业 3");
    expect(html.match(/class="step-seg"/g)).toHaveLength(3);
    expect(html).toContain("解第 2 题");
    expect(html).toContain("打开讲义第 4 节，抄下题目条件");
    expect(html).toContain("约 45 分");
    expect(html).toContain("还剩 18 天");
    expect(html).toContain("14:00–15:30");
    // The figure is drawn, its number only in the accessible name; risk and cross-line support live in the dialog.
    expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/\d+%/);
    expect(html).not.toContain("支持 自媒体");
    expect(html).not.toContain("ui-tag");
    expect(html).toContain("开始计时");
  });

  test("a task waiting on its released assignment says so instead of a step to do", () => {
    const detail = base({ stepPlan: { archetypeLabel: "习题", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", progress: 0, units: [], questions: [],
      steps: [step("a", { title: "等待 作业发布", schedulable: false, notBefore: "2026-10-20" })] } });
    const html = renderToStaticMarkup(<TaskCard detail={detail} today="2026-10-15" />);
    expect(html).toContain("等待 · 作业发布（10/20 起）");
    expect(html).not.toContain("当前");
  });

  test("a proposal shows its first step and when the tutorial comes; one without steps says it is being prepared", () => {
    const planned = base({ state: "awaiting_plan_approval", stepPlan: { archetypeLabel: "习题", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", progress: 0, units: [], questions: [],
      steps: [step("a", { title: "列出题目", firstAction: "打开作业 PDF" })] }, preparation: { level: "tutorial", reason: "要学新内容" } });
    const html = renderToStaticMarkup(<TaskCard detail={planned} />);
    expect(html).toContain("第一步");
    expect(html).toContain("开工前三天会备好教程。");
    // Work its steps prepare enough gets no promise of a tutorial (docs/task-preparation.md).
    expect(renderToStaticMarkup(<TaskCard detail={{ ...planned, preparation: { level: "steps", reason: "" } }} />)).not.toContain("教程");
    expect(html).toContain("等本人批准");
    expect(renderToStaticMarkup(<TaskCard detail={base({ state: "awaiting_plan_approval" })} />)).toContain("准备中：步骤规划生成后再请本人确认。");
  });

  test("the task's sections say which they are, so a wide sheet can set steps and materials side by side", async () => {
    const { TaskPanels } = await import("./task-dialog");
    const html = renderToStaticMarkup(<TaskPanels detail={base()} />);
    expect([...html.matchAll(/data-section="(\w+)"/g)].map((match) => match[1])).toEqual(["steps", "materials", "finish"]);
  });
});

test("in English the card reads in English: due day, distance, step and duration", () => {
  const detail = base({ stepPlan: { archetypeLabel: "习题", quantity: { basis: "", amount: 5, unit: "题" }, rationale: "", progress: 0.3, units: [], questions: [],
    steps: [step("a", { title: "Solve problem 2", firstAction: "Open the notes at section 4", estimate: { p25Minutes: 60, p50Minutes: 90, p85Minutes: 120 } })] } });
  const html = renderToStaticMarkup(<LocaleProvider locale="en"><TaskCard detail={detail} today="2026-10-15" slot={{ day: "2026-10-16", start: "14:00", end: "15:30" }} /></LocaleProvider>);
  expect(html).toContain("Nov 2 Mon");
  expect(html).toContain("18 days left");
  expect(html).toContain("about 1 h 30 min");
  expect(html).toContain("Oct 16 Fri 14:00–15:30");
  expect(html).toContain("Start timer");
  expect(html).toContain("Start with");
  expect(html).not.toMatch(/截止|先做|开始计时|还剩/);
});
