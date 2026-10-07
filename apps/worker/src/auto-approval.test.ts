import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { AUTO_APPROVER_ID } from "@crossline/core";
import { autoApproveEligible } from "./auto-approval";

const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const order = (id: string, intent: string, family: string, riskTier: "routine" | "milestone" = "routine") => ({
  id, ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "", intent,
  state: "awaiting_plan_approval" as const, riskTier, estimate, payload: { family, humanCore: [] } });

test("eligible proposals take effect with the system as approver; the rest wait", () => {
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder(order("prep", "整理复习提纲", "preparation"));
  store.saveWorkOrder(order("send", "把提纲发送给同学", "preparation"));
  store.saveWorkOrder(order("deep", "写论文方法部分", "deep_work"));
  store.saveWorkOrder(order("ms", "整理数据", "preparation", "milestone"));
  expect(autoApproveEligible(store, "w")).toEqual(["prep"]);
  const states = Object.fromEntries(store.listWorkOrders("w").map((item) => [item.id, item.state]));
  expect(states).toEqual({ prep: "approved", send: "awaiting_plan_approval", deep: "awaiting_plan_approval", ms: "awaiting_plan_approval" });
  const transition = store.listEvents("w", { type: "work_order.transitioned", entityId: "prep" }).at(-1)!;
  expect(JSON.stringify(transition.payload)).toContain(AUTO_APPROVER_ID);
  expect(store.listEvents("w", { type: "work_order.auto_approved" }).map((event) => event.entityId)).toEqual(["prep"]);
  store.close();
});

test("an automatic approval the person took back is not re-applied", () => {
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder(order("prep", "整理复习提纲", "preparation"));
  autoApproveEligible(store, "w");
  store.transitionWorkOrder("w", "prep", { type: "approval.revoked", reason: "我自己来排" }, "revoke:prep:0");
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "rev:prep:0", type: "work_order.auto_approval_revoked", entityId: "prep", payload: {} });
  expect(store.listWorkOrders("w")[0]!.state).toBe("awaiting_plan_approval");
  expect(autoApproveEligible(store, "w")).toEqual([]);
  store.close();
});
