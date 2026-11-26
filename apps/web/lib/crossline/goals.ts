import "server-only";
import { randomUUID } from "node:crypto";
import { goalSettingKey, presetFromReading, milestoneReadingOf, type ImportancePreset, type AccessContext } from "@crossline/core";
import { MILESTONE_RISKS_SETTING, parseMilestoneRisks, riskBufferDays } from "@crossline/core";
import { memoByLedger } from "../ledger-memo";
import { getStore } from "./store";
import { ensureSeeded } from "./seed";
import { readSchedulePreferences } from "./schedule-settings";
import { previewScope } from "./preview";
import { addDays } from "./clock";

export type GoalSettings = {
  /** The older important/ordinary choice; absent when nobody chose one, so the system's preset weight keeps applying. */
  importance?: "important" | "ordinary";
  confirmedDeadline: string | null; sourceQuote: string | null;
  /** 0–100, set with the slider; `importance` follows it (60 and above is important). */
  weight?: number };
export const goalKey = goalSettingKey;

/** The notes the two risk questions saved a moved date with: settings carrying them and a bare 「ordinary」 had it written for them. */
const IMPLIED_ORDINARY = new Set(["在「可能赶不上」的询问里推迟", "在里程碑风险的询问里调整截止"]);

export function readGoalSettings(ctx: AccessContext, id: string): GoalSettings | null {
  const raw = getStore().getSetting(ctx.workspaceId, goalKey(id));
  if (!raw) return null;
  try {
    const settings = JSON.parse(raw) as GoalSettings;
    // Moving a date from a risk question used to write 「ordinary」 the person never chose (fixed 2026-10-18): read as no choice, so the
    // preset weight applies again on accounts that answered one before the fix.
    if (settings.importance === "ordinary" && settings.weight === undefined && IMPLIED_ORDINARY.has(settings.sourceQuote ?? "")) {
      const { importance: _implied, ...rest } = settings;
      return rest;
    }
    return settings;
  } catch { return null; }
}

/**
 * A goal's importance, confirmed deadline and weight. Any of them may be sent alone (the milestone drawer saves the slider and the
 * date chip separately); what is not sent keeps its stored value.
 */
export function saveGoalSettings(ctx: AccessContext, id: string, input: { importance?: unknown; confirmedDeadline?: unknown;
  sourceQuote?: unknown; weight?: unknown }): { ok: true } | { ok: false; code: string } {
  ensureSeeded(ctx);
  const milestone = getStore().listMilestones(ctx.workspaceId).find((item) => item.id === id && item.status === "approved");
  if (!milestone) return { ok: false, code: "GOAL_NOT_APPROVED" };
  const previous = readGoalSettings(ctx, id);
  const weight = typeof input.weight === "number" && Number.isFinite(input.weight) ? Math.max(0, Math.min(100, Math.round(input.weight))) : previous?.weight;
  const importance = input.importance === "important" || input.importance === "ordinary" ? input.importance
    : typeof input.weight === "number" && weight !== undefined ? (weight >= 60 ? "important" : "ordinary")
    // A partial save (only a deadline, say) keeps whatever importance was in effect — none chosen means the preset keeps applying; it
    // used to default to 「ordinary」, which moved a milestone the presets weighed at 65 out of 「重要·有期限」.
    : input.importance === undefined ? previous?.importance ?? readSchedulePreferences(ctx)?.importance[id] : "invalid";
  if (importance !== undefined && importance !== "important" && importance !== "ordinary") return { ok: false, code: "GOAL_IMPORTANCE_INVALID" };
  const date = input.confirmedDeadline === undefined ? previous?.confirmedDeadline ?? null : input.confirmedDeadline;
  if (date !== null && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date))
    return { ok: false, code: "GOAL_DEADLINE_INVALID" };
  const quote = typeof input.sourceQuote === "string" ? input.sourceQuote.trim() : previous?.sourceQuote ?? "";
  if (quote.length > 500) return { ok: false, code: "GOAL_QUOTE_TOO_LONG" };
  const next: GoalSettings = { ...(importance ? { importance } : {}), confirmedDeadline: date as string | null,
    sourceQuote: quote || null, ...(weight !== undefined ? { weight } : {}) };
  const store = getStore();
  if (JSON.stringify(previous) === JSON.stringify(next)) return { ok: true };
  store.setSetting(ctx.workspaceId, goalKey(id), JSON.stringify(next));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `goal:settings:${id}:${randomUUID()}`, type: "goal.settings_confirmed", entityId: id,
    payload: { milestoneVersion: milestone.version, previous, next,
      ...(typeof input.weight === "number" ? { presetWeight: importancePresets(ctx).get(id)?.weight ?? null } : {}) } });
  return { ok: true };
}

/** At or above this weight a milestone counts as important (deadline tier 1 or 3). */
export const IMPORTANT_WEIGHT = 60;

/**
 * The system's suggested importance for every live milestone: the milestone reviewer's weight (`MilestoneReading`, 2026-11-22), which
 * reads the line's place in the person's order, the relations through it, what is at stake and how the person moved this line's sliders
 * before; 50 before a review. Derived on read.
 */
export function importancePresets(ctx: AccessContext): Map<string, ImportancePreset> {
  const stored = milestoneRisksOf(ctx);
  return new Map(getStore().listMilestones(ctx.workspaceId).filter((item) => item.status !== "archived")
    .map((item) => [item.id, presetFromReading(milestoneReadingOf(stored[item.id]))]));
}

/** The milestone reviews as stored (`MILESTONE_RISKS_SETTING`), read once a minute per ledger change. */
export function milestoneRisksOf(ctx: AccessContext) {
  return memoByLedger(getStore(), `milestone-risks:${ctx.workspaceId}`, 60_000, () => parseMilestoneRisks(getStore().getSetting(ctx.workspaceId, MILESTONE_RISKS_SETTING)));
}

const presetCache = new Map<string, { at: number; value: Map<string, ImportancePreset> }>();
/**
 * A milestone's importance as the scheduler uses it: a slider being previewed, else the person's own weight, else their older
 * important/ordinary choice (75 / 40), else the system preset. Presets are cached for a few seconds: the planner asks once per task.
 */
export function effectiveWeight(ctx: AccessContext, milestoneId: string): number {
  const preview = previewScope.getStore()?.weights?.[milestoneId];
  if (preview !== undefined) return preview;
  const goal = readGoalSettings(ctx, milestoneId);
  if (typeof goal?.weight === "number") return goal.weight;
  const chosen = goal?.importance ?? readSchedulePreferences(ctx)?.importance[milestoneId];
  if (chosen) return chosen === "important" ? 75 : 40;
  const cached = presetCache.get(ctx.workspaceId);
  const presets = cached && Date.now() - cached.at < 5_000 ? cached.value : importancePresets(ctx);
  if (!cached || cached.value !== presets) presetCache.set(ctx.workspaceId, { at: Date.now(), value: presets });
  return presets.get(milestoneId)?.weight ?? 50;
}

/** How far ahead a task's milestone may be due for its work to be scheduled; the worker backplans every approved milestone (`AUTO_BACKPLAN_HORIZON_DAYS`). */
export const TASK_LIBRARY_WINDOW_DAYS = 21;

/**
 * The task library (decided 2026-10-08): a task worked back from a milestone due more than three weeks out waits, unscheduled, until it
 * comes within the window. Returns the day it enters the schedule, or null when it is scheduled now — a task already started, one with
 * its own due day inside the window, or one whose milestone is due within it (or has no date).
 */
export function libraryUntil(ctx: AccessContext, order: { state: string; milestoneId: string; payload: unknown }, today: string): string | null {
  if (order.state !== "approved" || !(order.payload as { backplan?: unknown } | undefined)?.backplan) return null;
  const store = getStore();
  const deadline = readGoalSettings(ctx, order.milestoneId)?.confirmedDeadline
    ?? store.listMilestoneAnchors(ctx.workspaceId).find((anchor) => anchor.milestoneId === order.milestoneId)?.deadline;
  if (!deadline) return null;
  const opens = new Date(Date.parse(`${deadline}T12:00:00Z`) - TASK_LIBRARY_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const due = (order.payload as { dueDate?: string }).dueDate;
  if (opens <= today || (due && /^\d{4}-\d{2}-\d{2}$/.test(due) && due <= addDays(today, TASK_LIBRARY_WINDOW_DAYS))) return null;
  return opens;
}

/**
 * The person's answer to a milestone's reviewed risk (the `milestone_risk_review` ask), per milestone, for the review it answered
 * (`fingerprint`). A `schedule.` setting, so the answer is undoable. Only `accept` moves the schedule (the owner's decision of 2026-10-15:
 * a reviewed risk is put to the person first, never planned around silently).
 */
export const RISK_DECISIONS_SETTING = "schedule.riskDecisions";
export type RiskDecision = { fingerprint: string; how: "accept" | "extend" | "ignore"; at: string };
export function readRiskDecisions(ctx: AccessContext): Record<string, RiskDecision> {
  try { return JSON.parse(getStore().getSetting(ctx.workspaceId, RISK_DECISIONS_SETTING) ?? "{}") as Record<string, RiskDecision>; } catch { return {}; }
}

/** Days a milestone's reviewed risk asks its work to finish early: only once the person accepted that review; none otherwise. */
export const riskBufferOf = (ctx: AccessContext, milestoneId: string | undefined): number => {
  const stored = milestoneId ? parseMilestoneRisks(getStore().getSetting(ctx.workspaceId, MILESTONE_RISKS_SETTING))[milestoneId] : undefined;
  if (!stored || !("risks" in stored)) return 0;
  const decision = readRiskDecisions(ctx)[milestoneId!];
  return decision?.how === "accept" && decision.fingerprint === stored.fingerprint ? riskBufferDays(stored.risks) : 0;
};

/**
 * Milestones the forecast already finds short of time: the cautious (p85) finish the web records every six hours
 * (`milestone.forecast`, `recordMilestoneForecast`) lands less than two days before the deadline. Read here by key, since the module
 * that writes it imports this one. Their important work takes the day's best hours first (`PlannerTask.atRisk`, W-153).
 */
const FORECAST_SETTING = "milestone.forecast";
const RISK_SLACK_DAYS = 2;
export function forecastShortOf(ctx: AccessContext, milestoneId: string | undefined, deadline: string | undefined): boolean {
  if (!milestoneId || !deadline) return false;
  const goals = memoByLedger(getStore(), `forecast-finish:${ctx.workspaceId}`, 60_000, () => {
    try { return (JSON.parse(getStore().getSetting(ctx.workspaceId, FORECAST_SETTING) || "{}") as { goals?: Record<string, { p85Day?: string | null }> }).goals ?? {}; }
    catch { return {} as Record<string, { p85Day?: string | null }>; }
  });
  const finish = goals[milestoneId]?.p85Day;
  if (!finish || !/^\d{4}-\d{2}-\d{2}$/.test(finish)) return false;
  return (Date.parse(`${deadline}T12:00:00Z`) - Date.parse(`${finish}T12:00:00Z`)) / 86_400_000 < RISK_SLACK_DAYS;
}

/**
 * A milestone's deadline for scheduling: the one set on the goal, else — for an approved milestone — the date it was approved with,
 * which lives on its anchor. Approving a draft writes no goal setting, so the scheduler read every backplanned task of a fresh account
 * as having no deadline at all, ordered it by importance alone and left work due in a week unplaced (2026-10-18 walkthrough).
 */
export function milestoneDeadline(ctx: AccessContext, milestoneId: string): string | undefined {
  if (!milestoneId) return undefined;
  const confirmed = readGoalSettings(ctx, milestoneId)?.confirmedDeadline;
  if (confirmed) return confirmed;
  const day = approvedAnchorDays(ctx).get(milestoneId);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

/** Approved milestones' anchor dates, read once per ledger change: the planner asks for every task, and each read was two full scans. */
const anchorDaysCache = new WeakMap<object, { key: string; days: Map<string, string> }>();
function approvedAnchorDays(ctx: AccessContext): Map<string, string> {
  const store = getStore();
  const key = `${ctx.workspaceId}:${store.changeToken()}`;
  const cached = anchorDaysCache.get(store);
  if (cached?.key === key) return cached.days;
  const approved = new Set(store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "approved").map((milestone) => milestone.id));
  const days = new Map(store.listMilestoneAnchors(ctx.workspaceId).filter((anchor) => approved.has(anchor.milestoneId)).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  anchorDaysCache.set(store, { key, days });
  return days;
}

/** Milestone titles, read once per ledger change for every planner task. */
function milestoneTitleOf(ctx: AccessContext, milestoneId: string): string {
  return memoByLedger(getStore(), `milestone-titles:${ctx.workspaceId}`, 60_000,
    () => new Map(getStore().listMilestones(ctx.workspaceId).map((milestone) => [milestone.id, milestone.title]))).get(milestoneId) ?? "";
}
