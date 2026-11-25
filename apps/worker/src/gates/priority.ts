import type { GateSubject } from "@crossline/core";
import type { CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { buildLedgerBrief } from "../ledger-brief";
import { GATE_LIMITS, gateGoal, localDay, localWeek, pendingFor } from "./context";
import { runGate, type GateResult } from "./run";
import { boardTasks, gateLookups, gateTask, isOpen } from "./tasks";

/**
 * J1a (docs/plans/execution-gates-1124.md §四 J1a, round 1: the model marks, the person may turn it over): each week (Monday in the
 * person's zone) every open task is marked P1 and/or outward against the person's goal and milestones; tasks that appear during the
 * week are marked as they come.
 */
export const PRIORITY_SKILL = "crossline-gate-priority";
export const PRIORITY_VERSION = "crossline.gate.priority.v1";
const DETAIL = { type: "object", additionalProperties: false, required: [], properties: {} };

type Deps = { store: CrosslineStore; workspaceId: string; client: CodexRpcBoundary; cwd: string; timeZone?: string; now?: Date };

/** Open tasks not yet marked this week. */
export function unlabelled(store: CrosslineStore, workspaceId: string, now: Date, timeZone?: string): string[] {
  const open = boardTasks(store, workspaceId).filter(isOpen).map((order) => order.id);
  return pendingFor(store, workspaceId, "priority", open, now, localWeek(now, timeZone).from.toISOString());
}

export async function priorityGatePass(deps: Deps): Promise<GateResult[]> {
  const { store, workspaceId } = deps;
  const now = deps.now ?? new Date();
  const pending = unlabelled(store, workspaceId, now, deps.timeZone);
  if (!pending.length) return [];
  // The open list is shown, so the model weighs the new ones against the week; only the unlabelled are subjects.
  const lookups = gateLookups(store, workspaceId);
  const open = boardTasks(store, workspaceId).filter(isOpen).slice(-GATE_LIMITS.tasksShown);
  const brief = buildLedgerBrief(store, workspaceId, now);
  const week = localWeek(now, deps.timeZone).start;
  const input = { version: PRIORITY_VERSION, today: localDay(now, deps.timeZone), weekStart: week, goal: gateGoal(store, workspaceId, now),
    ledger: { lines: brief.lines, milestones: brief.milestones }, tasks: open.map((order) => gateTask(store, workspaceId, order, lookups)), judge: pending };
  const subjects = new Map<string, GateSubject>(pending.map((id) => [id, { kind: "task", id }]));
  return runGate({ store, workspaceId, client: deps.client, cwd: deps.cwd, gate: "priority", skill: PRIORITY_SKILL, promptVersion: PRIORITY_VERSION, input,
    detail: DETAIL, subjects, stableKeys: ["goal", "ledger"], round: week, summary: `open ${open.length}, to mark ${pending.length}`,
    developerInstructions: "Mark every task whose id is in `judge` as the crossline-gate-priority Skill describes, weighing it against all of `tasks`; return only the requested JSON, one item per id in `judge`.",
    now });
}
