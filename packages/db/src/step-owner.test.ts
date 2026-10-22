import { afterEach, expect, test } from "vitest";
import { normalizeStepPlan, type StepPlan } from "@crossline/core";
import { CrosslineStore } from "./index";
import { chooseStepOwner, openNeedsOf, ownerPreferencesFor, provideMaterial, provisionsOf } from "./step-owner";

/** The person's say over who does a step (4A) and their own material first (2026-10-22). */
let store: CrosslineStore;
afterEach(() => store?.close());
const ws = "w";
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const step = (id: string, role: StepPlan["steps"][number]["role"], title: string, extra: Partial<StepPlan["steps"][number]> = {}) => ({ id, role, title,
  deliverable: "", doneCriterion: "x", share: 0.5, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 }, dependsOn: [], notBefore: "", dueBy: "",
  schedulable: true, executor: "human" as const, tickOutcome: "", covers: [] as string[], why: "", ...extra });
const seed = (raw: StepPlan) => {
  store = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "t", ownerId: "o", workspaceId: ws, identityId: "research", projectId: "ece548", milestoneId: "m", intent: "期中复习",
    state: "approved", riskTier: "routine", estimate, payload: { title: "期中复习" } });
  return store.saveStepPlan(ws, "t", normalizeStepPlan(raw).plan, "o", "planned");
};
const plan = (steps: StepPlan["steps"]): StepPlan => ({ archetypeId: "exam_prep", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", units: [], questions: [], steps });

test("a step handed to the assistant is remembered for that kind on the line; acts and practice cannot be handed over", () => {
  const saved = seed(plan([step("a", "read", "读 L1–L4 讲义并标出公式", { product: "ability" }), step("b", "summarize", "总结 L5", { product: "material" }),
    step("c", "submit", "提交作业 2", { product: "action" })]));
  const [read, summary, submit] = saved.steps;
  expect(chooseStepOwner(store, ws, "t", submit!.id, "assistant", "o")).toEqual({ ok: false, reason: "对外的动作由本人做" });
  expect(chooseStepOwner(store, ws, "t", read!.id, "assistant", "o")).toEqual({ ok: false, reason: "能力要本人练" });
  expect(chooseStepOwner(store, ws, "t", summary!.id, "person", "o")).toMatchObject({ ok: true });
  expect(store.getStepPlan(ws, "t")!.steps.find((item) => item.id === summary!.id)).toMatchObject({ executor: "human", schedulable: true });
  expect([...ownerPreferencesFor(store, ws, "research")]).toEqual([["summarize|material", "person"]]);
  // A later plan of the line follows it.
  expect(normalizeStepPlan(plan([step("x", "summarize", "总结 L6", { product: "material" })]), undefined,
    { ownerPreferences: ownerPreferencesFor(store, ws, "research") }).plan.steps[0]!.owner).toBe("person");
  // Back to what the table says: no preference left.
  chooseStepOwner(store, ws, "t", summary!.id, "assistant", "o");
  expect(ownerPreferencesFor(store, ws, "research").size).toBe(0);
});

test("material only the person has holds what uses it until it is uploaded or they say there is none", () => {
  const raw = plan([step("a", "practice", "闭卷完成作业 2 第 1 题", { product: "ability", uses: ["n1"] }), step("b", "summarize", "摘要 L3–L8", { product: "material", uses: ["n1"] })]);
  raw.needs = [{ id: "n1", what: "L3–L8 讲义", why: "按讲义推导", basis: "讲义在 Canvas 上" }];
  const saved = seed(raw);
  const provide = saved.steps.find((item) => item.provides === "n1")!;
  const summary = saved.steps.find((item) => item.title === "摘要 L3–L8")!;
  expect(saved.needs).toEqual([{ id: "n1", what: "L3–L8 讲义", why: "按讲义推导", basis: "讲义在 Canvas 上" }]);
  expect(openNeedsOf(saved, summary)).toEqual(["n1"]);
  expect(provideMaterial(store, ws, "t", provide.id, "file", [], "o")).toEqual({ ok: false, reason: "没有收到文件" });
  expect(provideMaterial(store, ws, "t", provide.id, "none", [], "o")).toEqual({ ok: true, needId: "n1" });
  const after = store.getStepPlan(ws, "t")!;
  expect(openNeedsOf(after, summary)).toEqual([]);
  expect([...provisionsOf(store, ws, "t")]).toEqual([["n1", "none"]]);
});
