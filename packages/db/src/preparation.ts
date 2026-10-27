import { taskPreparation, taskTitleOf, type Preparation } from "@crossline/core";
import type { CrosslineStore, StoredStepPlan } from "./index";

/**
 * What the person has done before, by line and kind of work (docs/task-preparation.md): an accepted task of each `line|archetype`, by its
 * short name. A craft task of a kind already done on the line is prepared by its steps only (`taskPreparation`).
 */
export function doneKinds(store: CrosslineStore, workspaceId: string, plans: readonly StoredStepPlan[] = store.listStepPlans(workspaceId)): Map<string, string> {
  const accepted = new Map(store.listWorkOrders(workspaceId).filter((order) => order.state === "accepted").map((order) => [order.id, order]));
  const done = new Map<string, string>();
  for (const plan of plans) {
    const order = accepted.get(plan.workOrderId);
    if (order) done.set(`${order.identityId}|${plan.archetypeId}`, taskTitleOf(order));
  }
  return done;
}

/** How a task card is prepared (`taskPreparation`), with what the person has done before read from the ledger. */
export function preparationOf(order: { id: string; identityId: string; intent: string; payload?: unknown; projectId?: string; estimate: { p50Minutes: number } },
  plan: StoredStepPlan | undefined, done: ReadonlyMap<string, string>): Preparation {
  const doneBefore = plan ? done.get(`${order.identityId}|${plan.archetypeId}`) : undefined;
  return taskPreparation({ title: taskTitleOf(order), intent: order.intent, p50Minutes: order.estimate.p50Minutes, ...(plan ? { archetypeId: plan.archetypeId } : {}) },
    plan?.steps, doneBefore ? { doneBefore } : {});
}
