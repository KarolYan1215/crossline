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

test("familiarity is read from the ledger: work done before and the person's background make it near, their own choice wins (W-154)", () => {
  const store = new CrosslineStore(":memory:");
  const save = (id: string, identityId: string, state: string, intent: string) => {
    store.saveWorkOrder({ id, ownerId: "o", workspaceId: "w", identityId, projectId: "p", milestoneId: "", intent, state: state as "approved", riskTier: "routine", estimate, payload: {} });
    store.saveStepPlan("w", id, { archetypeId: "build", quantity: { basis: "功能点", amount: 1, unit: "个" }, rationale: "", steps: [step("b", "build", 30)] }, "o", "t");
  };
  save("a1", "research", "accepted", "搭建 sleep replay 器件评测脚本");
  save("a2", "research", "accepted", "搭建 sleep replay 数据管线");
  save("next", "research", "approved", "搭建 sleep replay 评审原型");
  save("media", "media", "approved", "搭建内容选题看板");
  store.upsertProfileFact({ workspaceId: "w", identityId: "person", projectId: "", slot: "background", value: "电子工程博士，研究 sleep replay 器件",
    status: "confirmed", sourceRef: "reply-1", sourceQuote: "x", updatedAt: "2026-10-01T00:00:00Z" });
  const plans = store.listStepPlans("w");
  const book = familiarityBook(store, "w", plans);
  const next = store.getWorkOrder("w", "next")!;
  expect(familiarityFor(book, next, "build").level).toBe("near");
  expect(preparationOf(next, plans.find((plan) => plan.workOrderId === "next"), doneKinds(store, "w", plans), familiarityFor(book, next, "build")).level).toBe("steps");
  const media = store.getWorkOrder("w", "media")!;
  expect(familiarityFor(book, media, "build").level).toBe("far");
  store.setSetting("w", "tasks.familiarity", JSON.stringify({ "media|build": "near" }));
  expect(familiarityFor(familiarityBook(store, "w", plans), media, "build")).toMatchObject({ level: "near", by: "person" });
  store.close();
});
