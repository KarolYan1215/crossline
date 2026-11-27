import {
  addDays, dayInZone, GATE_GOAL_MAX_CHARS, GATE_GOAL_SETTING, GATE_JUDGED, instantInZone, pendingGateSubjects, weekStartOf, type GateId
} from "@crossline/core";
import { readTicks, type CrosslineStore } from "@crossline/db";
import { buildLedgerBrief } from "../ledger-brief";

/**
 * What every gate pass shares (docs/plans/execution-gates-1124.md §四.0): the resource bounds, the person's goal, their calendar
 * (day and week in their own zone), and what is left to judge. A gate supplies only its candidates, its evidence and its Skill.
 */

/** Resource bounds: how much goes into one model call and how long one may take. None of them decides a verdict. */
export const GATE_LIMITS = {
  /** Tasks judged in one completion call, the most pressing first (P1 / outward, just finished, due soonest). */
  tasksPerCall: 25,
  /** Open tasks shown as context beside the subjects (priority, front, attention's P1 list). */
  tasksShown: 60,
  /** Evidence items in one completion call, the newest kept. */
  evidencePerCall: 80,
  /** Characters of one document's text given as evidence. */
  docChars: 1500,
  /** Timed blocks in one weekly audit (the longest kept), and commits beside them, each capped on its own. */
  blocksPerWeek: 400,
  commitsPerWeek: 200,
  /** The person's night actions in one weekly review. */
  nightActionsPerWeek: 60,
  /** Milestones or setbacks in one call. */
  subjectsPerCall: 10,
  /** Recorded outcomes given to the setback gate to find its base rate in. */
  outcomesShown: 60,
  /** The person's latest overrides of a gate that ride along with its next run. */
  correctionsPerCall: 12,
  /** One gate call; a form waiting at its submit button at night gets far less. */
  runTimeoutMs: 30 * 60_000,
  nightFormTimeoutMs: 3 * 60_000,
  /** How far back a gate looks the first time it runs, so a new deployment does not judge months of history in one pass. */
  firstLookbackDays: 14
} as const;

const DAY = 86_400_000;
export const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY).toISOString();

/** The person's own zone, or UTC when none is known (stated, never guessed: a wrong zone moves the person's day and night). */
export const zoneOr = (timeZone?: string) => timeZone ?? "UTC";

/** The local day `now` falls in. */
export const localDay = (now: Date, timeZone?: string) => dayInZone(now, zoneOr(timeZone));

/** The week (Monday to Monday in the person's zone) `now` falls in, or `offset` weeks from it. */
export function localWeek(now: Date, timeZone?: string, offset = 0): { start: string; from: Date; until: Date } {
  const zone = zoneOr(timeZone);
  const start = addDays(weekStartOf(dayInZone(now, zone)), offset * 7);
  return { start, from: new Date(instantInZone(start, "00:00", zone)), until: new Date(instantInZone(addDays(start, 7), "00:00", zone)) };
}
export const previousWeek = (now: Date, timeZone?: string) => localWeek(now, timeZone, -1);

/** The local hour (0–23) of `at`. */
export const localHour = (at: Date, timeZone?: string) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: zoneOr(timeZone), hour: "2-digit", hourCycle: "h23" }).format(at)) % 24;

/** The judgements and overrides of a workspace, for `latestGateJudgements` and `pendingGateSubjects`. */
export const gateEventsOf = (store: CrosslineStore, workspaceId: string) => [
  ...store.listEvents(workspaceId, { type: GATE_JUDGED }), ...store.listEvents(workspaceId, { type: "gate.changed", change: "overridden" })];
/** The last day's model call attempts of a workspace (the `gate-attempts` log), for `gateExhausted`. */
export const gateAttemptsOf = (workspaceId: string, now: Date) =>
  readTicks("gate-attempts", workspaceId, new Date(now.getTime() - 86_400_000).toISOString());

/** The candidates still to judge for `gate` (see `pendingGateSubjects`). */
export const pendingFor = (store: CrosslineStore, workspaceId: string, gate: GateId, candidates: readonly string[], now: Date, sinceIso = "") =>
  pendingGateSubjects(gateEventsOf(store, workspaceId), gate, candidates, now, sinceIso, gateAttemptsOf(workspaceId, now));

/** The goal every gate judges against: the person's own text (Settings), then each line's goal. */
export function gateGoal(store: CrosslineStore, workspaceId: string, now: Date): string {
  const brief = buildLedgerBrief(store, workspaceId, now);
  return [store.getSetting(workspaceId, GATE_GOAL_SETTING) ?? "", ...brief.lines.map((line) => `${line.label}：${line.goal}`)] // i18n-ignore: model context
    .filter(Boolean).join("\n").slice(0, GATE_GOAL_MAX_CHARS);
}
