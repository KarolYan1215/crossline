import { describe, expect, it } from "vitest";
import { ARCHETYPES, STEP_PLAN_SCHEMA, normalizeStepPlan, stepPlanWarnings, structuredOutputProblems, taskProgress, validateStepPlanShape, type StepPlan } from "./index";

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
  it("a content unit stands only on a verbatim line of the document it names", async () => {
    const { unverifiedUnits } = await import("./steps");
    const docs = [{ id: "doc-1", text: "Week 3: L5 PN Junction electrostatics; L6 Diode I-V" }];
    expect(unverifiedUnits([{ id: "u1", title: "PN 结静电", docId: "doc-1", quote: "L5 PN Junction electrostatics" },
      { id: "u2", title: "MOS 电容", docId: "doc-1", quote: "L7 MOS capacitor" }, { id: "u3", title: "x", docId: "doc-9", quote: "Diode" }], docs).map((unit) => unit.id)).toEqual(["u2", "u3"]);
  });
});
