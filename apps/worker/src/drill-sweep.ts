import { backedDrillForms, drillFormsIn, screenDrillItems, stripDrillForms, stripDrillSentences, type DrillForm } from "@crossline/core";
import type { CrosslineStore, StepPlanInput, StoredWorkOrder } from "@crossline/db";
import { drillBackingFor } from "./drill-backing";
import { ownerOf } from "./owner";

/** Settings flag: the sweep ran once for this workspace (bump the version to run it again after a rule change). */
export const DRILL_SWEEP_SETTING = "drill.sweep";
const DRILL_SWEEP_VERSION = "v1";
/** Shown in the 已丢弃 drawer, where 恢复 takes the task back (no `bySystem`: the person must be able to find and restore it). */
export const DRILL_ARCHIVE_REASON = "订正类任务已撤下：本人没说过要这样做"; // i18n-ignore: stored reason, shown through t()

type Sweep = { archived: string[]; skippedSteps: number; rewrittenOrders: string[] };

const titleOf = (order: StoredWorkOrder) => ((order.payload as { title?: string } | undefined)?.title ?? "").trim();

/**
 * Work written before the drill-form rule (the owner, 2026-11-10: 「永远不要给订正类任务」) was never screened: the rule only ran on new
 * plans, so tasks such as 「完成 ECE 548 作业 1、2 订正」 kept being scheduled. This runs the same screen once over what is stored:
 * - a task whose title is nothing but an unbacked drill is archived (in the 已丢弃 drawer with its reason, 恢复 undoes it);
 * - a planned step that is nothing but the drill is skipped (its status, so recorded progress and ids stay);
 * - the drill clauses are cut from the remaining steps (a new plan version, the old one in its event) and from the task's intent.
 * Done and skipped steps are history and left as written. What the person's own words back (`drill-backing.ts`) stays.
 */
export function sweepLegacyDrills(store: CrosslineStore, workspaceId: string): Sweep | undefined {
  if (store.getSetting(workspaceId, DRILL_SWEEP_SETTING) === DRILL_SWEEP_VERSION) return undefined;
  const owner = ownerOf(store, workspaceId);
  const result: Sweep = { archived: [], skippedSteps: 0, rewrittenOrders: [] };
  for (const order of store.listWorkOrders(workspaceId)) {
    if (order.state === "archived" || order.state === "accepted") continue;
    const plan = store.getStepPlan(workspaceId, order.id);
    const texts = [titleOf(order), order.intent, ...(plan?.steps.filter((step) => step.status === "planned")
      .flatMap((step) => [step.title, step.deliverable, step.doneCriterion, step.tickOutcome, step.firstAction ?? ""]) ?? [])];
    if (!texts.some((text) => drillFormsIn(text).length)) continue;
    const backed = backedDrillForms(drillBackingFor(store, workspaceId, { captureId: order.id, scopes: [order.identityId, `task:${order.id}`] }).backing);
    const title = titleOf(order) || order.intent;
    if (drillFormsIn(title).some((form) => !backed.has(form)) && !stripDrillForms(title, backed)) {
      archive(store, workspaceId, order, owner);
      result.archived.push(order.id);
      continue;
    }
    if (plan) result.skippedSteps += screenPlan(store, workspaceId, order.id, plan, backed, owner);
    if (rewriteOrder(store, order, backed)) result.rewrittenOrders.push(order.id);
  }
  store.setSetting(workspaceId, DRILL_SWEEP_SETTING, DRILL_SWEEP_VERSION);
  return result;
}

function archive(store: CrosslineStore, workspaceId: string, order: StoredWorkOrder, owner: string) {
  // Same event pair as 丢弃 (apps/web/lib/crossline.ts `archiveWorkOrder`): `from` is where 恢复 goes back to.
  const attempt = store.listEvents(workspaceId, { type: "work_order.changed", change: "archived", entityId: order.id }).length;
  const suffix = attempt ? `:${attempt}` : "";
  store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `archive-reason:${order.id}${suffix}`, type: "work_order.changed",
    entityId: order.id, payload: { reason: DRILL_ARCHIVE_REASON, from: order.state, drillSweep: true, change: "archived" } });
  store.transitionWorkOrder(workspaceId, order.id, { type: "archived" }, `archive:${order.id}${suffix}`);
}

/** Skips the planned steps that are only the drill and cuts it from the rest. Returns how many steps were skipped. */
function screenPlan(store: CrosslineStore, workspaceId: string, workOrderId: string,
  plan: NonNullable<ReturnType<CrosslineStore["getStepPlan"]>>, backed: ReadonlySet<DrillForm>, owner: string): number {
  const planned = plan.steps.filter((step) => step.status === "planned");
  const pure = planned.filter((step) => drillFormsIn(step.title).some((form) => !backed.has(form)) && !stripDrillForms(step.title, backed));
  for (const step of pure) store.updateStepProgress(workspaceId, workOrderId, step.id, { status: "skipped" }, owner, "drill_sweep");
  const rest = planned.filter((step) => !pure.includes(step));
  const { items, stripped } = screenDrillItems(rest, backed, ["deliverable", "doneCriterion", "tickOutcome", "firstAction"]);
  const rationale = stripDrillSentences(plan.rationale, backed) || plan.rationale;
  if (!stripped.length && rationale === plan.rationale) return pure.length;
  const steps: StepPlanInput["steps"] = items.map(({ workOrderId: _order, seq: _seq, status: _status, progressQuarter: _quarter, updatedAt: _updated, ...step }) => step);
  store.saveStepPlan(workspaceId, workOrderId, { archetypeId: plan.archetypeId, quantity: plan.quantity, rationale, units: plan.units,
    questions: plan.questions, ...(plan.importance ? { importance: plan.importance } : {}), ...(plan.needs?.length ? { needs: plan.needs } : {}), steps },
  owner, "drill_sweep");
  return pure.length;
}

/** Cuts the drill clauses from the task's own texts; the stored version before is in the event. */
function rewriteOrder(store: CrosslineStore, order: StoredWorkOrder, backed: ReadonlySet<DrillForm>): boolean {
  const payload = { ...((order.payload ?? {}) as Record<string, unknown>) };
  const cut = (text: string) => stripDrillForms(text, backed) || text;
  const intent = cut(order.intent);
  let changed = intent !== order.intent;
  for (const key of ["humanCore", "evidenceContract"] as const) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    payload[key] = list.map((item: Record<string, unknown>) => {
      const field = key === "humanCore" ? "intent" : "description";
      if (typeof item?.[field] !== "string") return item;
      const next = cut(item[field] as string);
      if (next !== item[field]) changed = true;
      return { ...item, [field]: next };
    });
  }
  if (!changed) return false;
  store.appendEvent({ ownerId: order.ownerId, workspaceId: order.workspaceId, idempotencyKey: `work_order.drill_swept:${order.id}`,
    type: "work_order.changed", entityId: order.id, payload: { before: { intent: order.intent, humanCore: (order.payload as Record<string, unknown>)?.humanCore,
      evidenceContract: (order.payload as Record<string, unknown>)?.evidenceContract }, change: "drill_swept" } });
  store.saveWorkOrder({ ...order, intent, payload });
  return true;
}
