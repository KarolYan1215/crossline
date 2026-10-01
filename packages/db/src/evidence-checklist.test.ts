import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "./index";

let store: CrosslineStore;
afterEach(() => store?.close());

const bank = [
  { id: "q1", prompt: "是否已经完成？", kind: "checkbox" as const, options: ["是", "否"], required: true },
  { id: "q2", prompt: "具体情况是什么？", kind: "text" as const, required: true }
];

const seedMilestone = (evidenceQuestionBank?: typeof bank) => {
  store.saveMilestone({
    id: "m", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p",
    title: "里程碑", version: 1, status: "approved",
    successCriteria: [{ id: "c1", statement: "x", required: true, measure: { kind: "artifact", mustExist: "x" } }],
    ...(evidenceQuestionBank ? { evidenceQuestionBank } : {})
  });
};

const seedWorkOrder = () => store.saveWorkOrder({
  id: "w1", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m",
  intent: "写综述", state: "awaiting_plan_approval", riskTier: "routine",
  estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
  payload: { materialContract: [], evidenceContract: [] }
});

test("approving a WorkOrder copies its milestone's evidence question bank onto evidenceChecklist", () => {
  store = new CrosslineStore(":memory:");
  seedMilestone(bank);
  seedWorkOrder();
  store.transitionWorkOrder("w", "w1", { type: "plan.approved", approvalId: "human" }, "approve:w1");
  const order = store.listWorkOrders("w")[0]!;
  expect((order.payload as { evidenceChecklist?: typeof bank }).evidenceChecklist).toEqual(bank);
});

test("a milestone with no evidence question bank leaves evidenceChecklist absent, not an empty array", () => {
  store = new CrosslineStore(":memory:");
  seedMilestone();
  seedWorkOrder();
  store.transitionWorkOrder("w", "w1", { type: "plan.approved", approvalId: "human" }, "approve:w1");
  const order = store.listWorkOrders("w")[0]!;
  expect((order.payload as { evidenceChecklist?: unknown }).evidenceChecklist).toBeUndefined();
});

test("the checklist is copied as a plain snapshot — later edits to the milestone's own bank do not retroactively change it", () => {
  store = new CrosslineStore(":memory:");
  seedMilestone(bank);
  seedWorkOrder();
  store.transitionWorkOrder("w", "w1", { type: "plan.approved", approvalId: "human" }, "approve:w1");
  // The milestone gets a new version with a different bank afterward.
  store.saveMilestone({
    id: "m", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p",
    title: "里程碑", version: 2, status: "approved",
    successCriteria: [{ id: "c1", statement: "x", required: true, measure: { kind: "artifact", mustExist: "x" } }],
    evidenceQuestionBank: [{ id: "q3", prompt: "新的问题", kind: "text", required: false }]
  });
  const order = store.listWorkOrders("w")[0]!;
  expect((order.payload as { evidenceChecklist?: typeof bank }).evidenceChecklist).toEqual(bank);
});
