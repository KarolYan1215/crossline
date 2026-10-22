import { PRODUCT_OWNER, STEP_PRODUCTS, STEP_ROLES, ownerPreferenceKey, productOf, stepLeavesMachine, type StepRole } from "@crossline/core";
import type { CrosslineStore, StoredStepPlan, StoredTaskStep } from "./index";

/**
 * The person's own say over who does a step (decided 2026-10-22, the owner's 4A): a step can be handed to the assistant or taken back on
 * the task, and the choice is kept for that kind of step on that line (`role|product`), which every later plan of the line follows
 * (`normalizeStepPlan`'s `ownerPreferences`). What only the person may do — an act in the world, a decision, graded answers, practice —
 * cannot be handed over; the normalization never lets a preference move those either.
 */
export const STEP_OWNER_PREFERENCES_SETTING = "steps.ownerPreferences";
type Preferences = Record<string, { owner: "person" | "assistant"; at: string; title: string }>;

const read = (store: CrosslineStore, workspaceId: string): Preferences => {
  try { return JSON.parse(store.getSetting(workspaceId, STEP_OWNER_PREFERENCES_SETTING) ?? "{}") as Preferences; } catch { return {}; }
};

/** A line's preferences as the normalization takes them: `role|product` → owner. */
export function ownerPreferencesFor(store: CrosslineStore, workspaceId: string, lineId: string): Map<string, "person" | "assistant"> {
  const out = new Map<string, "person" | "assistant">();
  for (const [key, value] of Object.entries(read(store, workspaceId))) {
    const [line, role, product] = key.split("|");
    if (line === lineId && role && product) out.set(`${role}|${product}`, value.owner);
  }
  return out;
}

/** Why a step cannot be handed to the assistant, or "" when it can. */
export function cannotHandOver(step: Pick<StoredTaskStep, "role" | "title" | "product" | "provides">): string {
  if (step.provides) return "这一步是交出本人手里的材料";
  const product = productOf(step.role, step.product);
  if (product === "action" || stepLeavesMachine(step.title)) return "对外的动作由本人做";
  if (product === "ability") return "能力要本人练";
  if (step.role === "decide") return "有后果的选择由本人做";
  return "";
}

/**
 * Hands one step to the assistant or back to the person, and remembers it for that kind of step on the task's line. Returns what was
 * kept, or the reason it was refused.
 */
export function chooseStepOwner(store: CrosslineStore, workspaceId: string, workOrderId: string, stepId: string, owner: "person" | "assistant",
  ownerId: string, now = new Date()): { ok: true; key: string } | { ok: false; reason: string } {
  const order = store.getWorkOrder(workspaceId, workOrderId);
  const step = store.getStepPlan(workspaceId, workOrderId)?.steps.find((item) => item.id === stepId);
  if (!order || !step) return { ok: false, reason: "找不到这一步" };
  if (step.status !== "planned") return { ok: false, reason: "这一步已经结束" };
  if (owner === "assistant") { const why = cannotHandOver(step); if (why) return { ok: false, reason: why }; }
  const product = productOf(step.role, step.product);
  store.setStepExecutor(workspaceId, workOrderId, stepId, owner === "assistant" ? "agent" : "human");
  const key = ownerPreferenceKey(order.identityId, step.role, product);
  const preferences = read(store, workspaceId);
  // Back to what the table says is no preference at all: the kind follows the rule again.
  if (PRODUCT_OWNER[product] === owner) delete preferences[key];
  else preferences[key] = { owner, at: now.toISOString(), title: step.title };
  store.setSetting(workspaceId, STEP_OWNER_PREFERENCES_SETTING, JSON.stringify(preferences));
  const label = `${STEP_ROLES[step.role as StepRole] ?? step.role}（${STEP_PRODUCTS[product]}）`;
  if (PRODUCT_OWNER[product] !== owner) store.addPreference({ workspaceId, source: "correction", scope: order.identityId, refId: `step-owner:${key}`, weight: 1,
    text: `这条线上「${label}」类的步骤${owner === "assistant" ? "交给助手做" : "由本人自己做"}（本人在「${step.title}」上选的）` });
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `step.owner_chosen:${workOrderId}:${stepId}:${now.getTime()}`, type: "step.owner_chosen",
    entityId: workOrderId, payload: { stepId, owner, key, at: now.toISOString() } });
  return { ok: true, key };
}

/**
 * The person's own material, asked for by a provide step (decided 2026-10-22). The planner already looked through the person's files and
 * folders; the worker then looks on the web for a tutorial or plan made for this task (`need-check.ts`): found, the step is settled as
 * `public` and the person is never asked; not found, the step asks — upload, or 「没有」. Until settled, nothing that uses it is made.
 */
export const MATERIAL_PROVIDED_EVENT = "task.material_provided";
/** The web check of one need: `{needId, covered, sources}`; a need without one is still being looked for. */
export const NEED_CHECKED_EVENT = "task.need_checked";
export type Provision = "file" | "none" | "public";

/** Each need still waiting: `checking` while the web check has not run, `ask` once it found nothing and the person is asked. */
export function needStatesOf(store: CrosslineStore, workspaceId: string, workOrderId: string): Map<string, "checking" | "ask"> {
  const checked = new Set(store.listEvents(workspaceId, { type: NEED_CHECKED_EVENT, entityId: workOrderId }).map((event) => (event.payload as { needId?: string }).needId));
  const plan = store.getStepPlan(workspaceId, workOrderId);
  // The person's own material (their data, a link sent to them) is never on the web: asked at once.
  const personal = new Set((plan?.needs ?? []).filter((need) => need.kind === "personal").map((need) => need.id));
  const out = new Map<string, "checking" | "ask">();
  for (const step of plan?.steps ?? []) if (step.provides && step.status === "planned")
    out.set(step.provides, checked.has(step.provides) || personal.has(step.provides) ? "ask" : "checking");
  return out;
}

/** Records the web check of one need; when it found material made for the task, the provide step is settled without asking. */
export function recordNeedCheck(store: CrosslineStore, workspaceId: string, workOrderId: string, needId: string, sources: Array<{ title: string; url: string }>,
  ownerId: string, now = new Date()): void {
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `${NEED_CHECKED_EVENT}:${workOrderId}:${needId}`, type: NEED_CHECKED_EVENT, entityId: workOrderId,
    payload: { needId, covered: sources.length > 0, sources, at: now.toISOString() } });
  const step = store.getStepPlan(workspaceId, workOrderId)?.steps.find((item) => item.provides === needId && item.status === "planned");
  if (step && sources.length) provideMaterial(store, workspaceId, workOrderId, step.id, "public", [], ownerId, now);
}

/** Each need of the plan and how it was settled; a need not in the map is still open. */
export function provisionsOf(store: CrosslineStore, workspaceId: string, workOrderId: string): Map<string, Provision> {
  const out = new Map<string, Provision>();
  for (const event of store.listEvents(workspaceId, { type: MATERIAL_PROVIDED_EVENT, entityId: workOrderId })) {
    const payload = event.payload as { needId?: string; how?: Provision };
    if (payload.needId && (payload.how === "file" || payload.how === "none" || payload.how === "public")) out.set(payload.needId, payload.how);
  }
  return out;
}

/** The needs a step waits on: those it uses whose provide step is not done. */
export function openNeedsOf(plan: Pick<StoredStepPlan, "steps">, step: Pick<StoredTaskStep, "uses">): string[] {
  const done = new Set(plan.steps.filter((item) => item.provides && item.status !== "planned").map((item) => item.provides!));
  return (step.uses ?? []).filter((need) => !done.has(need));
}

/** Settles a provide step: the files (already filed under the task's project) or 「没有」. */
export function provideMaterial(store: CrosslineStore, workspaceId: string, workOrderId: string, stepId: string, how: Provision, documentIds: string[],
  ownerId: string, now = new Date()): { ok: true; needId: string } | { ok: false; reason: string } {
  const step = store.getStepPlan(workspaceId, workOrderId)?.steps.find((item) => item.id === stepId);
  if (!step?.provides) return { ok: false, reason: "这一步不是提交材料" };
  if (how === "file" && !documentIds.length) return { ok: false, reason: "没有收到文件" };
  store.updateStepProgress(workspaceId, workOrderId, stepId, { status: how === "public" ? "skipped" : "done" }, ownerId,
    how === "file" ? "material_provided" : how === "public" ? "material_public" : "material_none");
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `${MATERIAL_PROVIDED_EVENT}:${workOrderId}:${step.provides}:${now.getTime()}`, type: MATERIAL_PROVIDED_EVENT,
    entityId: workOrderId, payload: { needId: step.provides, stepId, how, documentIds, at: now.toISOString() } });
  return { ok: true, needId: step.provides };
}

