import "server-only";
import { proposalReady, type AccessContext } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { getStore } from "./crossline";

/**
 * Proposals still being prepared: waiting for the person, but their steps are not planned yet (the worker plans them before any
 * committed task). They are not counted or listed as decisions until they are (`proposalReady`, decided 2026-10-15) — the person
 * approves what they will actually do. Capacity work, which the step planner never plans, and a proposal whose planning failed for a
 * reason of its own are shown as they are.
 */
export function preparingProposalIds(ctx: AccessContext): Set<string> {
  const store = getStore();
  const capacity = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const plans = new Map(store.listStepPlans(ctx.workspaceId).map((plan) => [plan.workOrderId, plan]));
  const blocked = new Set(store.listEvents(ctx.workspaceId, { type: "task.steps_blocked" }).map((event) => event.entityId));
  return new Set(store.listWorkOrders(ctx.workspaceId)
    .filter((order) => !proposalReady(order, plans.get(order.id), { planBlocked: blocked.has(order.id), exempt: capacity.has(order.identityId) }))
    .map((order) => order.id));
}
