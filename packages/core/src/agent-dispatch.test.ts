import { describe, expect, test } from "vitest";
import { AGENT_CATEGORIES, isAgentCategory, planAssistantTask, type DispatchableOrder } from "./agent-dispatch";

const order = (over: Partial<DispatchableOrder> & { ai?: string[]; human?: string[] } = {}): DispatchableOrder => ({
  id: "wo-1", intent: over.intent ?? "整理资料", state: "approved", projectId: "p",
  payload: {
    automationParts: (over.ai ?? []).map((intent, i) => ({ id: `a${i}`, intent })),
    humanCore: (over.human ?? ["决定怎么用"]).map((intent, i) => ({ id: `h${i}`, intent })),
    materialContract: [{ description: "6T SRAM 原理图" }]
  }
});
const plan = (o: ReturnType<typeof order>, course = false) => planAssistantTask(o, { projectIsCourse: course });

describe("what the assistant is handed", () => {
  test("nothing automatable means nothing to dispatch, and the reason says so", () => {
    expect(plan(order({ ai: [] }))).toMatchObject({ fit: false, reason: expect.stringContaining("都需要你自己做") });
  });

  test("the AI parts become the task and the human core stays the person's", () => {
    const result = plan(order({ ai: ["整理 6T SRAM 拓扑和 Cadence 操作检查表"], human: ["在 Virtuoso 中画原理图", "审批交付物"], intent: "熟悉 Cadence" }));
    if (!result.fit) throw new Error("expected fit");
    expect(result.what).toContain("整理 6T SRAM 拓扑");
    expect(result.what).toContain("6T SRAM 原理图");
    expect(result.humanPart).toBe("在 Virtuoso 中画原理图；审批交付物");
  });
});

describe("the kind of work", () => {
  const category = (ai: string[]) => { const result = plan(order({ ai })); return result.fit ? result.category : "no fit"; };

  test("the wording picks the kind", () => {
    expect(category(["写脚本清洗测量数据并画图"])).toBe("data_code_sim");
    expect(category(["阅读并摘要三篇文献，整理对照笔记"])).toBe("read_research_organize");
    expect(category(["起草给师兄的邮件草稿"])).toBe("draft_text");
    expect(category(["归档课程文件并重命名，会前备齐材料"])).toBe("files_calendar_prep");
  });

  test("most matches wins, and wording that points nowhere leaves the choice to the person", () => {
    expect(category(["阅读文献", "整理摘要", "总结笔记", "画图"])).toBe("read_research_organize");
    expect(category(["推进这件事"])).toBeUndefined();
  });

  test("every kind is a known kind", () => {
    expect(Object.keys(AGENT_CATEGORIES).every(isAgentCategory)).toBe(true);
    expect(isAgentCategory("anything_else")).toBe(false);
  });
});

describe("graded coursework", () => {
  test("in a course, work that is graded is learning aid only, and the task says so", () => {
    const result = planAssistantTask(order({ ai: ["写脚本完成作业 3 的仿真"], intent: "完成 ECE 555 作业 3" }), { projectIsCourse: true });
    if (!result.fit) throw new Error("expected fit");
    expect(result.graded).toBe(true);
    expect(result.notes).toContain("学习辅助");
  });

  test("the same wording outside a course is ordinary work", () => {
    const result = planAssistantTask(order({ ai: ["写脚本完成作业 3 的仿真"], intent: "完成作业 3" }), { projectIsCourse: false });
    expect(result.fit && result.graded).toBe(false);
  });

  test("studying for a course without graded work is not marked graded", () => {
    const result = planAssistantTask(order({ ai: ["整理 SRAM 学习资料"], intent: "熟悉 Cadence 和 SRAM" }), { projectIsCourse: true });
    expect(result.fit && result.graded).toBe(false);
  });
});
