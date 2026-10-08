import { describe, expect, it } from "vitest";
import { ARCHETYPES, STEP_PLAN_SCHEMA, normalizeStepPlan, stepPlanWarnings, structuredOutputProblems, taskProgress, validateStepPlanShape, type StepPlan } from "./index";

const step = (id: string, role: StepPlan["steps"][number]["role"], extra: Partial<StepPlan["steps"][number]> = {}) => ({
  id, role, title: `${role} ${id}`, deliverable: "产出", doneCriterion: "完成标准", share: 0.25,
  estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 }, dependsOn: [], notBefore: "", dueBy: "",
  schedulable: true, executor: "human" as const, tickOutcome: "", ...extra
});
const plan = (steps: StepPlan["steps"], archetypeId = "writing"): StepPlan =>
  ({ archetypeId, quantity: { basis: "目标字数", amount: 0, unit: "千字" }, rationale: "", steps });

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
