import { expect, test } from "vitest";
import { CrosslineStore } from "./index";
import { doneKinds, familiarityBook, familiarityFor, preparationOf } from "./preparation";

const estimate = { p25Minutes: 60, p50Minutes: 180, p85Minutes: 300, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const step = (id: string, role: string, minutes: number) => ({ id, role, title: id, deliverable: "", doneCriterion: "", share: 0.5,
  estimate: { p25Minutes: minutes, p50Minutes: minutes, p85Minutes: minutes }, dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human" as const, tickOutcome: "" });

test("craft work of a kind already accepted on the same line is prepared by its steps; on another line it gets a tutorial", () => {
  const store = new CrosslineStore(":memory:");
  const order = (id: string, identityId: string, state: string) => {
    store.saveWorkOrder({ id, ownerId: "o", workspaceId: "w", identityId, projectId: "p", milestoneId: "", intent: `${id} 搭建原型`, state: state as "approved", riskTier: "routine", estimate, payload: {} });
    store.saveStepPlan("w", id, { archetypeId: "build", quantity: { basis: "功能点", amount: 1, unit: "个" }, rationale: "", steps: [step("b", "build", 90), step("t", "test", 60)] }, "o", "t");
  };
  order("first", "startup", "accepted");
  order("next", "startup", "approved");
  order("elsewhere", "research", "approved");
  const plans = store.listStepPlans("w");
  const done = doneKinds(store, "w", plans);
  const of = (id: string) => preparationOf(store.getWorkOrder("w", id)!, plans.find((plan) => plan.workOrderId === id), done);
  expect(of("next")).toMatchObject({ level: "steps", reason: expect.stringContaining("做过同类任务") });
  expect(of("elsewhere").level).toBe("tutorial");
  store.close();
});

test("familiarity is read from the ledger: the planner's judgement kept with the plan, the person's own choice wins (W-154)", () => {
  const store = new CrosslineStore(":memory:");
  const save = (id: string, identityId: string, state: string, intent: string, familiarity?: { level: "near" | "mid" | "far"; why: string }) => {
    store.saveWorkOrder({ id, ownerId: "o", workspaceId: "w", identityId, projectId: "p", milestoneId: "", intent, state: state as "approved", riskTier: "routine", estimate, payload: {} });
    store.saveStepPlan("w", id, { archetypeId: "build", quantity: { basis: "功能点", amount: 1, unit: "个" }, rationale: "",
      ...(familiarity ? { familiarity } : {}), steps: [step("b", "build", 30)] }, "o", "t");
  };
  save("next", "research", "approved", "搭建 sleep replay 评审原型", { level: "near", why: "本人研究 sleep replay 器件，做过两次同类脚本" });
  save("media", "media", "approved", "搭建内容选题看板", { level: "far", why: "第一次做内容" });
  save("old", "media", "approved", "搭建旧计划");
  const plans = store.listStepPlans("w");
  const book = familiarityBook(store, "w", plans);
  const next = store.getWorkOrder("w", "next")!;
  expect(familiarityFor(book, next, "build")).toMatchObject({ level: "near", by: "model" });
  expect(preparationOf(next, plans.find((plan) => plan.workOrderId === "next"), doneKinds(store, "w", plans), familiarityFor(book, next, "build")).level).toBe("steps");
  const media = store.getWorkOrder("w", "media")!;
  expect(familiarityFor(book, media, "build").level).toBe("far");
  // A plan saved before the planner judged it reads as mid.
  expect(familiarityFor(book, store.getWorkOrder("w", "old")!, "build")).toMatchObject({ level: "mid", by: "none" });
  store.setSetting("w", "tasks.familiarity", JSON.stringify({ "media|build": "near" }));
  expect(familiarityFor(familiarityBook(store, "w", plans), media, "build")).toMatchObject({ level: "near", by: "person" });
  store.close();
});
