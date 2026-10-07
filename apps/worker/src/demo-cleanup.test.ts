import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DEMO_RETIRED_REASON, retireShadowedDemos } from "./demo-cleanup";

const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const order = (id: string, state: "active" | "awaiting_plan_approval" | "accepted", seeded: boolean) => ({
  id, ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "", intent: id,
  state, riskTier: "routine" as const, estimate, payload: seeded ? { seeded: true } : {} });

test("demo orders are archived with a readable reason once the person has work of their own", () => {
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder(order("research-starter-work-order", "active", true));
  store.saveWorkOrder(order("old-demo", "accepted", true));
  expect(retireShadowedDemos(store, "w")).toEqual([]);
  store.saveWorkOrder(order("mine", "awaiting_plan_approval", false));
  expect(retireShadowedDemos(store, "w")).toEqual(["research-starter-work-order"]);
  const states = Object.fromEntries(store.listWorkOrders("w").map((item) => [item.id, item.state]));
  expect(states).toMatchObject({ "research-starter-work-order": "archived", "old-demo": "accepted", mine: "awaiting_plan_approval" });
  expect(store.listEvents("w", { type: "work_order.archived" }).map((event) => (event.payload as { reason: string }).reason))
    .toEqual([DEMO_RETIRED_REASON]);
  expect(retireShadowedDemos(store, "w")).toEqual([]);
  store.close();
});
