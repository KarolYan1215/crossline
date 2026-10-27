import { describe, expect, test } from "vitest";
import { AGENT_CATEGORIES, AUTO_HANDOFF_LEAD_MINUTES, autoHandoffTiming, isAgentCategory, planAssistantTask, stepCategory, type DispatchableOrder } from "./agent-dispatch";

describe("自动交给 Agent: when a handed-over step may start", () => {
  const now = new Date("2026-10-12T15:00:00.000Z");
  test("due within the lead time or once its block has started, early later in the week, never without a block", () => {
    expect(AUTO_HANDOFF_LEAD_MINUTES).toBe(30);
    expect(autoHandoffTiming("2026-10-12T15:30:00.000Z", now)).toBe("due");
    expect(autoHandoffTiming("2026-10-12T15:31:00.000Z", now)).toBe("early");
    expect(autoHandoffTiming("2026-10-12T08:00:00.000Z", now)).toBe("due");
    expect(autoHandoffTiming(undefined, now)).toBe("unscheduled");
    expect(autoHandoffTiming("not a date", now)).toBe("unscheduled");
  });
  test("a step's kind comes from its role; a step the planner gave the assistant outright is reading and organising", () => {
    expect(stepCategory({ role: "draft", executor: "mixed" })).toBe("draft_text");
    expect(stepCategory({ role: "decide", executor: "mixed" })).toBeUndefined();
    expect(stepCategory({ role: "decide", executor: "agent" })).toBe("read_research_organize");
  });
});

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
  test("the person's own work with nothing automatable is not dispatched, and the reason says so", () => {
    expect(plan(order({ ai: [], intent: "推导第 3 章的状态方程" }))).toMatchObject({ fit: false, reason: expect.stringContaining("不整件交给助手") });
  });

  // A step worked back from a milestone has no AI/human split, so on the real account nothing was ever handed over. What it produces
  // decides now (docs/work-split.md): not its family, not its course's words.
  test("a small internal errand with no split is handed over whole; sending, the person's own work and a choice are not", () => {
    const step = (intent: string, family: string) => ({ ...order({ ai: [], human: [intent], intent }),
      payload: { automationParts: [], humanCore: [{ id: "h", intent }], family, evidenceContract: [{ description: "版本与输入规范的摘录和链接" }] } });
    const whole = plan(step("汇集 NeuroSim 输入规范与版本说明", "deep_work"));
    expect(whole).toMatchObject({ fit: true, delegated: true, category: "data_code_sim", humanPart: "审阅产出，决定用不用" });
    expect(whole.fit && whole.what).toContain("版本与输入规范的摘录和链接");
    expect(whole.fit && whole.what).toContain("needsHuman");
    expect(plan(step("给师兄发邮件要数据", "preparation"))).toMatchObject({ fit: false });
    expect(plan(step("写完仿真并出图", "deep_work"))).toMatchObject({ fit: false });
    expect(plan(step("判断要补哪些实验", "preparation"))).toMatchObject({ fit: false });
    // Compiling a course's material is the assistant's; the note keeps it from making anything that could be handed in.
    expect(plan(step("整理 ECE 548 期中考试复习提纲", "preparation"), true)).toMatchObject({ fit: true, graded: true, notes: expect.stringContaining("学习辅助") });
    expect(plan(order({ ai: ["整理文献"] }))).toMatchObject({ fit: true, delegated: false });
    // Choosing is the person's: a real run chose 「真实事项」 for them (and chose the app itself).
    expect(plan(step("选定一项创始人正在处理的真实事项，记录使用前状态", "preparation"))).toMatchObject({ fit: false });
    expect(plan(step("从素材库选出四个首轮选题", "review"))).toMatchObject({ fit: false });
  });

  test("owned work: the assistant's item goes whole, a question waits, the person's core task is never handed over whole", () => {
    const owned = (intent: string, owner: string, extra: Record<string, unknown> = {}) => ({ id: "x", intent, state: "approved", projectId: "p",
      payload: { owner, automationParts: [{ id: "a", intent }], humanCore: [], ...extra } });
    const item = planAssistantTask(owned("汇集期中考试规则与往年卷", "assistant", { answer: "考到第 7 讲", question: "考到第几讲？" }),
      { projectIsCourse: true, servesTitle: "规划期中复习与练习" });
    expect(item).toMatchObject({ fit: true, delegated: true, graded: true });
    expect(item.fit && item.what).toContain("规划期中复习与练习");
    expect(item.fit && item.what).toContain("考到第 7 讲");
    expect(planAssistantTask(owned("整理已出成绩", "ask"), { projectIsCourse: false })).toMatchObject({ fit: false });
    expect(planAssistantTask({ ...owned("写方法部分初稿", "person"), payload: { owner: "person", automationParts: [] } }, { projectIsCourse: false })).toMatchObject({ fit: false });
    // An assistant item that names a send or a choice stays the person's whatever the owner on record says.
    expect(planAssistantTask(owned("给导师发送方法部分", "assistant"), { projectIsCourse: false })).toMatchObject({ fit: false });
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

test("a run the person stopped is final; one the runtime lost is tried again", async () => {
  const { prepStepRetried } = await import("./agent-dispatch");
  expect(prepStepRetried([{ status: "blocked", blockerCode: "AGENT_CANCELLED" }])).toBe(false);
  expect(prepStepRetried([{ status: "blocked", blockerCode: "SKILL_CANCELED" }])).toBe(true);
});
