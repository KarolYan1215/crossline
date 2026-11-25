import { estimateRatio, latestGateJudgements, verdictOf, type GateSubject } from "@crossline/core";
import type { CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { buildLedgerBrief } from "../ledger-brief";
import { GATE_LIMITS, gateEventsOf, gateGoal, localDay, pendingFor } from "./context";
import { runGate, type GateResult } from "./run";
import { boardTasks, gateLookups, gateTask, isOpen, priorityLabels } from "./tasks";

/**
 * J4, the front gate (docs/plans/execution-gates-1124.md §四 J4): once a local day, the model picks at most one cheap outside gate on the
 * critical path of a high-value external result, and the web puts it first on Today with what a day of delay costs. The cost
 * correction (J5's ratio) and the completion gate's latest status go in as evidence; the choice is the model's.
 */
export const FRONT_SKILL = "crossline-gate-front";
export const FRONT_VERSION = "crossline.gate.front.v1";
const DETAIL = {
  type: "object", additionalProperties: false, required: ["task", "minutes", "costOfDelay"],
  properties: { task: { type: "string" }, minutes: { type: "number" }, costOfDelay: { type: "string" } }
};
const DAY = 86_400_000;

/** Whether today's pick is still to be made. */
export const frontDue = (store: CrosslineStore, workspaceId: string, now: Date, timeZone?: string) =>
  pendingFor(store, workspaceId, "front", [localDay(now, timeZone)], now).length > 0;

export async function frontGatePass(deps: { store: CrosslineStore; workspaceId: string; client: CodexRpcBoundary; cwd: string; timeZone?: string; now?: Date }): Promise<GateResult[]> {
  const { store, workspaceId } = deps;
  const now = deps.now ?? new Date();
  const day = localDay(now, deps.timeZone);
  const open = boardTasks(store, workspaceId).filter(isOpen).slice(-GATE_LIMITS.tasksShown);
  if (!open.length) return [];
  const labels = priorityLabels(store, workspaceId);
  const completion = latestGateJudgements(gateEventsOf(store, workspaceId), "completion");
  const firstSeen = new Map<string, string>();
  for (const event of store.listEvents(workspaceId, { type: "work_order.transitioned" })) if (!firstSeen.has(event.entityId)) firstSeen.set(event.entityId, event.createdAt);
  const ratio = estimateRatio(store.listAllDurationObservations(workspaceId), now);
  const lookups = gateLookups(store, workspaceId);
  const tasks = open.map((order) => {
    const judged = completion.get(`task:${order.id}`);
    const seen = firstSeen.get(order.id);
    return { ...gateTask(store, workspaceId, order, lookups), p1: Boolean(labels.get(order.id)?.p1), outward: Boolean(labels.get(order.id)?.external),
      status: judged ? verdictOf(judged) : "", waitingOn: String((judged?.payload.output.detail as { waitingOn?: string } | undefined)?.waitingOn ?? ""),
      daysOpen: seen ? Math.max(0, Math.floor((now.getTime() - Date.parse(seen)) / DAY)) : null };
  });
  const brief = buildLedgerBrief(store, workspaceId, now);
  const input = { version: FRONT_VERSION, today: day, goal: gateGoal(store, workspaceId, now), ledger: { lines: brief.lines, milestones: brief.milestones }, tasks,
    ratio: ratio ? { median: ratio.median, n: ratio.n } : null };
  const subject: GateSubject = { kind: "day", id: day };
  return runGate({ store, workspaceId, client: deps.client, cwd: deps.cwd, gate: "front", skill: FRONT_SKILL, promptVersion: FRONT_VERSION, input,
    detail: DETAIL, subjects: new Map([["today", subject]]), stableKeys: ["goal", "ledger"], round: day,
    summary: `open ${tasks.length}, p1 ${tasks.filter((task) => task.p1).length}, outward ${tasks.filter((task) => task.outward).length}, ratio ${ratio ? `${ratio.median}×${ratio.n}` : "none"}`,
    developerInstructions: "Pick today's one front task as the crossline-gate-front Skill describes; return only the requested JSON with exactly one item whose `subject` is `today`.",
    now });
}
