import { expect, test } from "vitest";
import { CrosslineStore } from "./index";
import { doneKinds, preparationOf } from "./preparation";

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
