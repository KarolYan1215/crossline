import { FAMILIARITY_SETTING, familiarityOf, familiarityOverride, taskPreparation, taskTitleOf, type Familiarity, type Preparation } from "@crossline/core";
import type { CrosslineStore, StoredProfileFact, StoredStepPlan } from "./index";

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

/** The lines' own settings, read here because `@crossline/db` does not depend on the identity packs (`LINE_SETTING` there). */
const LINES_SETTING = "lines.v1";

/** What `familiarityFor` reads, gathered once for a page or a pass: accepted work per line and kind, the facts, the person's choices. */
export type FamiliarityBook = { kinds: Map<string, number>; lines: Map<string, number>; titles: Map<string, string[]>;
  facts: StoredProfileFact[]; overrides: string | undefined; domains: Map<string, string> };

export function familiarityBook(store: CrosslineStore, workspaceId: string, plans: readonly StoredStepPlan[] = store.listStepPlans(workspaceId)): FamiliarityBook {
  const archetype = new Map(plans.map((plan) => [plan.workOrderId, plan.archetypeId]));
  const kinds = new Map<string, number>(), lines = new Map<string, number>(), titles = new Map<string, string[]>();
  for (const order of store.listWorkOrders(workspaceId).filter((item) => item.state === "accepted")) {
    lines.set(order.identityId, (lines.get(order.identityId) ?? 0) + 1);
    titles.set(order.identityId, [...(titles.get(order.identityId) ?? []), taskTitleOf(order)]);
    const kind = archetype.get(order.id);
    if (kind) kinds.set(`${order.identityId}|${kind}`, (kinds.get(`${order.identityId}|${kind}`) ?? 0) + 1);
  }
  const domains = new Map<string, string>();
  try {
    for (const line of JSON.parse(store.getSetting(workspaceId, LINES_SETTING) ?? "[]") as Array<{ id?: unknown; domain?: unknown }>)
      if (typeof line?.id === "string" && typeof line.domain === "string") domains.set(line.id, line.domain);
  } catch { /* unreadable: no domains */ }
  return { kinds, lines, titles, facts: store.listProfileFacts(workspaceId), overrides: store.getSetting(workspaceId, FAMILIARITY_SETTING), domains };
}

/** How close a task is to what the person knows (`familiarityOf`), for preparation, the step planner and the tutorial writer. */
export function familiarityFor(book: FamiliarityBook, order: { id: string; identityId: string; intent: string; payload?: unknown; projectId?: string },
  archetypeId: string | undefined): Familiarity {
  return familiarityOf({ task: { title: taskTitleOf(order), intent: order.intent }, lineId: order.identityId, lineDomain: book.domains.get(order.identityId),
    facts: book.facts, sameKindDone: archetypeId ? book.kinds.get(`${order.identityId}|${archetypeId}`) ?? 0 : 0,
    lineDone: book.lines.get(order.identityId) ?? 0, doneTitles: (book.titles.get(order.identityId) ?? []).filter((title) => title !== taskTitleOf(order)),
    override: familiarityOverride(book.overrides, order.identityId, archetypeId) });
}
