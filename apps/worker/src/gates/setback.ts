import type { GateSubject } from "@crossline/core";
import type { CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { buildLedgerBrief } from "../ledger-brief";
import { daysBefore, GATE_LIMITS, gateGoal, localDay, pendingFor } from "./context";
import { runGate, type GateResult } from "./run";
/* i18n-ignore-start: evidence and context written for a model, not interface text */

/**
 * J2b, the setback gate (docs/plans/execution-gates-1124.md §四 J2b; the person's own protocol, 12 §2): a rejection, a missed milestone,
 * or one the person reports (`setback.reported`, written by the web) is classified as a wrong goal, a wrong execution or noise. The
 * recorded outcomes go in as they are, and the model picks the similar tries it weighs one outcome against. Nothing changes by itself:
 * in the 72 hours after a setback the person's judgement is worse, so the model classifies and the person decides (`goal_wrong` and
 * `execution_wrong` are in the gate's `askOn`).
 */
export const SETBACK_SKILL = "crossline-gate-setback";
export const SETBACK_VERSION = "crossline.gate.setback.v1";
export const SETBACK_REPORTED = "setback.reported";
const DETAIL = { type: "object", additionalProperties: false, required: ["change", "baseRate"], properties: { change: { type: "string" }, baseRate: { type: "string" } } };

export type Setback = { subject: string; kind: "rejected" | "missed" | "reported"; title: string; at: string; what: string; line: string; milestone: string };

/** Every setback since the gate's first lookback, by what it is. */
function setbacksSince(store: CrosslineStore, workspaceId: string, sinceIso: string): Setback[] {
  const opportunities = new Map(store.listOpportunities(workspaceId).map((row) => [row.id, row]));
  const milestones = new Map(store.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone]));
  const out: Setback[] = [];
  for (const event of store.listEvents(workspaceId, { type: "opportunity.outcome" })) {
    if (event.createdAt < sinceIso || (event.payload as { outcome?: string }).outcome !== "rejected") continue;
    const row = opportunities.get(event.entityId);
    out.push({ subject: `rejected:${event.eventId}`, kind: "rejected", title: row?.title ?? event.entityId, at: event.createdAt,
      what: `${row?.kind === "application" ? "申请" : "报名"}被拒：${row?.title ?? ""}（${row?.organizer ?? ""}）`, line: row?.lineId ?? "", milestone: "" });
  }
  for (const event of store.listEvents(workspaceId, { type: "milestone.overdue" })) {
    if (event.createdAt < sinceIso) continue;
    const milestone = milestones.get(event.entityId);
    const payload = event.payload as { deadline?: string; why?: string };
    out.push({ subject: `missed:${event.eventId}`, kind: "missed", title: milestone?.title ?? event.entityId, at: event.createdAt,
      what: `里程碑过期未完成：${milestone?.title ?? ""}，截止 ${payload.deadline ?? ""}（${payload.why ?? ""}）`, line: milestone?.identityId ?? "", milestone: event.entityId });
  }
  for (const event of store.listEvents(workspaceId, { type: SETBACK_REPORTED })) {
    if (event.createdAt < sinceIso) continue;
    const payload = event.payload as { text?: string; line?: string };
    out.push({ subject: `reported:${event.eventId}`, kind: "reported", title: (payload.text ?? "").slice(0, 60), at: event.createdAt,
      what: (payload.text ?? "").slice(0, 2000), line: payload.line ?? "", milestone: "" });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Setbacks not judged yet, oldest first. */
export function pendingSetbacks(store: CrosslineStore, workspaceId: string, now: Date): Setback[] {
  const all = setbacksSince(store, workspaceId, daysBefore(now, GATE_LIMITS.firstLookbackDays));
  const pending = new Set(pendingFor(store, workspaceId, "setback", all.map((item) => item.subject), now));
  return all.filter((item) => pending.has(item.subject));
}

/** Every recorded outcome of an application or registration, for the model to find the similar tries in. */
function outcomes(store: CrosslineStore, workspaceId: string) {
  const opportunities = new Map(store.listOpportunities(workspaceId).map((row) => [row.id, row]));
  return store.listEvents(workspaceId, { type: "opportunity.outcome" }).slice(-GATE_LIMITS.outcomesShown).map((event) => {
    const row = opportunities.get(event.entityId);
    return { at: event.createdAt, outcome: String((event.payload as { outcome?: string }).outcome ?? ""), kind: row?.kind ?? "", line: row?.lineId ?? "",
      title: row?.title ?? event.entityId, organizer: row?.organizer ?? "" };
  });
}

export async function setbackGatePass(deps: { store: CrosslineStore; workspaceId: string; client: CodexRpcBoundary; cwd: string; timeZone?: string; now?: Date }): Promise<GateResult[]> {
  const { store, workspaceId } = deps;
  const now = deps.now ?? new Date();
  const pending = pendingSetbacks(store, workspaceId, now).slice(0, GATE_LIMITS.subjectsPerCall);
  if (!pending.length) return [];
  const brief = buildLedgerBrief(store, workspaceId, now);
  const input = { version: SETBACK_VERSION, today: localDay(now, deps.timeZone), goal: gateGoal(store, workspaceId, now),
    setbacks: pending.map(({ subject, kind, title, at, what, line }) => ({ subject, kind, title, at, what, line: brief.lines.find((item) => item.id === line) ?? null })),
    outcomes: outcomes(store, workspaceId), milestones: brief.milestones };
  const subjects = new Map<string, GateSubject>(pending.map((item) => [item.subject, { kind: "action", id: item.subject }]));
  return runGate({ store, workspaceId, client: deps.client, cwd: deps.cwd, gate: "setback", skill: SETBACK_SKILL, promptVersion: SETBACK_VERSION, input,
    swap: (value, dual) => ({ ...value, setbacks: value.setbacks.filter((item) => dual.has(item.subject)).reverse(), outcomes: [...value.outcomes].reverse() }),
    detail: DETAIL, subjects, stableKeys: ["goal"], round: "1", summary: `setbacks ${pending.map((item) => item.kind).join(", ")}, outcomes ${input.outcomes.length}`, now });
}

/* i18n-ignore-end */
