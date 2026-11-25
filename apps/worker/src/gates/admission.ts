import { randomUUID } from "node:crypto";
import { MILESTONE_PARKED, MILESTONE_UNPARKED, parkedMilestones, type GateSubject, type MilestoneParkedPayload } from "@crossline/core";
import type { CodexRpcBoundary } from "@crossline/codex";
import { withdrawArtifactRelationsFor, type CrosslineStore, type StoredMilestone } from "@crossline/db";
import { tOfWorkspace } from "../locale";
import { ownerOf } from "../owner";
import { GATE_LIMITS, gateGoal, localDay, pendingFor } from "./context";
import { runGate, type GateResult } from "./run";
import { boardTasks, gateLookups, gateTask, isFinished, isOpen } from "./tasks";

/**
 * J2a, the admission gate (docs/plans/execution-gates-1124.md §四 J2a; round 3–4: milestones in series are not opened in parallel; the
 * model decides whether one is urgent and necessary enough to open anyway; lines, long-term goals and tasks are not gated). Every
 * milestone the person approves after the gate first ran is judged once, beside every other approved milestone and its progress. `park`
 * is done, then told, with an undo: the milestone goes back to draft with a `milestone.parked` event, and its worked-back tasks nobody
 * started are put away (they come back with it). `decline` changes nothing and is put to the person (`askOn`).
 */
export const ADMISSION_SKILL = "crossline-gate-admission";
export const ADMISSION_VERSION = "crossline.gate.admission.v1";
/** The milestones already approved when the gate first ran: never judged (written once). */
const BASELINE = "gates.admission.baseline";
const DETAIL = {
  type: "object", additionalProperties: false, required: ["closeOrPark", "unparkWhen"],
  properties: { closeOrPark: { type: "string" }, unparkWhen: { type: "string" } }
};
/** The only tasks a park may put away: worked back from the milestone, never started (a safety rule: nobody's work is taken away). */
const UNSTARTED = new Set(["awaiting_plan_approval", "approved", "ready_for_human"]);

const readIds = (raw: string | null | undefined): string[] => { try { const value = JSON.parse(raw ?? "null") as unknown; return Array.isArray(value) ? value.map(String) : []; } catch { return []; } };

/** Approved milestones still to judge; the very first call records every approved one as the baseline and returns none. */
export function admissionPending(store: CrosslineStore, workspaceId: string, now: Date): StoredMilestone[] {
  const approved = store.listMilestones(workspaceId).filter((milestone) => milestone.status === "approved");
  const raw = store.getSetting(workspaceId, BASELINE);
  if (raw === null || raw === undefined) { store.setSetting(workspaceId, BASELINE, JSON.stringify(approved.map((milestone) => milestone.id))); return []; }
  const baseline = new Set(readIds(raw));
  const pending = new Set(pendingFor(store, workspaceId, "admission", approved.filter((milestone) => !baseline.has(milestone.id)).map((milestone) => milestone.id), now));
  return approved.filter((milestone) => pending.has(milestone.id));
}

/**
 * A parked milestone the person approved again (撤销 on the park, or 开 elsewhere) is no longer parked: written down here, so the
 * monthly question and the stale-draft archiving read one record.
 */
export function reconcileParked(store: CrosslineStore, workspaceId: string) {
  const milestones = new Map(store.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone]));
  for (const [id, entry] of parkedMilestones(store.listEvents(workspaceId, { type: [MILESTONE_PARKED, MILESTONE_UNPARKED] }))) {
    const status = milestones.get(id)?.status;
    if (status === "draft") continue;
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, type: MILESTONE_UNPARKED, entityId: id,
      idempotencyKey: `${MILESTONE_UNPARKED}:${id}:${entry.judgedId}`, payload: { by: status === "approved" ? "approved_again" : status ?? "gone" } });
  }
}

/** Puts a milestone back to draft as parked, puts away its unstarted worked-back tasks, and records one undoable operation. */
export function parkMilestone(store: CrosslineStore, workspaceId: string, milestone: StoredMilestone, judged: { eventId: string; unparkWhen: string; reason: string }, now = new Date()) {
  const owner = ownerOf(store, workspaceId);
  const t = tOfWorkspace(store, workspaceId);
  const started = new Set(store.listExecutions(workspaceId).map((execution) => execution.workOrderId));
  const archived: string[] = [];
  for (const order of store.listWorkOrders(workspaceId)) {
    if (order.milestoneId !== milestone.id || !(order.payload as { backplan?: unknown } | undefined)?.backplan || !UNSTARTED.has(order.state) || started.has(order.id)) continue;
    const attempt = store.listEvents(workspaceId, { type: "work_order.archived", entityId: order.id }).length;
    const suffix = attempt ? `:${attempt}` : "";
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `archive-reason:${order.id}${suffix}`, type: "work_order.archived", entityId: order.id,
      payload: { reason: t("里程碑已停放"), from: order.state, bySystem: true } });
    if (store.transitionWorkOrder(workspaceId, order.id, { type: "archived" }, `archive:${order.id}${suffix}`).changed) archived.push(order.id);
  }
  store.saveMilestone({ ...milestone, status: "draft" });
  withdrawArtifactRelationsFor(store, workspaceId, milestone.id);
  const payload: MilestoneParkedPayload = { milestoneId: milestone.id, judgedId: judged.eventId, unparkWhen: judged.unparkWhen, reason: judged.reason, archivedTasks: archived };
  store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `${MILESTONE_PARKED}:${milestone.id}:${judged.eventId}`, type: MILESTONE_PARKED, entityId: milestone.id, payload });
  const opId = `op-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
  // The same shape the web's undo writes (`recordOp`): 撤销 approves it again (then `reconcileParked` unparks it) and brings the tasks back.
  store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `op.applied:${opId}`, type: "op.applied", entityId: opId,
    payload: { bySystem: true, label: t("停放里程碑「{{title}}」：等「{{after}}」完成", { title: milestone.title, after: judged.unparkWhen }),
      inverse: { kind: "batch", items: [{ kind: "milestones.status", ids: [milestone.id], status: "approved" }, ...(archived.length ? [{ kind: "work_order.restore", ids: archived }] : [])] } } });
  return { opId, archived };
}

export async function admissionGatePass(deps: { store: CrosslineStore; workspaceId: string; client: CodexRpcBoundary; cwd: string; timeZone?: string; now?: Date }): Promise<GateResult[]> {
  const { store, workspaceId } = deps;
  const now = deps.now ?? new Date();
  const pending = admissionPending(store, workspaceId, now).slice(0, GATE_LIMITS.subjectsPerCall);
  if (!pending.length) return [];
  const lookups = gateLookups(store, workspaceId);
  const orders = boardTasks(store, workspaceId);
  // Each milestone as it stands; how far along it is and whether it counts as open is the model's reading, not ours.
  const describe = (milestone: StoredMilestone) => {
    const own = orders.filter((order) => order.milestoneId === milestone.id && order.state !== "archived");
    return { subject: milestone.id, title: milestone.title, line: milestone.identityId, due: lookups.anchors.get(milestone.id) ?? "",
      criteria: milestone.successCriteria.map((item) => item.statement),
      tasks: own.map((order) => { const task = gateTask(store, workspaceId, order, lookups); return { title: task.title, executor: task.executor, minutes: task.minutes,
        progress: isFinished(order) ? "finished" : isOpen(order) ? "open" : "not_started" }; }) };
  };
  const pendingIds = new Set(pending.map((milestone) => milestone.id));
  const others = store.listMilestones(workspaceId).filter((item) => item.status === "approved" && !pendingIds.has(item.id)).map(describe);
  const relations = store.listMilestoneRelations(workspaceId).filter((relation) => relation.status !== "archived" && relation.status !== "refuted")
    .map((relation) => ({ from: relation.fromMilestoneId, to: relation.toMilestoneId, kind: relation.kind }));
  const input = { version: ADMISSION_VERSION, today: localDay(now, deps.timeZone), goal: gateGoal(store, workspaceId, now), judge: pending.map(describe), approved: others, relations };
  const subjects = new Map<string, GateSubject>(pending.map((milestone) => [milestone.id, { kind: "milestone", id: milestone.id }]));
  const results = await runGate({ store, workspaceId, client: deps.client, cwd: deps.cwd, gate: "admission", skill: ADMISSION_SKILL, promptVersion: ADMISSION_VERSION, input,
    swap: (value, dual) => ({ ...value, judge: value.judge.filter((item) => dual.has(item.subject)).reverse(), approved: [...value.approved].reverse(), relations: [...value.relations].reverse() }),
    detail: DETAIL, subjects, stableKeys: ["goal"], round: "1", summary: `judge ${pending.length}, approved ${others.length}, relations ${relations.length}`,
    developerInstructions: "Judge every milestone in `judge` as the crossline-gate-admission Skill describes, against `approved` and `relations`; return only the requested JSON, one item per milestone in `judge`.",
    now });
  for (const result of results) {
    // Parked only when it is still approved and the second run, if any, agreed: a disagreeing pair is the person's to decide.
    const current = store.listMilestones(workspaceId).find((item) => item.id === result.subject.id);
    if (result.output.verdict !== "park" || result.disagrees || current?.status !== "approved") continue;
    const detail = result.output.detail as { unparkWhen?: string } | undefined;
    parkMilestone(store, workspaceId, current, { eventId: result.eventId, unparkWhen: detail?.unparkWhen ?? "", reason: result.output.reason }, now);
  }
  return results;
}
