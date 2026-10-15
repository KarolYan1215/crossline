import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { AUTO_APPROVER_ID } from "@crossline/core";
import { autoApproveEligible } from "./auto-approval";

const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const order = (id: string, intent: string, family: string, riskTier: "routine" | "milestone" | "high_risk" = "routine") => ({
  id, ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "", intent,
  state: "awaiting_plan_approval" as const, riskTier, estimate, payload: { family, humanCore: [] } });
const nudges = (store: CrosslineStore) => store.listRecentNudges("w", "2000-01-01T00:00:00.000Z");

test("eligible proposals take effect with the system as approver and are told in one message; the rest wait", () => {
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder(order("prep", "整理复习提纲", "preparation"));
  store.saveWorkOrder(order("deep", "写论文方法部分", "deep_work", "milestone"));
  store.saveWorkOrder(order("send", "把提纲发送给同学", "preparation"));
  store.saveWorkOrder(order("pick", "选定首轮选题", "review", "high_risk"));
  expect(autoApproveEligible(store, "w")).toEqual(["prep", "deep"]);
  const states = Object.fromEntries(store.listWorkOrders("w").map((item) => [item.id, item.state]));
  expect(states).toEqual({ prep: "approved", deep: "approved", send: "awaiting_plan_approval", pick: "awaiting_plan_approval" });
  const transition = store.listEvents("w", { type: "work_order.transitioned", entityId: "prep" }).at(-1)!;
  expect(JSON.stringify(transition.payload)).toContain(AUTO_APPROVER_ID);
  expect(store.listEvents("w", { type: "work_order.auto_approved" }).map((event) => event.entityId)).toEqual(["prep", "deep"]);
  const said = nudges(store);
  expect(said).toHaveLength(1);
  const text = JSON.stringify(said[0]!.payload);
  expect(text).toContain("2 项任务已自动生效");
  expect(text).toContain("最近自动生效");
  expect(text).toContain("\"delivery\":\"pending\"");
  // Nothing new took effect: nothing more is said.
  expect(autoApproveEligible(store, "w")).toEqual([]);
  expect(nudges(store)).toHaveLength(1);
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
