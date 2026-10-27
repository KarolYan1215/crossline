import { describe, expect, it } from "vitest";
import { ARCHETYPES, STEP_PLAN_SCHEMA, finishedSteps, normalizeStepPlan, stepPlanWarnings, structuredOutputProblems, taskProgress, validateStepPlanShape, type StepPlan } from "./index";

const step = (id: string, role: StepPlan["steps"][number]["role"], extra: Partial<StepPlan["steps"][number]> = {}) => ({
  id, role, title: `${role} ${id}`, deliverable: "产出", doneCriterion: "完成标准", share: 0.25,
  estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 }, dependsOn: [], notBefore: "", dueBy: "",
  schedulable: true, executor: "human" as const, tickOutcome: "", covers: [] as string[], why: "", ...extra
});
const plan = (steps: StepPlan["steps"], archetypeId = "writing"): StepPlan =>
  ({ archetypeId, quantity: { basis: "目标字数", amount: 0, unit: "千字" }, rationale: "", units: [], questions: [], steps });

describe("archetypes", () => {
  it("every archetype's rules only name its own roles, and proportions roughly sum to one", () => {
    expect(ARCHETYPES).toHaveLength(18);
    for (const archetype of ARCHETYPES) {
      for (const role of [...archetype.requires, ...archetype.firstBefore.flat(), ...(archetype.endsWith ?? []), ...archetype.agentRoles])
        expect(archetype.roles, `${archetype.id} names ${role}`).toContain(role);
      const sum = Object.values(archetype.proportions).reduce((a, b) => a + b, 0);
      expect(sum, archetype.id).toBeGreaterThan(0.95);
      expect(sum, archetype.id).toBeLessThan(1.05);
    }
  });
  it("the step plan schema follows the strict structured-output rules", () => {
    expect(structuredOutputProblems(STEP_PLAN_SCHEMA)).toEqual([]);
  });
});

describe("step plans", () => {
  it("rejects only a malformed shape", () => {
    expect(() => validateStepPlanShape({ archetypeId: "nope", steps: [] })).toThrow("STEP_PLAN_SCHEMA_INVALID");
    expect(() => validateStepPlanShape(plan([{ ...step("a", "draft"), role: "dance" as never }]))).toThrow("STEP_PLAN_STEP_INVALID");
    expect(validateStepPlanShape(plan([step("a", "draft")])).steps).toHaveLength(1);
  });

  it("reads a list given as one string and a text given as a number, as another provider's model may send them", () => {
    // GLM-5.3-Flash through the chat bridge, where the schema is described and not enforced: `dependsOn: "s1"` threw on `.map`.
    const loose = plan([step("a", "draft"), { ...step("b", "check"), dependsOn: "a" as never, covers: "u1, u2" as never, deliverable: 3 as never,
      why: null as never, firstAction: undefined as never }]);
    loose.units = [{ id: "u1", title: "第一讲", docId: "doc-1", quote: "第一讲" }];
    loose.questions = [{ id: "q1", text: "交到哪里？", why: "", options: "Canvas、邮件" as never }];
    const { plan: normalized } = normalizeStepPlan(loose);
    expect(normalized.steps[1]).toMatchObject({ dependsOn: ["s1"], covers: ["u1"], deliverable: "3", why: "", firstAction: "" });
    expect(normalized.questions[0]!.options).toEqual(["Canvas", "邮件"]);
  });

  it("allows research-execute-execute-research: order is the model's call when the archetype's rules hold", () => {
    const { plan: normalized } = normalizeStepPlan(plan([step("r1", "gather"), step("d1", "draft", { dependsOn: ["r1"] }),
      step("d2", "draft", { dependsOn: ["d1"] }), step("r2", "gather", { dependsOn: ["d2"] }), step("c", "check", { dependsOn: ["r2"] })]));
    expect(stepPlanWarnings(normalized).filter((w) => w.code === "STEP_ORDER_RULE")).toEqual([]);
  });

  it("warns about a broken ordering rule instead of refusing", () => {
    const { plan: normalized } = normalizeStepPlan(plan([step("d", "draft"), step("g", "gather"), step("c", "check")]));
    expect(stepPlanWarnings(normalized).map((w) => w.code)).toContain("STEP_ORDER_RULE");
  });

  it("renames ids, drops unknown dependencies, breaks cycles and normalizes shares", () => {
    const { plan: normalized, warnings } = normalizeStepPlan(plan([
      step("x:1", "gather", { dependsOn: ["x:2"], share: 2 }), step("x:2", "draft", { dependsOn: ["x:1", "ghost"], share: 2 })]));
    expect(normalized.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
    const edges = normalized.steps.flatMap((s) => s.dependsOn.map((dep) => `${dep}>${s.id}`));
    expect(edges.length).toBe(1);
    expect(normalized.steps.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 2);
    expect(warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["STEP_DEPENDENCY_UNKNOWN", "STEP_CYCLE_BROKEN", "STEP_SHARE_NORMALIZED"]));
  });

  it("an account without the machine's assistant keeps every step its own (found walking the app as an invitee, 2026-10-15)", () => {
    const steps = [step("g", "gather", { title: "收集课程讲义", executor: "agent", schedulable: false }), step("t", "gather", { title: "整理材料清单" })];
    const guest = normalizeStepPlan(plan(steps), undefined, { assistant: false });
    expect(guest.plan.steps.map((s) => [s.executor, s.schedulable])).toEqual([["human", true], ["human", true]]);
    expect(guest.warnings.map((w) => w.code)).toContain("STEP_NO_ASSISTANT");
    const owner = normalizeStepPlan(plan(steps));
    expect(owner.plan.steps.map((s) => s.executor)).toEqual(["agent", "agent"]);
  });

  it("orders estimates and makes a waiting step take no calendar time", () => {
    const { plan: normalized } = normalizeStepPlan(plan([step("w", "wait", { estimate: { p25Minutes: 90, p50Minutes: 30, p85Minutes: 10 } })], "problem_set"));
    const [only] = normalized.steps;
    expect(only!.schedulable).toBe(false);
    expect(only!.estimate.p25Minutes).toBeLessThanOrEqual(only!.estimate.p50Minutes);
    expect(only!.estimate.p50Minutes).toBeLessThanOrEqual(only!.estimate.p85Minutes);
  });

  it("warns when the total does not fit the quantity or the window", () => {
    const { plan: normalized } = normalizeStepPlan({ ...plan([step("s", "solve"), step("u", "submit")], "problem_set"), quantity: { basis: "题目数", amount: 10, unit: "题" } });
    const codes = stepPlanWarnings(normalized, { availableMinutes: 20 }).map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["STEP_TOTAL_OFF_QUANTITY", "STEP_WINDOW_TOO_SMALL"]));
  });

  it("task progress counts done shares and a started step's quarters", () => {
    expect(taskProgress([{ share: 0.5, status: "done", progressQuarter: 0 }, { share: 0.5, status: "planned", progressQuarter: 2 }])).toBeCloseTo(0.75);
  });

  it("an accepted task's open steps read as done; a skipped one stays skipped and an open task is untouched", () => {
    const steps = [{ share: 0.5, status: "planned" as const, progressQuarter: 1 }, { share: 0.5, status: "skipped" as const, progressQuarter: 0 }];
    expect(finishedSteps("accepted", steps).map((step) => step.status)).toEqual(["done", "skipped"]);
    expect(taskProgress(finishedSteps("accepted", steps))).toBe(1);
    expect(finishedSteps("active", steps)).toEqual(steps);
  });
});

describe("grounded, non-trivial plans", () => {
  it("a person's step that only gathers or files material is handed to the assistant and takes no calendar time", () => {
    const { plan: normalized, warnings } = normalizeStepPlan(plan([step("a", "gather", { title: "清点材料并标注课程信息差异" }), step("b", "draft", { title: "推导 P-N 结耗尽区宽度" })]));
    expect(normalized.steps.map((item) => [item.executor, item.schedulable])).toEqual([["agent", false], ["human", true]]);
    expect(warnings.map((warning) => warning.code)).toContain("STEP_TRIVIAL_TO_AGENT");
  });
  it("a first move stays on the person's steps, one short line; the assistant's steps and waits have none", () => {
    const { plan: normalized } = normalizeStepPlan(plan([
      step("a", "gather", { title: "清点材料", firstAction: "打开文件夹" }),
      step("b", "draft", { title: "推导 P-N 结耗尽区宽度", firstAction: `  打开 L5 讲义，读到第一个例题${"啊".repeat(100)}` }),
      step("c", "wait", { title: "等批改", firstAction: "刷新邮箱" }),
      step("d", "check", { title: "对答案" })]));
    expect(normalized.steps.map((item) => item.firstAction?.slice(0, 16))).toEqual(["", "打开 L5 讲义，读到第一个例题", "", ""]);
    expect(normalized.steps[1]!.firstAction).toHaveLength(80);
  });
  it("each step carries who does it; the assistant never gets a send, and a step needing the person's data becomes a question", () => {
    const { plan: normalized, warnings } = normalizeStepPlan(plan([
      step("a", "gather", { title: "汇总三只基金的公开费率", owner: "person" }),
      step("b", "gather", { title: "整理券商导出的持仓明细", owner: "person" }),
      step("c", "draft", { title: "写出调仓理由", owner: "person" }),
      step("d", "submit", { title: "提交调仓指令", executor: "agent", owner: "assistant" })]));
    expect(normalized.steps.map((item) => [item.owner, item.executor, item.schedulable])).toEqual([
      ["assistant", "agent", false], ["ask", "agent", false], ["person", "human", true], ["person", "human", true]]);
    expect(normalized.questions.map((question) => question.text)).toEqual(["「整理券商导出的持仓明细」要用到本人的持仓：上传文件或截图，或直接写在这里。"]);
    expect(warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["STEP_TRIVIAL_TO_AGENT", "STEP_OWNER_ASK", "STEP_OWNER_PERSON"]));
  });
  it("a step that only reviews the assistant's output is folded into the first core step's first move, at most ten minutes", () => {
    const { plan: normalized, warnings } = normalizeStepPlan(plan([
      step("g", "gather", { title: "汇集期中考试规则与往年卷", executor: "agent", schedulable: false }),
      step("r", "check", { title: "验收助手整理的规则清单", dependsOn: ["g"], estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 40 } }),
      step("p", "practice", { title: "做 2 套往年卷并订正", dependsOn: ["r"], firstAction: "打开第一套卷子" })], "writing"));
    expect(normalized.steps.map((item) => item.title)).toEqual(["汇集期中考试规则与往年卷", "做 2 套往年卷并订正"]);
    const core = normalized.steps[1]!;
    expect(core).toMatchObject({ id: "s2", dependsOn: ["s1"], estimate: { p50Minutes: 40 } });
    expect(core.firstAction).toBe("先用 10 分钟扫一眼「汇集期中考试规则与往年卷」的产出；打开第一套卷子");
    expect(normalized.steps.reduce((sum, item) => sum + item.share, 0)).toBeCloseTo(1, 2);
    expect(warnings.map((warning) => warning.code)).toContain("STEP_REVIEW_FOLDED");
  });
  it("approving what the assistant just made is folded whatever its words; a judgement of it is not", () => {
    const { plan: normalized } = normalizeStepPlan(plan([
      step("a", "draft", { title: "起草反馈框架", executor: "agent", schedulable: false }),
      step("b", "check", { title: "验收反馈框架", dependsOn: ["a"] }),
      step("c", "build", { title: "执行真实数据仿真", executor: "agent", schedulable: false }),
      step("d", "test", { title: "核验图表科学结论", dependsOn: ["c"] }),
      step("e", "deliver", { title: "交付图表与数据包", dependsOn: ["d"], firstAction: "打开交付包" })], "writing"));
    expect(normalized.steps.map((item) => item.title)).toEqual(["起草反馈框架", "执行真实数据仿真", "核验图表科学结论", "交付图表与数据包"]);
  });
  it("the same in English: approving the assistant's draft is folded, checking its conclusions is not", () => {
    const { plan: normalized } = normalizeStepPlan(plan([
      step("a", "draft", { title: "Draft the feedback framework", executor: "agent", schedulable: false }),
      step("b", "check", { title: "Approve the feedback framework", dependsOn: ["a"] }),
      step("c", "build", { title: "Run the simulation on real data", executor: "agent", schedulable: false }),
      step("d", "test", { title: "Verify the conclusions in the charts", dependsOn: ["c"] }),
      step("e", "deliver", { title: "Hand over the charts", dependsOn: ["d"], firstAction: "Open the package" })], "writing"));
    expect(normalized.steps.map((item) => item.title)).toEqual(["Draft the feedback framework", "Run the simulation on real data",
      "Verify the conclusions in the charts", "Hand over the charts"]);
  });
  it("a step the plan calls a decision stays the person's; one it calls gathering is the assistant's (the hosted plans of 10-22)", () => {
    const { plan: normalized } = normalizeStepPlan(plan([
      step("a", "gather", { title: "整理候选人筛选底稿", executor: "agent", schedulable: false }),
      step("b", "decide", { title: "批准首轮试用候选人", executor: "agent", dependsOn: ["a"] }),
      step("c", "gather", { title: "汇编季度复盘决策底稿", dependsOn: ["b"] }),
      step("d", "gather", { title: "取得小测3正式范围", dependsOn: ["c"] }),
      step("e", "analyze", { title: "决定下一季度研究取舍", dependsOn: ["d"], firstAction: "打开底稿" })], "writing"));
    expect(normalized.steps.map((item) => [item.title, item.executor])).toEqual([
      ["整理候选人筛选底稿", "agent"], ["批准首轮试用候选人", "human"], ["汇编季度复盘决策底稿", "agent"], ["取得小测3正式范围", "agent"], ["决定下一季度研究取舍", "human"]]);
  });
  it("a step's choice stays the person's, and a startup line's interview synthesis is the person's core", () => {
    const { plan: normalized } = normalizeStepPlan(plan([
      step("a", "gather", { title: "收集 5 份试用访谈记录", executor: "agent", schedulable: false }),
      step("b", "draft", { title: "排出 5 份访谈的前 3 个痛点", dependsOn: ["a"] }),
      step("c", "decide", { title: "选定下一轮试用的门店", executor: "agent", dependsOn: ["b"] })]));
    expect(normalized.steps.map((item) => item.owner)).toEqual(["assistant", "person", "person"]);
  });
  it("a content unit stands only on a verbatim line of the document it names", async () => {
    const { unverifiedUnits } = await import("./steps");
    const docs = [{ id: "doc-1", text: "Week 3: L5 PN Junction electrostatics; L6 Diode I-V" }];
    expect(unverifiedUnits([{ id: "u1", title: "PN 结静电", docId: "doc-1", quote: "L5 PN Junction electrostatics" },
      { id: "u2", title: "MOS 电容", docId: "doc-1", quote: "L7 MOS capacitor" }, { id: "u3", title: "x", docId: "doc-9", quote: "Diode" }], docs).map((unit) => unit.id)).toEqual(["u2", "u3"]);
  });
});

describe("preparation written in English", async () => {
  const { TRIVIAL_STEP } = await import("./steps");
  it("is the assistant's, like its Chinese wording", () => {
    expect(TRIVIAL_STEP.test("整理课程材料")).toBe(true);
    expect(TRIVIAL_STEP.test("Collect the lecture slides")).toBe(true);
    expect(TRIVIAL_STEP.test("Organize the course materials")).toBe(true);
    expect(TRIVIAL_STEP.test("Build a reading list")).toBe(true);
    expect(TRIVIAL_STEP.test("Derive the transfer function")).toBe(false);
    expect(TRIVIAL_STEP.test("Review lecture 3")).toBe(false);
  });
});

describe("the step type table (3A, 2026-10-22)", () => {
  it("what a step produces decides who does it; the wording only forces the person", () => {
    const { plan: normalized } = normalizeStepPlan(plan([
      step("a", "read", { title: "摘要 L1–L4 讲义", product: "material" }),
      step("b", "read", { title: "读懂 L3 的耗尽区推导", product: "ability" }),
      step("c", "draft", { title: "起草给助教的邮件", product: "material" }),
      step("d", "summarize", { title: "总结第 3 章", executor: "agent", product: "material" }),
      step("e", "compare", { title: "比较三家门店并选定一家", product: "material" }),
      step("f", "learn", { title: "学习 BJT 小信号", product: "material" as never })], "exam_prep"));
    expect(normalized.steps.map((item) => [item.title, item.owner, item.product])).toEqual([
      ["摘要 L1–L4 讲义", "assistant", "material"], ["读懂 L3 的耗尽区推导", "person", "ability"], ["起草给助教的邮件", "assistant", "material"],
      ["总结第 3 章", "assistant", "material"], ["比较三家门店并选定一家", "person", "material"], ["学习 BJT 小信号", "person", "ability"]]);
  });
  it("the person's own choice for a kind of step holds, except where only the person may act", () => {
    const preferences = new Map<string, "person" | "assistant">([["read|material", "person"], ["submit|action", "assistant"]]);
    const { plan: normalized } = normalizeStepPlan(plan([step("a", "read", { title: "摘要 L1–L4 讲义", product: "material" }),
      step("b", "submit", { title: "提交作业 3", product: "action" })]), undefined, { ownerPreferences: preferences });
    expect(normalized.steps.map((item) => item.owner)).toEqual(["person", "person"]);
  });
  it("material only the person has is asked for first, and what uses it waits on that", () => {
    const raw = plan([step("a", "practice", { title: "闭卷完成作业 2 第 1 题", product: "ability", uses: ["n1"] }), step("b", "mock", { title: "限时模拟", product: "ability" })], "exam_prep");
    raw.needs = [{ id: "n1", what: "L3–L8 讲义", why: "练习要按讲义的推导", basis: "[f2] 讲义在 Canvas 上", kind: "reference" },
      { id: "n2", what: "往年卷", why: "", basis: "", kind: "reference" }];
    const { plan: normalized } = normalizeStepPlan(raw);
    expect(normalized.steps[0]).toMatchObject({ title: "提供L3–L8 讲义", provides: "n1", owner: "person", schedulable: false, executor: "human" });
    expect(normalized.steps[1]!.dependsOn).toContain(normalized.steps[0]!.id);
    // A need nothing on record says the person has is dropped: only one provide step.
    expect(normalized.needs).toEqual([{ id: "n1", what: "L3–L8 讲义", why: "练习要按讲义的推导", basis: "[f2] 讲义在 Canvas 上", kind: "reference" }]);
    expect(normalized.steps.filter((item) => item.provides)).toHaveLength(1);
  });
});
