import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LocaleProvider } from "../locale-context";
import { TaskCompletion, type CompletionTask } from "./task-completion";

type Step = NonNullable<CompletionTask["stepPlan"]>["steps"][number];
const step = (id: string, over: Partial<Step> = {}): Step => ({
  id, workOrderId: "w1", seq: 1, role: "do", title: `步骤 ${id}`, deliverable: "", doneCriterion: "", share: 0.5,
  estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 }, dependsOn: [], schedulable: true, executor: "human",
  status: "planned", progressQuarter: 0, updatedAt: "2026-10-01T00:00:00Z", ...over
} as Step);
const task = (over: Partial<CompletionTask> = {}): CompletionTask => ({
  id: "w1", title: "写材料", intent: "写一段分析", state: "active", viewerId: "o", workspaceId: "w", evidenceChecklist: [],
  estimate: { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior", observationCount: 0, confidence: "low" },
  ...over
} as CompletionTask);

// The one completion form (2026-10-28): what the old execution panel and Today's dialog each did, in one component.
describe("task completion", () => {
  test("a note, a link, files, and the two ways to finish", () => {
    const html = renderToStaticMarkup(<TaskCompletion task={task()} />);
    for (const text of ["完成说明", "链接（选填）", "选择文件", "提交", "完成（记为无证据）"]) expect(html).toContain(text);
    expect(html).not.toContain("只完成本步");
    expect(html).not.toContain("evidence-checklist");
  });

  test("the milestone's completion questions: options for a checkbox question, a box for a text one", () => {
    const html = renderToStaticMarkup(<TaskCompletion task={task({ evidenceChecklist: [
      { id: "q1", prompt: "初稿是否存在？", kind: "checkbox", options: ["是", "否"], required: true },
      { id: "q2", prompt: "具体情况是什么？", kind: "text", required: true }
    ] })} />);
    expect(html).toContain("初稿是否存在？");
    expect(html).toContain("是");
    expect(html).toContain("输入具体情况");
  });

  test("how long it took in one tap, from the estimate, with the screen record's figure first", () => {
    const html = renderToStaticMarkup(<TaskCompletion task={task({ suggestedMinutes: 47 })} />);
    expect(html).toContain("实际用时");
    expect(html).toContain("屏幕记录约 47 分");
    expect(html).toContain("≈估时 60 分");
    expect(html).toContain("两倍 120 分");
  });

  test("opened from one step of several, it also offers to finish only that step and says the rest stay open", () => {
    const html = renderToStaticMarkup(<TaskCompletion task={task({ stepPlan: { archetypeLabel: "", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", progress: 0, units: [], questions: [],
      steps: [step("a", { title: "写第一段" }), step("b")] } })} stepId="a" />);
    expect(html).toContain("写第一段");
    expect(html).toContain("只完成本步");
    expect(html).toContain("本任务还有 1 个未完成步骤");
  });

  test("in English", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><TaskCompletion task={task()} /></LocaleProvider>);
    expect(html).not.toMatch(/完成说明|选择文件|记为无证据|实际用时/);
  });
});
