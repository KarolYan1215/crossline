import "server-only";
import { reopenAgentResult, retractedEventIdsIn, withdrawArtifactRelationsFor, type StepPlanInput } from "@crossline/db";
import { PORTRAIT_FIGURE_SETTING, taskTitleOf, type AccessContext, type StoredDomainRecord, type WorkOrderState } from "@crossline/core";
import { archiveWorkOrder, getStore, restoreCapture, restoreWorkOrder, saveMilestoneEdit } from "./crossline";
import { tOf } from "./locale";

/**
 * Undo (decided 2026-10-08): every change of state the person makes is recorded with the operation that reverses it, and can be undone
 * for 24 hours — from the toast that follows it, the list of recent operations, or by saying 「撤销刚才的…」 in the input box. The log
 * is two ledger events: `op.applied` (label and inverse) and `op.undone`. An inverse restores what the operation changed; effects that
 * already followed elsewhere (a re-split a 「到了」 triggered, a run that already started) are not reversed, and the label says what is.
 */
export type Inverse =
  | { kind: "waiting.reopen"; items: Array<{ id: string; followUpAt: string }> }
  /** Waiting items the operation opened (推迟 because someone has to hand something over): closed again. */
  | { kind: "waiting.cancel"; ids: string[] }
  | { kind: "work_order.restore"; ids: string[] }
  | { kind: "work_order.archive"; ids: string[] }
  | { kind: "capture.restore"; ids: string[] }
  | { kind: "approval.revoke"; ids: string[] }
  | { kind: "settings.restore"; entries: Array<{ key: string; value: string | null }> }
  | { kind: "work_order.field"; id: string; field: "notBefore" | "dueDate"; value: string | null }
  | { kind: "work_order.estimate"; id: string; estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number } }
  | { kind: "step.estimate"; workOrderId: string; stepId: string; estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number } }
  | { kind: "step.status"; workOrderId: string; stepId: string; status: "planned" | "done" | "skipped"; progressQuarter: number }
  | { kind: "milestones.status"; ids: string[]; status: "draft" | "approved" | "archived" }
  | { kind: "event.retract"; eventIds: string[] }
  /** An uploaded file put back under the project it had (or none). */
  | { kind: "source.project"; entries: Array<{ id: string; projectId: string | null }> }
  /** The daily merge (apps/worker/src/dedupe.ts): the absorbed tasks come back and the kept one gets its payload and step plan back. */
  | { kind: "task.unmerge"; keepId: string; payload: unknown; plan: StepPlanInput | null; restore: string[] }
  /** Records (docs/domain-lines.md) the operation added are removed again; ones it removed come back. */
  | { kind: "records.deleted"; ids: string[]; deleted: boolean }
  /** Ledger fields of records an operation changed (docs/mail-bookkeeping.md: category, kind, status, the duplicate and refund links) go back. */
  | { kind: "records.fields"; entries: Array<{ id: string; patch: Partial<Pick<StoredDomainRecord, "kind" | "category" | "categoryBy" | "status" | "possibleDupOf" | "refundOf" | "voidReason">> }> }
  /** Evidence an operation moved between records (a merge, a split) goes back to the record it was on. */
  | { kind: "records.evidence"; entries: Array<{ id: string; recordId: string }> }
  /** Assistant results the daily pass put away or accepted (apps/worker/src/date-advance.ts) wait for the person again. */
  | { kind: "agent.reopen"; taskIds: string[] }
  /**
   * Work orders whose payload an operation rewrote — who does it (`owner`, `prepares`, a question's answer; docs/work-split.md) — get the
   * payload back. `state`: the state it had then; one that was a proposal and took effect since (the assistant's item auto-approved) is a
   * proposal again, unless the work went further.
   */
  | { kind: "work_order.payload"; entries: Array<{ id: string; payload: unknown; state?: string }> }
  /** Step plans an operation rewrote get their open steps back (the done ones were never touched; `saveStepPlan` keeps them). */
  | { kind: "step_plan.restore"; plans: Array<{ workOrderId: string; plan: StepPlanInput }> }
  | { kind: "batch"; items: Inverse[] };

export type Op = { id: string; label: string; at: string; inverse: Inverse };

const WINDOW_MS = 24 * 3_600_000;

/** Records an operation that has just happened. Returns the op so a route can hand its id to the toast. */
export function recordOp(ctx: AccessContext, label: string, inverse: Inverse): Op {
  const id = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const at = new Date().toISOString();
  getStore().appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `op.applied:${id}`,
    type: "op.applied", entityId: id, payload: { label: label.slice(0, 160), inverse } });
  return { id, label, at, inverse };
}

/** What can still be undone: the last 24 hours, newest first, not already undone. */
export function recentOps(ctx: AccessContext, now = new Date()): Op[] {
  const store = getStore();
  const undone = new Set(store.listEvents(ctx.workspaceId, { type: "op.undone" }).map((event) => event.entityId));
  return store.listEvents(ctx.workspaceId, { type: "op.applied" })
    .filter((event) => !undone.has(event.entityId) && now.getTime() - Date.parse(event.createdAt) < WINDOW_MS)
    .map((event) => {
      const payload = event.payload as { label: string; inverse: Inverse };
      return { id: event.entityId, label: payload.label, at: event.createdAt, inverse: payload.inverse };
    })
    .reverse();
}

/** Event ids of `type` that an undo has taken back (a risk accepted, a question put off): readers skip them. */
export const retractedEventIds = (ctx: AccessContext): Set<string> => retractedEventIdsIn(getStore(), ctx.workspaceId);

/**
 * 撤销 on a task the daily merge absorbed (the 「已合并」 group of the 已丢弃 drawer), at any time, not only within the 24-hour undo
 * window. The whole merge is reversed — the absorbed tasks come back and the kept one gets its payload and step plan back — while
 * nothing has been merged into the kept task since; after a later merge only the absorbed tasks come back, so the later one is not lost.
 */
export function undoMerge(ctx: AccessContext, absorbedId: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const event = store.listEvents(ctx.workspaceId, { type: "op.applied" }).filter((item) => {
    const inverse = (item.payload as { inverse?: Inverse }).inverse;
    return inverse?.kind === "task.unmerge" && inverse.restore.includes(absorbedId);
  }).at(-1);
  if (!event) return { ok: false, code: "MERGE_NOT_FOUND" };
  const inverse = (event.payload as { inverse: Extract<Inverse, { kind: "task.unmerge" }> }).inverse;
  const undone = store.listEvents(ctx.workspaceId, { type: "op.undone", entityId: event.entityId }).length > 0;
  const later = store.listEvents(ctx.workspaceId, { type: "task.merged", entityId: inverse.keepId }).some((item) => item.createdAt > event.createdAt);
  const result = applyInverse(ctx, undone || later ? { kind: "work_order.restore", ids: [absorbedId] } : inverse);
  if (!result.ok) return result;
  if (!undone) store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `op.undone:${event.entityId}`,
    type: "op.undone", entityId: event.entityId, payload: { label: (event.payload as { label?: string }).label ?? "", partly: later } });
  return { ok: true };
}

/** Undoes one recorded operation. */
export function undoOp(ctx: AccessContext, opId: string): { ok: true; label: string } | { ok: false; code: string } {
  const op = recentOps(ctx).find((item) => item.id === opId);
  if (!op) return { ok: false, code: "OP_NOT_UNDOABLE" };
  const result = applyInverse(ctx, op.inverse);
  if (!result.ok) return result;
  getStore().appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `op.undone:${op.id}`,
    type: "op.undone", entityId: op.id, payload: { label: op.label } });
  return { ok: true, label: op.label };
}

function applyInverse(ctx: AccessContext, inverse: Inverse): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  try {
    switch (inverse.kind) {
      case "waiting.reopen":
        for (const item of inverse.items) store.reopenWaitingItem(ctx.workspaceId, item.id, item.followUpAt, ctx.principalId);
        return { ok: true };
      case "waiting.cancel":
        for (const id of inverse.ids) store.answerWaitingItem(ctx.workspaceId, id, { kind: "cancelled" }, ctx.principalId);
        return { ok: true };
      case "work_order.restore":
        for (const id of inverse.ids) { const result = restoreWorkOrder(ctx, id); if (!result.ok) return result; }
        return { ok: true };
      case "work_order.archive":
        for (const id of inverse.ids) { const result = archiveWorkOrder(ctx, id, tOf(ctx)("撤销恢复")); if (!result.ok) return result; }
        return { ok: true };
      case "capture.restore":
        for (const id of inverse.ids) { const result = restoreCapture(ctx, id); if (!result.ok) return result; }
        return { ok: true };
      case "approval.revoke": {
        const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
        for (const id of inverse.ids) {
          const state = orders.get(id)?.state as WorkOrderState | undefined;
          // Only an approval nothing has acted on yet can be taken back; a started or handed-in task is past it.
          if (!state || !["approved", "preparing", "ready_for_human"].includes(state)) return { ok: false, code: "APPROVAL_ALREADY_ACTED_ON" };
          const attempt = store.listEvents(ctx.workspaceId, { type: "approval.revoked", entityId: id }).length;
          store.transitionWorkOrder(ctx.workspaceId, id, { type: "approval.revoked", reason: tOf(ctx)("撤销批准") }, `undo-approval:${id}:${attempt}`);
        }
        return { ok: true };
      }
      case "task.unmerge": {
        for (const id of inverse.restore) { const result = restoreWorkOrder(ctx, id); if (!result.ok) return result; }
        const keep = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === inverse.keepId);
        if (keep) store.saveWorkOrder({ ...keep, payload: inverse.payload });
        if (keep && inverse.plan) store.saveStepPlan(ctx.workspaceId, inverse.keepId, inverse.plan, ctx.principalId, "unmerged");
        return { ok: true };
      }
      case "records.deleted":
        for (const id of inverse.ids) store.setRecordDeleted(ctx.workspaceId, id, inverse.deleted);
        return { ok: true };
      case "records.fields":
        for (const entry of inverse.entries) store.updateRecord(ctx.workspaceId, entry.id, entry.patch);
        return { ok: true };
      case "records.evidence":
        for (const entry of inverse.entries) store.moveRecordEvidence(ctx.workspaceId, [entry.id], entry.recordId);
        return { ok: true };
      case "step_plan.restore":
        for (const entry of inverse.plans) if (store.getStepPlan(ctx.workspaceId, entry.workOrderId))
          store.saveStepPlan(ctx.workspaceId, entry.workOrderId, entry.plan, ctx.principalId, "undo");
        return { ok: true };
      case "work_order.payload": {
        const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
        for (const entry of inverse.entries) {
          const order = orders.get(entry.id);
          if (!order) continue;
          store.saveWorkOrder({ ...order, payload: entry.payload });
          if (entry.state === "awaiting_plan_approval" && ["approved", "preparing", "ready_for_human"].includes(order.state)) {
            const attempt = store.listEvents(ctx.workspaceId, { type: "approval.revoked", entityId: entry.id }).length;
            store.transitionWorkOrder(ctx.workspaceId, entry.id, { type: "approval.revoked", reason: tOf(ctx)("撤销整理") }, `undo-payload:${entry.id}:${attempt}`);
          }
        }
        return { ok: true };
      }
      case "agent.reopen":
        for (const id of inverse.taskIds) reopenAgentResult(store, ctx.workspaceId, id, ctx.principalId);
        return { ok: true };
      case "source.project":
        for (const entry of inverse.entries) store.assignSourceDocumentProject(ctx.workspaceId, entry.id, entry.projectId);
        return { ok: true };
      case "settings.restore":
        for (const entry of inverse.entries) {
          if (entry.value === null) store.deleteSetting(ctx.workspaceId, entry.key);
          else store.setSetting(ctx.workspaceId, entry.key, entry.value);
        }
        return { ok: true };
      case "work_order.field": {
        const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === inverse.id);
        if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
        const payload = { ...((order.payload ?? {}) as Record<string, unknown>) };
        if (inverse.value === null) delete payload[inverse.field]; else payload[inverse.field] = inverse.value;
        store.saveWorkOrder({ ...order, payload });
        return { ok: true };
      }
      case "work_order.estimate": {
        const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === inverse.id);
        if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
        store.saveWorkOrder({ ...order, estimate: { ...order.estimate, ...inverse.estimate } });
        return { ok: true };
      }
      case "step.estimate":
        store.updateStepEstimate(ctx.workspaceId, inverse.workOrderId, inverse.stepId, inverse.estimate, ctx.principalId);
        return { ok: true };
      case "step.status":
        store.updateStepProgress(ctx.workspaceId, inverse.workOrderId, inverse.stepId,
          { status: inverse.status, progressQuarter: inverse.progressQuarter }, ctx.principalId, "undo");
        return { ok: true };
      case "milestones.status": {
        const latest = new Map(store.listMilestones(ctx.workspaceId).map((item) => [item.id, item]));
        for (const id of inverse.ids) {
          const milestone = latest.get(id);
          if (!milestone) continue;
          const saved = saveMilestoneEdit(ctx, { id, identityId: milestone.identityId, projectId: milestone.projectId ?? "", title: milestone.title,
            status: inverse.status, successCriteria: milestone.successCriteria ?? [], ...(milestone.templateId ? { templateId: milestone.templateId } : {}) });
          if (!saved.ok) return saved;
          // The cross-line relations approved with it go back to candidates with it.
          if (inverse.status === "draft") withdrawArtifactRelationsFor(store, ctx.workspaceId, id);
          // Undoing an approval also withdraws the tasks worked back from it that nobody has started; they come back with the next approval.
          if (inverse.status === "draft") for (const order of store.listWorkOrders(ctx.workspaceId)) {
            if (order.milestoneId === id && (order.payload as { backplan?: unknown } | undefined)?.backplan
              && ["awaiting_plan_approval", "approved", "ready_for_human"].includes(order.state)
              && !store.listExecutions(ctx.workspaceId).some((execution) => execution.workOrderId === order.id))
              archiveWorkOrder(ctx, order.id, tOf(ctx)("里程碑批准已撤销"), { bySystem: true });
          }
        }
        return { ok: true };
      }
      case "event.retract":
        return { ok: true };
      case "batch":
        // Reversed in the opposite order to the changes they undo.
        for (const item of [...inverse.items].reverse()) { const result = applyInverse(ctx, item); if (!result.ok) return result; }
        return { ok: true };
    }
  } catch (error) {
    return { ok: false, code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "UNDO_FAILED" };
  }
}

/** Settings an operation may change and an undo puts back. Device, account and calendar-write state are not operations. */
const UNDOABLE_SETTINGS = ["schedule.", "goal.settings:", "input.schedule.autoApply", "lines.", "calendar.lines", "ledger.", PORTRAIT_FIGURE_SETTING] as const;
/** Ledger markers that hide or close something when written; undoing the operation that wrote them brings it back. */
const RETRACTABLE_EVENTS = ["risk.accepted", "ask.snoozed", "missed.handled", "agent.blocked_acknowledged", "source.project_cleared", "milestone.overdue_resolved"];

type Snapshot = ReturnType<typeof snapshot>;
function snapshot(ctx: AccessContext) {
  const store = getStore();
  return {
    orders: new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, structuredClone(order)])),
    captures: new Map(store.listCaptures(ctx.workspaceId).map((capture) => [capture.id, capture.state])),
    waiting: new Map(store.listWaitingItems(ctx.workspaceId).map((item) => [item.id, { state: item.state, followUpAt: item.followUpAt }])),
    steps: new Map(store.listStepPlans(ctx.workspaceId).flatMap((plan) => plan.steps.map((step) =>
      [`${plan.workOrderId}#${step.id}`, { status: step.status, progressQuarter: step.progressQuarter, estimate: { ...step.estimate } }] as const))),
    milestones: new Map(store.listMilestones(ctx.workspaceId).map((item) => [item.id, item.status])),
    settings: store.listSettings(ctx.workspaceId, UNDOABLE_SETTINGS),
    sources: new Map(store.listSourceDocuments(ctx.workspaceId).map((doc) => [doc.id, doc.projectId ?? null])),
    records: new Set(store.listRecords(ctx.workspaceId).map((record) => record.id)),
    recordFields: new Map(store.listRecords(ctx.workspaceId, { includeDeleted: true }).map((record) => [record.id,
      { kind: record.kind, category: record.category, categoryBy: record.categoryBy, status: record.status, possibleDupOf: record.possibleDupOf, refundOf: record.refundOf, voidReason: record.voidReason }])),
    evidence: new Map(store.listRecordEvidence(ctx.workspaceId).map((item) => [item.id, item.recordId])),
    eventIds: new Set(store.listEvents(ctx.workspaceId, { type: RETRACTABLE_EVENTS }).map((event) => event.eventId))
  };
}

/** What reverses the difference between two snapshots. */
function inverseOf(before: Snapshot, after: Snapshot): Inverse[] {
  const items: Inverse[] = [];
  const reopen: Array<{ id: string; followUpAt: string }> = [];
  for (const [id, was] of before.waiting) {
    const now = after.waiting.get(id);
    if (was.state === "open" && now && (now.state !== "open" || now.followUpAt !== was.followUpAt)) reopen.push({ id, followUpAt: was.followUpAt });
  }
  if (reopen.length) items.push({ kind: "waiting.reopen", items: reopen });
  const addedRecords = [...after.records].filter((id) => !before.records.has(id)), removedRecords = [...before.records].filter((id) => !after.records.has(id));
  if (addedRecords.length) items.push({ kind: "records.deleted", ids: addedRecords, deleted: true });
  if (removedRecords.length) items.push({ kind: "records.deleted", ids: removedRecords, deleted: false });
  const fieldChanges = [...before.recordFields].flatMap(([id, was]) => {
    const now = after.recordFields.get(id);
    return now && JSON.stringify(now) !== JSON.stringify(was) ? [{ id, patch: was }] : [];
  });
  if (fieldChanges.length) items.push({ kind: "records.fields", entries: fieldChanges });
  const moves = [...before.evidence].flatMap(([id, recordId]) => after.evidence.has(id) && after.evidence.get(id) !== recordId ? [{ id, recordId }] : []);
  if (moves.length) items.push({ kind: "records.evidence", entries: moves });
  const opened = [...after.waiting].filter(([id, now]) => !before.waiting.has(id) && now.state === "open").map(([id]) => id);
  if (opened.length) items.push({ kind: "waiting.cancel", ids: opened });
  const restored: string[] = [], archived: string[] = [], revoked: string[] = [];
  const payloads: Array<{ id: string; payload: unknown }> = [];
  for (const [id, now] of after.orders) {
    const was = before.orders.get(id);
    // An errand the operation set going (`createErrand`) is taken back with it.
    if (!was) { if ((now.payload as { errand?: unknown } | undefined)?.errand && now.state !== "archived") archived.push(id); continue; }
    // Who does it changed (a question answered and handed to the assistant, docs/work-split.md): the whole payload goes back.
    const ownership = (payload: unknown) => { const p = (payload ?? {}) as Record<string, unknown>; return JSON.stringify([p.owner, p.prepares, p.question, p.answer]); };
    if (ownership(was.payload) !== ownership(now.payload)) payloads.push({ id, payload: was.payload });
    if (now.state === "archived" && was.state !== "archived") restored.push(id);
    if (was.state === "archived" && now.state !== "archived") archived.push(id);
    if (["awaiting_plan_approval", "blocked"].includes(was.state) && now.state === "approved") revoked.push(id);
    const wasPayload = (was.payload ?? {}) as Record<string, unknown>, nowPayload = (now.payload ?? {}) as Record<string, unknown>;
    for (const field of ["notBefore", "dueDate"] as const)
      if (wasPayload[field] !== nowPayload[field]) items.push({ kind: "work_order.field", id, field, value: (wasPayload[field] as string | undefined) ?? null });
    if (was.estimate.p50Minutes !== now.estimate.p50Minutes)
      items.push({ kind: "work_order.estimate", id, estimate: { p25Minutes: was.estimate.p25Minutes, p50Minutes: was.estimate.p50Minutes, p85Minutes: was.estimate.p85Minutes } });
  }
  if (payloads.length) items.push({ kind: "work_order.payload", entries: payloads });
  if (restored.length) items.push({ kind: "work_order.restore", ids: restored });
  if (archived.length) items.push({ kind: "work_order.archive", ids: archived });
  if (revoked.length) items.push({ kind: "approval.revoke", ids: revoked });
  const captures = [...after.captures].filter(([id, state]) => state === "discarded" && before.captures.get(id) && before.captures.get(id) !== "discarded").map(([id]) => id);
  if (captures.length) items.push({ kind: "capture.restore", ids: captures });
  for (const [key, was] of before.steps) {
    const now = after.steps.get(key);
    if (!now) continue;
    const [workOrderId, stepId] = [key.slice(0, key.indexOf("#")), key.slice(key.indexOf("#") + 1)];
    if (now.status !== was.status || now.progressQuarter !== was.progressQuarter)
      items.push({ kind: "step.status", workOrderId, stepId, status: was.status as "planned" | "done" | "skipped", progressQuarter: was.progressQuarter });
    if (now.estimate.p50Minutes !== was.estimate.p50Minutes) items.push({ kind: "step.estimate", workOrderId, stepId, estimate: was.estimate });
  }
  const milestoneGroups = new Map<string, string[]>();
  for (const [id, now] of after.milestones) {
    const was = before.milestones.get(id);
    if (was && was !== now) milestoneGroups.set(was, [...(milestoneGroups.get(was) ?? []), id]);
    // A milestone the operation created is taken back by archiving it.
    if (!was) milestoneGroups.set("archived", [...(milestoneGroups.get("archived") ?? []), id]);
  }
  for (const [status, ids] of milestoneGroups) items.push({ kind: "milestones.status", ids, status: status as "draft" | "approved" | "archived" });
  const moved = [...after.sources].filter(([id, projectId]) => before.sources.has(id) && before.sources.get(id) !== projectId)
    .map(([id]) => ({ id, projectId: before.sources.get(id) ?? null }));
  if (moved.length) items.push({ kind: "source.project", entries: moved });
  const entries = [...new Set([...before.settings.keys(), ...after.settings.keys()])]
    .filter((key) => before.settings.get(key) !== after.settings.get(key)).map((key) => ({ key, value: before.settings.get(key) ?? null }));
  if (entries.length) items.push({ kind: "settings.restore", entries });
  const added = [...after.eventIds].filter((id) => !before.eventIds.has(id));
  if (added.length) items.push({ kind: "event.retract", eventIds: added });
  return items;
}

/**
 * Runs an operation and records how to reverse it: the state it touches is read before and after, and the difference is the undo. One
 * mechanism for every route, so a new operation is undoable by being wrapped, not by writing its inverse by hand. Nothing is recorded
 * when the operation failed or changed nothing.
 */
export async function withUndo<T extends { ok: boolean }>(ctx: AccessContext, label: string, run: () => T | Promise<T>,
  /** Inverses the snapshot cannot see (an assistant result accepted: `agent.reopen`), added to the same operation. */
  extra?: () => Inverse[]): Promise<T & { op?: { id: string; label: string } }> {
  const before = snapshot(ctx);
  const result = await run();
  if (!result.ok) return result;
  const items = [...inverseOf(before, snapshot(ctx)), ...(extra?.() ?? [])];
  if (!items.length) return result;
  const op = recordOp(ctx, label, items.length === 1 ? items[0]! : { kind: "batch", items });
  return { ...result, op: { id: op.id, label: op.label } };
}

/** A task's or capture's own words for an undo label, shortened. */
export function titleOf(ctx: AccessContext, id: string): string {
  const store = getStore();
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === id);
  const text = (order ? taskTitleOf(order) : undefined) ?? store.listCaptures(ctx.workspaceId).find((capture) => capture.id === id)?.title ?? "";
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}
