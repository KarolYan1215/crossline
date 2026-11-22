import { FAMILIARITY_SETTING, familiarityOf, familiarityOverride, readModelFamiliarity, taskPreparation, taskTitleOf, type Familiarity, type ModelFamiliarity, type Preparation } from "@crossline/core";
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

/** How a task card is prepared (`taskPreparation`), with what the person has done before and how familiar the work is, from the ledger. */
export function preparationOf(order: { id: string; identityId: string; intent: string; payload?: unknown; projectId?: string; estimate: { p50Minutes: number } },
  plan: StoredStepPlan | undefined, done: ReadonlyMap<string, string>, familiarity?: Familiarity): Preparation {
  const doneBefore = plan ? done.get(`${order.identityId}|${plan.archetypeId}`) : undefined;
  return taskPreparation({ title: taskTitleOf(order), intent: order.intent, p50Minutes: order.estimate.p50Minutes, ...(plan ? { archetypeId: plan.archetypeId } : {}) },
    plan?.steps, { ...(doneBefore ? { doneBefore } : {}), ...(familiarity ? { familiarity: familiarity.level } : {}) });
}

/** What `familiarityFor` reads, gathered once for a page or a pass: the planner's judgement per task, the person's choices. */
export type FamiliarityBook = { planned: Map<string, ModelFamiliarity>; overrides: string | undefined };

export function familiarityBook(store: CrosslineStore, workspaceId: string, plans: readonly StoredStepPlan[] = store.listStepPlans(workspaceId)): FamiliarityBook {
  const planned = new Map<string, ModelFamiliarity>();
  for (const plan of plans) { const judged = readModelFamiliarity(plan.familiarity); if (judged) planned.set(plan.workOrderId, judged); }
  return { planned, overrides: store.getSetting(workspaceId, FAMILIARITY_SETTING) };
}

/**
 * How close a task is to what the person knows (`familiarityOf`), for preparation, the step planner and the tutorial writer: the person's
 * choice for the line and kind of work, else the planner's judgement kept with the task's plan (2026-11-22), else `mid`.
 */
export function familiarityFor(book: FamiliarityBook, order: { id: string; identityId: string },
  archetypeId: string | undefined): Familiarity {
  return familiarityOf({ override: familiarityOverride(book.overrides, order.identityId, archetypeId), planned: book.planned.get(order.id) });
}
