import { expect, test } from "vitest";
import { CrosslineStore } from "./index";

const estimate = { p25Minutes: 120, p50Minutes: 180, p85Minutes: 300, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

test("approving an order with a byproduct creates one landing order on the other line, after it, undoable, once", () => {
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "media-m", ownerId: "o", workspaceId: "w", identityId: "media", projectId: "xhs", title: "首轮内容获真实反馈", version: 1, status: "approved" });
  store.saveWorkOrder({ id: "sim", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "", intent: "跑真实数据仿真并画图",
    state: "awaiting_plan_approval", riskTier: "milestone", estimate,
    payload: { byproducts: [{ lineId: "media", milestoneId: "media-m", artifact: "一篇研究日记笔记", captureSteps: [{ step: "记下调参想法", minutes: 10 }],
      landing: { minutes: 40, description: "把笔记改成小红书草稿" }, why: "自媒体需要真实科研素材" }] } });
  store.transitionWorkOrder("w", "sim", { type: "plan.approved", approvalId: "o" }, "approve:sim");
  const landing = store.listWorkOrders("w").find((order) => order.id === "landing-sim-media")!;
  expect(landing).toMatchObject({ identityId: "media", milestoneId: "media-m", projectId: "xhs", state: "approved", intent: "落地：一篇研究日记笔记",
    payload: { byproductOf: "sim", dependsOn: ["sim"], evidenceContract: [{ description: "一篇研究日记笔记", required: true }] } });
  expect(landing.estimate.p50Minutes).toBe(40);
  expect(store.listEvents("w", { type: "work_order.auto_approved", entityId: "landing-sim-media" })).toHaveLength(1);
  // Approving again after a block does not duplicate it.
  store.transitionWorkOrder("w", "sim", { type: "blocked", reason: "x" }, "block:sim");
  store.transitionWorkOrder("w", "sim", { type: "plan.approved", approvalId: "o" }, "approve:sim:2");
  expect(store.listWorkOrders("w").filter((order) => order.id.startsWith("landing-"))).toHaveLength(1);
  store.close();
});
