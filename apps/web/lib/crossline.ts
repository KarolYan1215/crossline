import "server-only";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { approveArtifactRelationsFor, assistantAvailable, CrosslineStore, openNeedsOf, type EvidenceClaimInput, type StoredMilestone } from "@crossline/db";
import { availableSlots, deriveCapacity, requiredApproval, validateAvailability, DEFAULT_AVAILABILITY,
  defaultMilestoneTemplates, computeMilestoneConfidence, PRODUCTIVE, type ActivityCategory, validateSuccessCriteria, goalSettingKey, ANALYSIS_CONTEXT_VERSION, calibrationReport, calibratedEstimate,
  type CalibrationReport, presetImportance, sittingStartOn, taskTitleOf, type ImportancePreset, restoreTargetOf,
  type AccessContext, type AvailabilityWindow, type Estimate, type SuccessCriterion, type ChecklistAnswer, FIXED_EVENTS, fixedEventBlocks, type FixedEvent, readTravelState, travelBlocks,
  DELAY_SETTING, FROZEN_SETTING, SHIFT_MINUTES, parseFrozen, settleFrozen, shiftFrozen, withFrozen, withoutFrozen, type FrozenBlock, type RealityChange } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { forecastGoals, normalizeParams, paramsFor, planHeadDiffers, planSchedule, recommendNextActions, scheduleInputHash, type ForecastResult, type PlanResult,
  type ScheduleParams, type PlanningInput } from "@crossline/planner";
import { optimalFor, requestOptimal } from "./optimal-schedule";
import { seedExampleReadiness } from "./example-readiness";
import { energyCalibration, predictEnergyTransition, readTransitionOutcomes } from "./energy-learning";
import { energyModel, slotEnergy } from "./energy";
import { durationPriorFor } from "./estimate-calibration";
import type { DashboardAction, DashboardData } from "../app/dashboard-view";

export type PersistedScheduleBlock = {
  id: string;
  lane: "human" | "ai";
  title: string;
  /** A scheduled block's task and step, apart (the calendar draws the task as the title and the step under it). */
  task?: string;
  step?: string;
  /** Its standing in one or two words (暂定, 预排, 本周未排完…), drawn as a tag instead of a prefix in the title. */
  tag?: string;
  /** Absent on seeded examples: they illustrate a typical day rather than claiming a date. */
  day?: string;
  start: string;
  end: string;
  source: string;
  readOnly: boolean;
  /**
   * A scheduled block's energy (docs/energy-and-ecosystem.md §3): the slot's, the work's, and the share of an hour's work the plan
   * counted on there. The completion check records it, so the factors can be learned (`learnedEfficiency`).
   */
  energy?: { slot: "low" | "medium" | "high"; need: "low" | "medium" | "high"; efficiency: number };
  /** Where it happens (an event the person added, a synced calendar event): a physical place gets 「路上」 blocks around it. */
  location?: string;
};

/**
 * The local day the plan is centred on. One definition, so B, A and the sync cannot disagree.
 *
 * `ctx` is optional: this stays callable from places that only need a plausible "today" and have no
 * request context to hand (a pure date-format test, a default parameter). With `ctx`, "today" follows
 * the caller's own workspace time zone preference; without it, only the process-wide env var default.
 */
export function planToday(ctx?: AccessContext,
  now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()): string {
  return dayFormatter((ctx && readSchedulePreferences(ctx)?.timeZone) ?? process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago").format(now);
}

/**
 * Formatters are kept per zone (2026-10-26): building an `Intl.DateTimeFormat` costs far more than using one, and one page asked for
 * today's day several hundred times. A zone the runtime does not know throws on first use, as before, and is not kept.
 */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-CA", { timeZone }); dayFormatters.set(timeZone, formatter); }
  return formatter;
}
/** Zones already found valid; a stored zone is checked once per process instead of on every read of the preferences. */
const knownZones = new Set<string>();

/** The key the weekly availability lives under. One settings row, not a new table. */
export { AVAILABILITY_SETTING } from "@crossline/core";
import { FIRST_DRAFTS_SETTING, firstDraftsState, STEP_ENERGY_CEILING, learnedEfficiency, type EfficiencySample, type StepRole, AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, BYPRODUCT_LAG_DAYS, RELATION_KIND_LABEL, isCancelledEvent, resolveAvailability, hoursFromText, type AvailabilitySource, type PortraitReport } from "@crossline/core";
import { statedShares } from "./plan-stats";
import { milestonesBeingBackplanned } from "./backplan-status";
import { nearestDueProposal } from "./urgent-proposal";
import { completionRule, onPersonsBoard, proposalReady, type CompletionMode, type CompletionOutcome } from "@crossline/core";
import { MILESTONE_RISKS_SETTING, parseMilestoneRisks, riskBufferDays } from "@crossline/core";
import { identityLines, linePacks } from "./lines";
import { memoByLedger, memoByLedgerAsync } from "./ledger-memo";
import { localeFor, tOf } from "./locale";
import { intlLocale, tFor, type Locale } from "./i18n";
const PREFERENCES_SETTING = "schedule.preferences";
export type SchedulePreferences = { timeZone: string; mode: "buffered" | "asap";
  importance: Record<string, "important" | "ordinary">;
  /** The four packing numbers set on the plan page; absent, `mode` stands for its preset. */
  params?: ScheduleParams };

export type GoalSettings = {
  /** The older important/ordinary choice; absent when nobody chose one, so the system's preset weight keeps applying. */
  importance?: "important" | "ordinary";
  confirmedDeadline: string | null; sourceQuote: string | null;
  /** 0–100, set with the slider; `importance` follows it (60 and above is important). */
  weight?: number };
const goalKey = goalSettingKey;

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
      ...(typeof input.weight === "number" ? { presetWeight: importancePresets(ctx, { withHistory: false }).get(id)?.weight ?? null } : {}) } });
  return { ok: true };
}

/** At or above this weight a milestone counts as important (deadline tier 1 or 3). */
export const IMPORTANT_WEIGHT = 60;

/**
 * The system's suggested importance for every live milestone (`presetImportance`): its line's place in the person's order (hard
 * constraint, rank, or parallel), the relations through it, what is at stake, and how the person has moved this line's sliders before. Derived on read.
 */
export function importancePresets(ctx: AccessContext, options: { withHistory?: boolean } = {}): Map<string, ImportancePreset> {
  const store = getStore();
  const facts = store.listProfileFacts(ctx.workspaceId);
  const standing = new Map(linePacks(ctx).map((pack) => [pack.id, { rank: pack.rank ?? null, hard: Boolean(pack.hard) }]));
  const milestones = store.listMilestones(ctx.workspaceId).filter((item) => item.status !== "archived");
  const relations = store.listMilestoneRelations(ctx.workspaceId).filter((item) => item.status === "approved" || item.status === "candidate");
  const degree = (id: string) => relations.filter((item) => item.fromMilestoneId === id || item.toMilestoneId === id).length;
  const maxRelations = Math.max(0, ...milestones.map((item) => degree(item.id)));
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const graded = new Set(facts.filter((item) => item.slot === "grading" || item.slot === "target_grade").map((item) => item.projectId));
  const today = planToday(ctx);
  const lineOf = new Map(milestones.map((item) => [item.id, item.identityId]));
  const adjustments = new Map<string, Map<string, number>>();
  if (options.withHistory !== false) {
    for (const event of store.listEvents(ctx.workspaceId, { type: "goal.settings_confirmed" })) {
      const payload = event.payload as { next?: { weight?: number }; presetWeight?: number | null };
      const line = lineOf.get(event.entityId);
      if (!line || typeof payload.next?.weight !== "number" || typeof payload.presetWeight !== "number") continue;
      const own = adjustments.get(line) ?? new Map<string, number>();
      own.set(event.entityId, payload.next.weight - payload.presetWeight);
      adjustments.set(line, own);
    }
  }
  return new Map(milestones.map((item) => {
    const deadline = readGoalSettings(ctx, item.id)?.confirmedDeadline ?? anchors.get(item.id) ?? null;
    return [item.id, presetImportance({ standing: standing.get(item.identityId) ?? { rank: null, hard: false }, line: item.identityId, relations: degree(item.id), maxRelations,
      graded: Boolean(item.projectId && graded.has(item.projectId)),
      daysToDeadline: deadline ? Math.round((Date.parse(`${deadline}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) : null,
      pastAdjustments: [...(adjustments.get(item.identityId)?.values() ?? [])], locale: localeFor(ctx) })];
  }));
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

/** The packing numbers in effect: a previewed set, else the saved ones, else what the saved mode stands for. */
export function effectiveParams(ctx: AccessContext): ScheduleParams {
  return previewScope.getStore()?.params ?? paramsFor(effectiveSchedulePreferences(ctx).preferences);
}

/**
 * The zone the person's own device reports (2026-10-21): the hosted beta runs in Hong Kong with `CROSSLINE_TIME_ZONE=Asia/Shanghai`, so
 * without it every account that had not picked a zone was planned, reminded and shown on the server's clock — and saving any schedule
 * number copied that default into the saved preferences, where it stayed. The page reports `Intl`'s zone; when it differs from the one on
 * record it becomes `schedule.preferences.timeZone`, which every reader (the web's and the worker's) takes before the server's. The
 * device's zone, not one guessed from the IP address: a VPN, a proxy or the phone's mobile network moves an IP's apparent place, and the
 * device's own setting is what its clock shows.
 */
export function syncDeviceTimeZone(ctx: AccessContext, timeZone: unknown): { ok: true; changed: boolean } | { ok: false; code: string } {
  const zone = typeof timeZone === "string" ? timeZone.trim() : "";
  if (!zone || zone.length > 64) return { ok: false, code: "SCHEDULE_TIME_ZONE_INVALID" };
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); } catch { return { ok: false, code: "SCHEDULE_TIME_ZONE_INVALID" }; }
  const current = effectiveSchedulePreferences(ctx).preferences;
  if (current.timeZone === zone && readSchedulePreferences(ctx)) return { ok: true, changed: false };
  const store = getStore();
  store.setSetting(ctx.workspaceId, PREFERENCES_SETTING, JSON.stringify({ ...current, timeZone: zone } satisfies SchedulePreferences));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `schedule:time_zone:${randomUUID()}`,
    type: "schedule.time_zone_detected", entityId: ctx.workspaceId, payload: { previous: current.timeZone, next: zone } });
  return { ok: true, changed: current.timeZone !== zone };
}

export function saveScheduleParams(ctx: AccessContext, value: unknown): { ok: true } {
  const params = normalizeParams(value);
  const current = effectiveSchedulePreferences(ctx).preferences;
  const mode = params.gapMinutes === 0 && params.maxDailyShare >= 1 ? "asap" as const : "buffered" as const;
  const store = getStore();
  store.setSetting(ctx.workspaceId, PREFERENCES_SETTING, JSON.stringify({ ...current, mode, params } satisfies SchedulePreferences));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `schedule:params:${randomUUID()}`,
    type: "schedule.params_saved", entityId: ctx.workspaceId, payload: { previous: paramsFor(current), next: params } });
  return { ok: true };
}

export function readSchedulePreferences(ctx: AccessContext): SchedulePreferences | null {
  const raw = getStore().getSetting(ctx.workspaceId, PREFERENCES_SETTING);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SchedulePreferences;
    if (!knownZones.has(value.timeZone)) { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); knownZones.add(value.timeZone); }
    return value.mode === "buffered" || value.mode === "asap" ? value : null;
  } catch { return null; }
}

/**
 * The plan page used to show nothing at all — no availability editor, no AI lane, no forecast — until
 * this form was filled in, which stacked a mandatory setup screen onto a brand-new person's first
 * visit. The schedule the planner actually needs (a time zone, a mode, per-milestone importance) has a
 * sane default for every field; there is no reason a real preview has to wait on the person supplying
 * one by hand. `isDefault` says which case this is, so the page can offer the real setup form as an
 * unobtrusive invitation instead of a locked gate.
 */
export function effectiveSchedulePreferences(ctx: AccessContext): { preferences: SchedulePreferences; isDefault: boolean } {
  const saved = readSchedulePreferences(ctx);
  if (saved) return { preferences: saved, isDefault: false };
  return { preferences: { timeZone: process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago",
    mode: "buffered", importance: {} }, isDefault: true };
}

export function saveSchedulePreferences(ctx: AccessContext, input: {
  timeZone: unknown; mode: unknown; windows: unknown; importance: unknown
}): { ok: true } | { ok: false; code: string } {
  ensureSeeded(ctx);
  const timeZone = typeof input.timeZone === "string" ? input.timeZone.trim() : "";
  try { new Intl.DateTimeFormat("en", { timeZone }); }
  catch { return { ok: false, code: "SCHEDULE_TIME_ZONE_INVALID" }; }
  if (input.mode !== "buffered" && input.mode !== "asap")
    return { ok: false, code: "SCHEDULE_MODE_INVALID" };
  let windows: AvailabilityWindow[];
  try { windows = validateAvailability(input.windows); }
  catch (error) { return { ok: false, code: error instanceof Error ? error.message : "AVAILABILITY_INVALID" }; }
  if (!windows.length || windows.some((window) => !window.days.length))
    return { ok: false, code: "AVAILABILITY_INVALID" };
  const importance = input.importance;
  if (!importance || typeof importance !== "object" || Array.isArray(importance))
    return { ok: false, code: "SCHEDULE_IMPORTANCE_REQUIRED" };
  const approved = getStore().listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "approved");
  if (approved.some((milestone) => !["important", "ordinary"].includes(
    (importance as Record<string, string>)[milestone.id] ?? "")))
    return { ok: false, code: "SCHEDULE_IMPORTANCE_REQUIRED" };
  const selected = Object.fromEntries(approved.map((milestone) => [milestone.id,
    (importance as Record<string, "important" | "ordinary">)[milestone.id]!]));
  const store = getStore();
  store.setSetting(ctx.workspaceId, AVAILABILITY_SETTING, JSON.stringify(windows));
  const params = readSchedulePreferences(ctx)?.params;
  store.setSetting(ctx.workspaceId, PREFERENCES_SETTING, JSON.stringify({ timeZone, mode: input.mode,
    importance: selected, ...(params ? { params } : {}) } satisfies SchedulePreferences));
  for (const [id, importance] of Object.entries(selected)) {
    const goal = readGoalSettings(ctx, id);
    if (!goal || goal.importance === importance) continue;
    const next = { ...goal, importance };
    store.setSetting(ctx.workspaceId, goalKey(id), JSON.stringify(next));
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
      idempotencyKey: `goal:importance:${id}:${randomUUID()}`, type: "goal.settings_confirmed",
      entityId: id, payload: { previous: goal, next, source: "schedule_preferences" } });
  }
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `schedule:preferences:${randomUUID()}`, type: "schedule.preferences_saved",
    entityId: ctx.workspaceId, payload: { timeZone, mode: input.mode, milestoneCount: approved.length } });
  return { ok: true };
}

/**
 * When the person said they are free, as the scheduler needs it.
 *
 * In the ledger rather than an environment variable, because a backup that does not carry it restores
 * a plan that cannot be rebuilt. A stored value that no longer parses falls back to the default rather
 * than emptying the plan silently — an unreadable setting is a bug to fix, not a reason to show a
 * blank week as though the person had no time.
 */
export function readAvailability(ctx: AccessContext): AvailabilityWindow[] {
  const preview = previewScope.getStore()?.availability;
  if (preview) return preview;
  return resolvedAvailability(ctx).windows;
}

/** Setting for each line's share (percent) of the week, set on the plan page; when absent the interview's stated shares are used. */
export const LINE_SHARES_SETTING = "schedule.lineShares";

/** Each line's share of the week (percent): what the person set on the plan page, else what they said (`statedShares`), else none. */
export function readLineShares(ctx: AccessContext): Record<string, number> | null {
  const preview = previewScope.getStore()?.lineShares;
  if (preview) return preview;
  const store = getStore();
  try {
    const set = JSON.parse(store.getSetting(ctx.workspaceId, LINE_SHARES_SETTING) ?? "null") as Record<string, number> | null;
    if (set && Object.values(set).some((value) => value > 0)) return set;
  } catch { /* unreadable: fall back to what was said */ }
  let portrait: PortraitReport | undefined;
  try { portrait = (JSON.parse(store.getSetting(ctx.workspaceId, "portrait.report") ?? "{}") as { report?: PortraitReport }).report; } catch { /* none yet */ }
  // The portrait's suggested share (`targetShare`) over the one the person described (`share`): the owner chose on 2026-10-20 to plan
  // on the suggestion, which keeps the hard line as the calendar's base and gives each other line what it feeds back to it.
  const items = portrait?.lines?.items?.map((item) => ({ lineId: item.lineId, share: item.targetShare ?? item.share })) ?? null;
  return statedShares(items, store.listProfileFacts(ctx.workspaceId), hoursFromText);
}

/** Each line's share as the person set it: whole percents for known lines, together at most 100; `{}` goes back to what they said. */
export function saveLineShares(ctx: AccessContext, value: Record<string, number>): { ok: true } | { ok: false; code: string } {
  const lines = new Set(linePacks(ctx).filter((pack) => pack.kind === "identity").map((pack) => pack.id));
  const entries = Object.entries(value).filter(([line]) => lines.has(line)).map(([line, share]) => [line, Math.max(0, Math.min(100, Math.round(share)))] as const);
  if (entries.reduce((sum, [, share]) => sum + share, 0) > 100) return { ok: false, code: "LINE_SHARES_OVER_100" };
  getStore().setSetting(ctx.workspaceId, LINE_SHARES_SETTING, entries.length ? JSON.stringify(Object.fromEntries(entries)) : "");
  return { ok: true };
}

/** The pattern and where it came from (painted / the interview's proposal / the stated weekly hours / the default); see `resolveAvailability`. */
export function resolvedAvailability(ctx: AccessContext): { windows: AvailabilityWindow[]; source: AvailabilitySource } {
  const store = getStore();
  return resolveAvailability({ saved: store.getSetting(ctx.workspaceId, AVAILABILITY_SETTING),
    proposed: store.getSetting(ctx.workspaceId, AVAILABILITY_PROPOSED_SETTING), facts: store.listProfileFacts(ctx.workspaceId) });
}

export function saveAvailability(ctx: AccessContext, windows: unknown): { ok: true } | { ok: false; code: string } {
  try {
    const validated = validateAvailability(windows);
    getStore().setSetting(ctx.workspaceId, AVAILABILITY_SETTING, JSON.stringify(validated));
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error instanceof Error ? error.message : "AVAILABILITY_INVALID" };
  }
}

export type PersistedPlan = {
  id: string;
  version: number;
  blocks: PersistedScheduleBlock[];
  schedule: Pick<PlanResult, "status" | "blockers" | "solver" | "bufferRelaxed" | "notes"> & {
    /** The planner input's cache key and whether the blocks are the cached optimal plan (docs/loop-and-scout.md §2); absent in a preview. */
    inputHash?: string; optimal?: boolean };
  /** True when nobody has saved a real time zone/availability/mode yet and this is computed off
   * defaults — a real, honestly-labelled preview rather than an empty page. */
  usingDefaultPreferences: boolean;
};

// Shared with apps/web/lib/task-detail.ts, so a task/milestone detail view's relation labels and identity
// swatches never drift from what the homepage flywheel strip and star map already say.
export const relationKindLabel: Record<string, string> = RELATION_KIND_LABEL;
export const accents: Record<string, string> = {
  research: "#6D5EF5",
  startup: "#FF8A5B",
  media: "#E85D9E",
  investment: "#23A989"
};

/**
 * Which identities get seeded is decided by the installed packs, never by a fixed list. A hardcoded
 * list meant that swapping the packs seeded milestones for identities that no longer existed, and
 * `validateAnalysisContext` then refused every single analysis with `ANALYSIS_CONTEXT_INVALID`.
 */
const seedIdentities = () => defaultIdentityPacks().filter((pack) => pack.kind === "identity");

/* i18n-ignore-start: example content for the test board (person-written data, not interface) */
// Example content for the packs this repo happens to ship. Keyed by id, so an unknown identity falls
// back to a generic starter written from the pack's own label instead of being skipped.
const starterMilestoneTitles: Record<string, string> = {
  research: "稳定推进当前实验与论文",
  startup: "验证一个可付费的真实问题",
  media: "建立一次可复用的内容闭环",
  investment: "形成有证据的每周研究备忘录"
};

// `priorFamily` names which labelled prior in the identity pack this seed belongs to, so the estimate
// is read from `durationPriors` instead of being derived from a hand-written minute count.
type StarterWorkOrder = { title: string; energy: "low" | "medium" | "high"; priorFamily: string };
const starterWorkOrders: Record<string, StarterWorkOrder> = {
  research: { title: "梳理本周科研下一步", energy: "high", priorFamily: "deep_work" },
  startup: { title: "写下当前创业里程碑的一个可验证假设", energy: "medium", priorFamily: "preparation" },
  media: { title: "从本周工作中提取一个可公开选题", energy: "low", priorFamily: "review" },
  investment: { title: "整理当前美股与 ETF 关注清单", energy: "medium", priorFamily: "review" }
};
/* i18n-ignore-end */

// A prior is honest only when it really comes from the pack. Deriving p25/p85 from one hand-written
// number and labelling the result `identity_prior` was a fabricated interval wearing a real label.
function identityPrior(identityId: string, family: string) {
  const pack = defaultIdentityPacks().find((item) => item.id === identityId && item.kind === "identity");
  const prior = pack?.durationPriors[family] ?? pack?.durationPriors.review;
  return { ...(prior ?? { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 }),
    source: "identity_prior" as const, observationCount: 0, confidence: "low" as const };
}

declare global {
  // eslint-disable-next-line no-var
  var crosslineStore: CrosslineStore | undefined;
}

/** Where this installation keeps everything it owns: the ledger, and now the files people give it. */
export function dataDirectory(): string {
  return process.env.CROSSLINE_DATA_DIR
    ? path.resolve(process.env.CROSSLINE_DATA_DIR)
    : path.resolve(process.cwd(), "../../data");
}

export function getStore(): CrosslineStore {
  if (globalThis.crosslineStore) return globalThis.crosslineStore;
  const dataDir = dataDirectory();
  mkdirSync(dataDir, { recursive: true });
  globalThis.crosslineStore = new CrosslineStore(path.join(dataDir, "crossline.db"));
  return globalThis.crosslineStore;
}

export function ensureSeeded(ctx: AccessContext): void {
  const store = getStore();
  // Example milestones, relations and work orders exist only so the e2e suite and the unit tests have a board
  // to drive. A real account starts empty: its goals come from the interview, not from four placeholders that
  // every user shared and none of them chose.
  if (process.env.CROSSLINE_SEED_EXAMPLES === "1") {
    // The example board meets the start standard, or every page of the suites would lead back to the interview.
    seedExampleReadiness(store, ctx);
    // Earlier seeds wrote no projectId, and analysis only offers milestones that have one, so an existing
    // database would stay permanently unanalysable. Re-seeding is idempotent and repairs those rows.
    const seeded = store.listMilestones(ctx.workspaceId);
    if (seeded.length === 0 || seeded.some((milestone) => milestone.id.endsWith("-starter") && !milestone.projectId)) {
      for (const pack of seedIdentities()) {
        store.saveMilestone({
          id: `${pack.id}-starter`, ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
          identityId: pack.id, projectId: `${pack.id}-default`,
          title: starterMilestoneTitles[pack.id] ?? `为「${pack.label}」确定第一个可验收的里程碑`, // i18n-ignore: example data
          version: 1, status: "approved"
        });
      }
    }
    if (store.listMilestoneRelations(ctx.workspaceId).length === 0) {
      const relations = [
        ["research-startup", "research-starter", "startup-starter", "informs", "approved"],
        ["startup-media", "startup-starter", "media-starter", "reuses", "approved"],
        ["media-research", "media-starter", "research-starter", "recurring_feedback", "approved"],
        // Seeded id "research-investment" can never match the flywheel's own id scheme
        // (`flywheel:<from>-><to>:<kind>`), so a candidate here would be a permanent, un-fillable orphan
        // the review page could only ever show as unreviewable. Seeded approved, like the other three.
        ["research-investment", "research-starter", "investment-starter", "informs", "approved"]
      ] as const;
      // These example relations describe the four packs this repo ships. Under a different pack set
      // their endpoints do not exist, and a relation pointing at a missing milestone is worse than no
      // relation at all — so it is skipped rather than seeded dangling.
      const seededMilestoneIds = new Set(store.listMilestones(ctx.workspaceId).map((milestone) => milestone.id));
      for (const [id, fromMilestoneId, toMilestoneId, kind, status] of relations) {
        if (!seededMilestoneIds.has(fromMilestoneId) || !seededMilestoneIds.has(toMilestoneId)) continue;
        store.saveMilestoneRelation({ id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, fromMilestoneId, toMilestoneId, kind, status });
      }
    }
    if (store.listWorkOrders(ctx.workspaceId).length === 0) {
      for (const pack of seedIdentities()) {
        const identityId = pack.id;
        const { title, energy, priorFamily } = starterWorkOrders[identityId]
          ?? { title: `写下「${pack.label}」当前最该推进的一件事`, energy: "medium" as const, priorFamily: "review" }; // i18n-ignore: example data
        const id = `${identityId}-starter-work-order`;
        const milestoneId = store.listMilestones(ctx.workspaceId).find((item) => item.identityId === identityId)?.id ?? `${identityId}-unassigned`;
        store.saveWorkOrder({
          id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, identityId,
          projectId: `${identityId}-default`, milestoneId, intent: title,
          state: "ready_for_human", riskTier: "milestone",
          estimate: identityPrior(identityId, priorFamily),
          payload: { seeded: true, materialContract: [], evidenceContract: [{ kind: "record", required: true }],
            humanCore: [{ id: `${id}-core`, intent: title, energy, interruptible: true }] }
        });
      }
    }
  }
  if (store.listMilestoneTemplates(ctx.workspaceId).length === 0) {
    store.seedMilestoneTemplates(ctx.workspaceId, defaultMilestoneTemplates());
  }
  if (store.listPlanVersions(ctx.workspaceId).length === 0) {
    // An empty plan, not five example blocks. The lanes fill from two real sources now — the calendar
    // and the scheduler — and seeding a fake day meant the first thing a new database showed was a
    // schedule nobody had made, in a view whose whole job is to say what is really committed.
    store.savePlanVersion({
      id: "personal-plan-v1", ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
      version: 1, status: "current", payload: { blocks: [] }
    });
  }

  // A database seeded before the scheduler was wired up still holds the five example blocks; `loadCurrentPlan` no longer reads them.
  for (const plan of store.listPlanVersions(ctx.workspaceId)) {
    const blocks = (plan.payload as { blocks?: PersistedScheduleBlock[] }).blocks ?? [];
    const real = blocks.filter((block) => block.source !== "示例数据"); // i18n-ignore: a stored marker
    if (real.length === blocks.length) continue;
    store.savePlanVersion({ ...plan, payload: { blocks: real } });
  }
}

const FAMILIES = ["preparation", "review", "deep_work"] as const;
type Family = typeof FAMILIES[number];

export type ManualPromotionInput = {
  identityId: unknown; intent: unknown; milestoneId: unknown; family: unknown;
  estimate: unknown; evidenceContract: unknown;
};

/**
 * The manual fallback `docs/archive/crossline-plan-critical-review.md` §4 asked for and this app never built:
 * when Codex is unavailable, a capture can be promoted to a WorkOrder by hand instead of dying at
 * "分析服务不可用" with no other exit. Skips `awaiting_plan_approval` and lands directly on `approved` —
 * promoting it by hand already is the approval, so approving it again would be asking the same person
 * to confirm their own decision. `payload.manualPromotion` marks the result so nothing downstream
 * (Workbench, Approvals) mistakes it for an analysed proposal.
 */
export function promoteCaptureManually(ctx: AccessContext, captureId: string, input: ManualPromotionInput):
  { ok: true } | { ok: false; code: string } {
  ensureSeeded(ctx);
  const identityId = typeof input.identityId === "string" ? input.identityId : "";
  if (!seedIdentities().some((pack) => pack.id === identityId)) return { ok: false, code: "IDENTITY_UNKNOWN" };
  const intent = typeof input.intent === "string" ? input.intent.trim() : "";
  if (!intent || intent.length > 400) return { ok: false, code: "INTENT_INVALID" };
  // Empty is a legitimate answer, the same sentinel `acceptWorkOrderEvidence` already treats as
  // "not milestone-bound" — this is not a lesser WorkOrder, just one with no gate to pass.
  const milestoneId = typeof input.milestoneId === "string" ? input.milestoneId : "";
  if (milestoneId && !getStore().listMilestones(ctx.workspaceId).some((item) =>
    item.id === milestoneId && item.status === "approved" && item.identityId === identityId))
    return { ok: false, code: "MILESTONE_NOT_APPROVED" };
  const estimateInput = input.estimate as { p25Minutes?: unknown; p50Minutes?: unknown; p85Minutes?: unknown } | null;
  const p25 = Number(estimateInput?.p25Minutes), p50 = Number(estimateInput?.p50Minutes), p85 = Number(estimateInput?.p85Minutes);
  if (![p25, p50, p85].every(Number.isFinite) || p25 < 1 || p25 > p50 || p50 > p85 || p85 > 10080)
    return { ok: false, code: "ESTIMATE_INVALID" };
  const evidenceContract = (Array.isArray(input.evidenceContract) ? input.evidenceContract : [])
    .filter((item): item is { kind?: unknown; description?: unknown } => Boolean(item) && typeof item === "object")
    .map((item) => ({
      kind: (["file", "link", "telemetry"] as const).includes(item.kind as never) ? item.kind as "file" | "link" | "telemetry" : "record" as const,
      description: typeof item.description === "string" ? item.description.trim().slice(0, 300) : "",
      required: true
    }))
    .filter((item) => item.description.length > 0);
  if (!evidenceContract.length) return { ok: false, code: "EVIDENCE_CONTRACT_REQUIRED" };
  const family = typeof input.family === "string" && FAMILIES.includes(input.family as Family) ? input.family : undefined;
  const workOrderId = `manual-${randomUUID()}`;
  return getStore().promoteCaptureManually(ctx.workspaceId, captureId, {
    id: workOrderId, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, identityId,
    projectId: `${identityId}-default`, milestoneId, intent, state: "approved", riskTier: "routine",
    estimate: { p25Minutes: p25, p50Minutes: p50, p85Minutes: p85, source: "manual", observationCount: 0, confidence: "low" },
    payload: { manualPromotion: true, promotedBy: ctx.principalId, promotedAt: new Date().toISOString(),
      materialContract: [], evidenceContract, ...(family ? { family } : {}) }
  // A fresh key per call, not one fixed per capture: a form resubmission can legitimately carry
  // different content (the person fixing a typo after a rejection), and that must reach the store's own
  // `CAPTURE_ALREADY_PROMOTED` check rather than being silently swallowed as an idempotent no-op that
  // reports success while keeping whichever content happened to land first.
  }, `manual-promotion:${captureId}:${randomUUID()}`);
}

/** Days the plan covers: today plus the sync window, so the A lens and the scheduler agree. */
function planDays(today: string, days = Number(process.env.CROSSLINE_PLAN_WINDOW_DAYS ?? 7)): string[] {
  return Array.from({ length: days }, (_, offset) => {
    const date = new Date(`${today}T00:00:00`);
    date.setDate(date.getDate() + offset);
    return new Intl.DateTimeFormat("en-CA").format(date);
  });
}

/**
 * The work orders, placed into the time the calendar has not already taken.
 *
 * This is the first production caller `planSchedule` has ever had. Until now the AI lane was seed
 * data — example blocks that looked like a schedule and were computed from nothing — because no part
 * of the app knew when the person was free. Reading demo data as a commitment is the mistake the rest
 * of this codebase works to prevent, so the examples are gone and this is what replaces them.
 */
/**
 * The same local time in the same zone always gives the same instant (or the same refusal), and building a schedule asks for the same
 * few hundred again and again: kept, bounded (2026-10-26).
 */
const zonedInstants = new Map<string, string | Error>();
export function toZonedInstant(day: string, time: string, zone: string): string {
  const key = `${day} ${time} ${zone}`;
  let kept = zonedInstants.get(key);
  if (kept === undefined) {
    try { kept = computeZonedInstant(day, time, zone); } catch (error) { kept = error instanceof Error ? error : new Error(String(error)); }
    if (zonedInstants.size >= 20_000) zonedInstants.clear();
    zonedInstants.set(key, kept);
  }
  if (kept instanceof Error) throw kept;
  return kept;
}

function computeZonedInstant(day: string, time: string, zone: string): string {
  const instant = fromZonedTime(`${day}T${time}:00`, zone);
  const local = `${day} ${time}`;
  if (!Number.isFinite(instant.getTime()) || formatInTimeZone(instant, zone, "yyyy-MM-dd HH:mm") !== local) {
    throw new Error("AVAILABILITY_LOCAL_TIME_INVALID");
  }
  if ([30, 60, 90, 120].some((minutes) => [-1, 1].some((direction) =>
    formatInTimeZone(new Date(instant.getTime() + direction * minutes * 60_000), zone,
      "yyyy-MM-dd HH:mm") === local))) throw new Error("AVAILABILITY_LOCAL_TIME_AMBIGUOUS");
  return instant.toISOString();
}

/**
 * Block ids: `scheduled:<task>` for a task placed whole, `scheduled:<task>:<step>` for one of its steps, each with `:<n>` for its n-th
 * block when a piece is split. Everything that only needs the task reads segment 1, so step blocks need no change there. Step ids are
 * `v<version>s<n>` (packages/db `saveStepPlan`), which is what tells a step segment from a block index.
 */
const stepTaskId = (orderId: string, stepId: string) => `${orderId}#${stepId}`;
const STEP_ID = /^v\d+s\d+$/;
export function scheduledBlockId(plannerTaskId: string, index: number): string {
  const [orderId, stepId] = plannerTaskId.split("#");
  return `scheduled:${orderId}${stepId ? `:${stepId}` : ""}${index > 1 ? `:${index}` : ""}`;
}
/**
 * The schedule's frozen blocks (`schedule.frozen`, `packages/core/src/schedule-frozen.ts`): started, locked, kept by a local re-plan
 * or inside the commit window. The two settings it replaced (`schedule.pins` from starting a pencilled-in block, `schedule.keep` from
 * inserting an event) are taken over the first time they are seen and then deleted; their blocks had no segment number, so they
 * become segment 1 of their task or step, the only id that can be inferred.
 */
/** The app's notion of now: `CROSSLINE_FIXED_NOW` when pinned (tests, e2e), else the clock. */
export const appNow = () => process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();
const LEGACY_PINS = "schedule.pins";
const LEGACY_KEEP = "schedule.keep";
type LegacyPin = { taskId: string; day: string; start: string; end: string };
export function readFrozen(ctx: AccessContext, now: Date): FrozenBlock[] {
  const store = getStore();
  const pinsRaw = store.getSetting(ctx.workspaceId, LEGACY_PINS);
  const keepRaw = store.getSetting(ctx.workspaceId, LEGACY_KEEP);
  if (pinsRaw || keepRaw) {
    const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
    const instant = (pin: LegacyPin) => { try { return { start: toZonedInstant(pin.day, pin.start, zone), end: toZonedInstant(pin.day, pin.end, zone) }; } catch { return undefined; } };
    let list = parseFrozen(store.getSetting(ctx.workspaceId, FROZEN_SETTING), now);
    try { for (const pin of JSON.parse(pinsRaw ?? "[]") as LegacyPin[]) { const at = instant(pin); if (at) list = withFrozen(list, { blockId: scheduledBlockId(pin.taskId, 1), ...at, reason: "pinned" }); } } catch { /* unreadable: dropped */ }
    try {
      const kept = JSON.parse(keepRaw ?? "null") as { until?: string; blocks?: LegacyPin[] } | null;
      for (const pin of kept?.blocks ?? []) { const at = instant(pin); if (at && kept?.until) list = withFrozen(list, { blockId: scheduledBlockId(pin.taskId, 1), ...at, reason: "keep", until: kept.until }); }
    } catch { /* unreadable: dropped */ }
    writeFrozen(ctx, parseFrozen(JSON.stringify(list), now));
    store.deleteSetting(ctx.workspaceId, LEGACY_PINS);
    store.deleteSetting(ctx.workspaceId, LEGACY_KEEP);
  }
  const list = parseFrozen(store.getSetting(ctx.workspaceId, FROZEN_SETTING), now);
  // Inside an impact preview of 「改时间」: the held block as if already locked at its new time.
  const lock = previewScope.getStore()?.lock;
  if (!lock) return list;
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  try {
    return withFrozen(list, { blockId: lock.blockId.replace(/^optional:/, "scheduled:"), start: toZonedInstant(lock.day, lock.start, zone),
      end: toZonedInstant(lock.day, lock.end, zone), reason: "locked" });
  } catch { return list; }
}
export function writeFrozen(ctx: AccessContext, list: FrozenBlock[]): void {
  getStore().setSetting(ctx.workspaceId, FROZEN_SETTING, JSON.stringify(list));
}
/**
 * Local re-planning (decided 2026-10-08): when an event is added, the work blocks it does not touch stay where they were for a week
 * and only the ones it lands on move. A change that should re-plan everything (availability, packing numbers, importance, shares)
 * clears the kept blocks, never what the person started or locked.
 */
export function keepBlocks(ctx: AccessContext, blocks: Array<{ blockId: string; day: string; start: string; end: string }>, now: Date): void {
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const until = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  let list = readFrozen(ctx, now).filter((item) => item.reason !== "keep");
  for (const block of blocks) {
    try { if (!list.some((item) => item.blockId === block.blockId))
      list = withFrozen(list, { blockId: block.blockId, start: toZonedInstant(block.day, block.start, zone), end: toZonedInstant(block.day, block.end, zone), reason: "keep", until }); }
    catch { /* a clock change: not kept */ }
  }
  writeFrozen(ctx, list);
}
/** How soon before its start a scheduled block stops moving (docs/loop-and-scout.md §2, the commit window). */
export const COMMIT_WINDOW_MINUTES = 15;
/**
 * How long a work block's time stays held after it ends (the owner, 2026-10-26: 「时间已过有可能是这项任务还在做，过 1h 重排」): until then
 * its work is not placed again; after it, the work is re-planned and the block stays on its day as 「未完成」 until 04:00 the next morning
 * (`missedItems` in `lib/timeline.ts`).
 */
export const COMMIT_GRACE_MINUTES = 60;
/**
 * The commit window: a work block under way or starting within fifteen minutes keeps its time until an hour after it ends, so the
 * background optimal plan landing a minute later never moves what the person is about to start, and work running over is not moved
 * away while it is being done. A block already started or locked keeps that reason. Writes only when something new enters the window.
 */
export function commitSoon(ctx: AccessContext, blocks: Array<{ id: string; day?: string; start: string; end: string }>, now: Date): number {
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  let list = readFrozen(ctx, now);
  let added = 0;
  for (const block of blocks) {
    if (!block.id.startsWith("scheduled:") || !block.day || list.some((item) => item.blockId === block.id)) continue;
    let start: string, end: string;
    try { start = toZonedInstant(block.day, block.start, zone); end = toZonedInstant(block.day, block.end, zone); } catch { continue; }
    if (Date.parse(start) - now.getTime() > COMMIT_WINDOW_MINUTES * 60_000 || Date.parse(end) <= now.getTime()) continue;
    list = withFrozen(list, { blockId: block.id, start, end, reason: "commit", until: new Date(Date.parse(end) + COMMIT_GRACE_MINUTES * 60_000).toISOString() });
    added += 1;
  }
  if (added) writeFrozen(ctx, list);
  return added;
}
/**
 * 「后面都推 10 分钟」 (`schedule.shift`, docs/energy-and-ecosystem.md §6): today's committed and kept blocks move later by `minutes`
 * (`shiftFrozen`; started and locked ones stay), and the time from now until `now + minutes` is busy (`schedule.delayUntil`, read by
 * `planningInputFor`), so the rest of the day is re-planned to start after it. Both are `schedule.` settings, so the input box's undo
 * restores them.
 */
export function shiftToday(ctx: AccessContext, minutes: number, now = appNow()): { ok: true; message: string } | { ok: false; code: string } {
  if (!Number.isInteger(minutes) || minutes < SHIFT_MINUTES.min || minutes > SHIFT_MINUTES.max) return { ok: false, code: "SHIFT_MINUTES_INVALID" };
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const today = formatInTimeZone(now, zone, "yyyy-MM-dd");
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const before = readFrozen(ctx, now);
  const after = shiftFrozen(before, minutes, now, new Date(toZonedInstant(tomorrow, "00:00", zone)));
  if (JSON.stringify(after) !== JSON.stringify(before)) writeFrozen(ctx, after);
  // Two shifts in a row add up: the second starts from the end of the first.
  const current = Date.parse(getStore().getSetting(ctx.workspaceId, DELAY_SETTING) ?? "") || 0;
  getStore().setSetting(ctx.workspaceId, DELAY_SETTING, new Date(Math.max(current, now.getTime()) + minutes * 60_000).toISOString());
  const held = after.filter((item) => (item.reason === "pinned" || item.reason === "locked") && Date.parse(item.end) > now.getTime()
    && formatInTimeZone(new Date(item.start), zone, "yyyy-MM-dd") === today).length;
  const t = tOf(ctx);
  return { ok: true, message: held ? t("今天之后的安排顺延 {{minutes}} 分钟，已锁定的 {{count}} 块不动", { minutes, count: held })
    : t("今天之后的安排顺延 {{minutes}} 分钟", { minutes }) };
}
/** The stretch `schedule.shift` holds from now on, as a busy block of today in the person's clock; undefined once it has passed. */
function delayBlock(ctx: AccessContext, now: Date, zone: string): { day: string; start: string; end: string } | undefined {
  const until = Date.parse(getStore().getSetting(ctx.workspaceId, DELAY_SETTING) ?? "");
  if (!until || until <= now.getTime()) return undefined;
  const day = formatInTimeZone(now, zone, "yyyy-MM-dd");
  const end = formatInTimeZone(new Date(until), zone, "yyyy-MM-dd") === day ? formatInTimeZone(new Date(until), zone, "HH:mm") : "23:59";
  const start = formatInTimeZone(now, zone, "HH:mm");
  return end > start ? { day, start, end } : undefined;
}
export function clearKept(ctx: AccessContext, now = appNow()): void {
  writeFrozen(ctx, readFrozen(ctx, now).filter((item) => item.reason !== "keep"));
}

/**
 * Locks one block at a time (docs/loop-and-scout.md §1): started (`pinned`) or locked by the button (`locked`). A pencilled-in block
 * (`optional:`) becomes the same-numbered `scheduled:` block. The planner freezes that segment only; the task's others are still placed.
 */
export function lockBlock(ctx: AccessContext, blockId: string, at: { day: string; start: string; end: string },
  reason: "pinned" | "locked" = "pinned", options: { overlapOk?: boolean } = {}): { ok: true } | { ok: false; code: string } {
  if (!/^(scheduled|optional):/.test(blockId) || !/^\d{4}-\d{2}-\d{2}$/.test(at.day) || !/^\d{2}:\d{2}$/.test(at.start) || !/^\d{2}:\d{2}$/.test(at.end) || at.end <= at.start)
    return { ok: false, code: "PIN_INVALID" };
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  let start: string, end: string;
  try { start = toZonedInstant(at.day, at.start, zone); end = toZonedInstant(at.day, at.end, zone); } catch { return { ok: false, code: "PIN_INVALID" }; }
  const id = blockId.replace(/^optional:/, "scheduled:");
  writeFrozen(ctx, withFrozen(readFrozen(ctx, appNow()), { blockId: id, start, end, reason, ...(options.overlapOk ? { overlapOk: true } : {}) }));
  return { ok: true };
}
/**
 * Held blocks (started or locked) in the way of something without the person's acceptance (`settleFrozen`): a calendar event, a file's
 * class meeting, an event the person added, or another held block. One entry per held block, with what it overlaps, for the
 * `locked_conflict` ask.
 */
export function heldConflicts(ctx: AccessContext, now = appNow()): Array<{ entry: FrozenBlock; title: string }> {
  const store = getStore();
  const stored = store.listPlanVersions(ctx.workspaceId)[0];
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const blocks = stored ? committedBlocks(ctx, stored.payload).filter((block) => block.day && !block.id.startsWith("scheduled:")) : [];
  const busy = blocks.flatMap((block) => { try {
    return [{ id: block.id, start: Date.parse(toZonedInstant(block.day!, block.start, zone)), end: Date.parse(toZonedInstant(block.day!, block.end === "24:00" ? "23:59" : block.end, zone)) }];
  } catch { return []; } });
  const titles = new Map(blocks.map((block) => [block.id, block.title]));
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const frozen = readFrozen(ctx, now);
  const seen = new Set<string>();
  return settleFrozen(frozen, busy).conflicts.flatMap((conflict) => {
    const entry = frozen.find((item) => item.blockId === conflict.blockId);
    if (!entry || seen.has(conflict.blockId)) return [];
    seen.add(conflict.blockId);
    const other = conflict.kind === "frozen" ? orders.get(plannerIdOfBlock(conflict.with).split("#")[0]!) : undefined;
    return [{ entry, title: conflict.kind === "busy" ? titles.get(conflict.with) ?? "" : other ? taskTitleOf(other) : "" }];
  });
}
export function unlockBlock(ctx: AccessContext, blockId: string): { ok: true } {
  writeFrozen(ctx, withoutFrozen(readFrozen(ctx, appNow()), blockId.replace(/^optional:/, "scheduled:")));
  return { ok: true };
}

/**
 * The stretches between 07:00 and 23:00 outside the person's availability: where a task that did not fit may be pencilled in. Marked
 * high energy so the energy gate does not keep work out of them — whether to work then at all is the person's call, made by starting it.
 */
function offHoursWindows(windows: AvailabilityWindow[]): AvailabilityWindow[] {
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const minutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  return [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => {
    const covered = windows.filter((window) => window.days.includes(weekday))
      .map((window) => [minutes(window.start), Math.min(minutes(window.end) || 1440, 1440)] as const).sort((a, b) => a[0] - b[0]);
    // A day with no hours at all is a day off: overflow is pencilled around working days, not into the rest day (it put nine hours on a
    // Sunday the person keeps free, 2026-10-18 walkthrough, W-48).
    if (!covered.length) return [];
    const out: AvailabilityWindow[] = [];
    let cursor = 7 * 60;
    for (const [from, to] of covered) {
      if (from > cursor) out.push({ days: [weekday], start: clock(cursor), end: clock(Math.min(from, 23 * 60)), energy: "high" });
      cursor = Math.max(cursor, to);
      if (cursor >= 23 * 60) break;
    }
    if (cursor < 23 * 60) out.push({ days: [weekday], start: clock(cursor), end: "23:00", energy: "high" });
    return out.filter((window) => window.start < window.end);
  });
}

export function plannerIdOfBlock(blockId: string): string {
  const parts = blockId.split(":");
  return parts[2] && STEP_ID.test(parts[2]) ? stepTaskId(parts[1]!, parts[2]) : parts[1]!;
}

/**
 * What a preview changes without writing anything: a task's (or one step's, keyed `<order>#<step>`) usual minutes and a task's due
 * date. Read by `plannerTaskOf` and `plannerItemsFor` inside `withPreview`, so the schedule and the forecast are recomputed with the
 * change and compared with the real ones (`lib/impact.ts`). Async-local, so a preview never leaks into another request.
 */
export type PreviewOverrides = { estimates?: Record<string, number>; dueDates?: Record<string, string>; notBefore?: Record<string, string>;
  /** The plan page's own controls: a repainted week, other packing numbers, a moved importance slider (by milestone id). */
  availability?: AvailabilityWindow[]; params?: ScheduleParams; weights?: Record<string, number>; lineShares?: Record<string, number>;
  /** The energy of the slot the person is in, as if they had just said it (the energy question's value-of-information gate). */
  currentEnergy?: "low" | "medium" | "high";
  /** A held block as if moved to this time on the day panel (`move_block`), in the person's zone. */
  lock?: { blockId: string; day: string; start: string; end: string } };
const previewScope = new AsyncLocalStorage<PreviewOverrides>();
export const withPreview = <T>(overrides: PreviewOverrides, run: () => T): T => previewScope.run(overrides, run);
/** Inside an impact preview nothing is written, a change summary included. */
const inPreview = () => previewScope.getStore() !== undefined;
const scaledEstimate = <E extends { p25Minutes: number; p50Minutes: number; p85Minutes: number }>(estimate: E, p50: number | undefined): E =>
  p50 === undefined || p50 <= 0 ? estimate : { ...estimate, p50Minutes: Math.round(p50), p25Minutes: Math.max(1, Math.round(estimate.p25Minutes * p50 / Math.max(1, estimate.p50Minutes))),
    p85Minutes: Math.max(Math.round(p50), Math.round(estimate.p85Minutes * p50 / Math.max(1, estimate.p50Minutes))) };

const ENERGY_RANK = { low: 1, medium: 2, high: 3 } as const;

/**
 * The planner's input for a set of orders. A task with a step plan is placed step by step: each open, schedulable step is its own
 * planner task, keeping the task's tier, deadline and release, the step's own window, and its dependencies (on earlier steps, and for
 * its first steps on the work the task itself waits for). A task without a plan yet is placed whole, as before.
 */
function plannerItemsFor(ctx: AccessContext, orders: ActionableOrder[], { hold = true }: { hold?: boolean } = {}) {
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const overrides = previewScope.getStore()?.estimates ?? {};
  const stepPlans = new Map(getStore().listStepPlans(ctx.workspaceId).map((plan) => [plan.workOrderId, plan]));
  const openSteps = (orderId: string) => stepPlans.get(orderId)?.steps.filter((step) => step.status === "planned" && step.schedulable) ?? [];
  // A step that uses material nobody has supplied yet, or comes after an unfinished wait (a reply, data from someone else), takes no
  // calendar time until it arrives, and neither does anything after it (2026-10-28: 「完成 ECE 555 作业 3」 waited for its problem set and
  // still held three morning hours; the NeuroSim task's checking steps filled an afternoon behind 「等待实测数据回传」, because a wait step
  // is not on the calendar and so was dropped as a dependency). The forecast (`hold: false`) still counts the work.
  const waitingOnMaterial = (orderId: string) => {
    const plan = stepPlans.get(orderId);
    const blocked = new Set(hold ? plan?.steps.filter((step) => step.status === "planned" && (step.role === "wait" || openNeedsOf(plan, step).length))
      .map((step) => step.id) ?? [] : []);
    for (let grew = blocked.size > 0; grew;) {
      grew = false;
      for (const step of plan!.steps) if (!blocked.has(step.id) && step.dependsOn.some((dep) => blocked.has(dep))) { blocked.add(step.id); grew = true; }
    }
    return blocked;
  };
  const allOpenSteps = openSteps;
  const readySteps = (orderId: string) => { const blocked = waitingOnMaterial(orderId); return allOpenSteps(orderId).filter((step) => !blocked.has(step.id)); };
  const plannerIdsOf = (orderId: string) => { const steps = readySteps(orderId); return steps.length ? steps.map((step) => stepTaskId(orderId, step.id)) : [orderId]; };
  const localToday = formatInTimeZone(process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date(), zone, "yyyy-MM-dd");
  return orders.flatMap((order) => {
    const base = plannerTaskOf(ctx, order);
    const steps = readySteps(order.id);
    // Only a task with no step plan is placed whole. One whose plan has nothing of the person's left to place (every step done, or only the
    // assistant's or a wait still open) takes no time: it was placed whole again, at the task's own estimate, every day — the month
    // simulation saw a task with all eight steps done get a block a day for three weeks once its last step, a wait, was answered.
    if (!steps.length) return allOpenSteps(order.id).length || stepPlans.get(order.id)?.steps.length ? []
      : [{ task: base, orderId: order.id, title: base.title, step: undefined as string | undefined }];
    const open = new Set(steps.map((step) => step.id));
    const external = (base.dependsOn ?? []).flatMap((id) => plannerIdsOf(id));
    return steps.map((step) => {
      const internal = step.dependsOn.filter((dep) => open.has(dep)).map((dep) => stepTaskId(order.id, dep));
      const stepStart = step.notBefore ? toZonedInstant(step.notBefore, "00:00", zone) : undefined;
      // A step's own day is pacing inside the task, not a deadline of its own: from that day on the task's deadline governs. Kept as
      // a hard limit, a homework whose steps slipped became unplaceable the evening before it was due — one step was still "due
      // tonight" with tonight's hours already gone, and every later step waited on it.
      const stepDue = step.dueBy && step.dueBy > localToday ? toZonedInstant(step.dueBy, "23:59", zone) : undefined;
      const notBefore = [base.notBefore, stepStart].filter(Boolean).sort().at(-1);
      const deadline = [base.deadline, stepDue].filter(Boolean).sort()[0];
      const { notBefore: _n, deadline: _d, dependsOn: _deps, energy: taskEnergy, ...rest } = base;
      // The lower of the task's energy and what this kind of step needs: handing in or reading through takes no high-energy hour.
      const ceiling = STEP_ENERGY_CEILING[step.role as StepRole];
      const energy = taskEnergy && ceiling && ENERGY_RANK[ceiling] < ENERGY_RANK[taskEnergy] ? ceiling : taskEnergy;
      const id = stepTaskId(order.id, step.id);
      // The task's short name: its description reached the plan page's notes and blockers as a whole paragraph (2026-10-18 walkthrough).
      return { orderId: order.id, title: `${taskTitleOf(order)} · ${step.title}`, step: step.title as string | undefined, task: { ...rest, id,
        title: `${taskTitleOf(order)} · ${step.title}`, estimate: scaledEstimate({ ...base.estimate, ...step.estimate }, overrides[id]),
        ...(energy ? { energy } : {}), ...(notBefore ? { notBefore } : {}), ...(deadline ? { deadline } : {}),
        ...(internal.length || external.length ? { dependsOn: internal.length ? internal : external } : {}) } };
    });
  });
}

/**
 * The person's own yield in slots short of the work's energy, from the blocks they confirmed (`block.confirmed` carries the block's
 * energy since 2026-10-14), or undefined while the assumed 0.8 and 0.65 predict as well. Blocks that produced nothing go in as
 * `done: false` — answered 「未执行」, or seen under way on a past day (`nudge.blocks:<day>`) with no timer that day and no answer — and
 * `learnedEfficiency` counts them only when its backtest favours that (2026-10-20).
 */
export function personalEfficiency(ctx: AccessContext, now = new Date()): [number, number] | undefined {
  type Energy = { slot: "low" | "medium" | "high"; need: "low" | "medium" | "high"; efficiency: number };
  type Confirmed = { blockId?: string; day?: string; outcome?: string; minutes?: number; blockMinutes?: number; energy?: Energy };
  const store = getStore();
  const confirmed = store.listEvents(ctx.workspaceId, { type: "block.confirmed" });
  const samples: EfficiencySample[] = confirmed.flatMap((event) => {
    const payload = event.payload as Confirmed;
    if (!payload.energy || !payload.blockMinutes) return [];
    const base = { at: event.createdAt, slot: payload.energy.slot, need: payload.energy.need, planned: payload.energy.efficiency, blockMinutes: payload.blockMinutes };
    if (payload.outcome === "not_done") return [{ ...base, minutes: 0, done: false }];
    return payload.minutes ? [{ ...base, minutes: payload.minutes }] : [];
  });
  const answered = new Set(confirmed.map((event) => { const payload = event.payload as Confirmed; return `${payload.blockId}|${payload.day}`; }));
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const startedOn = new Set(store.listExecutions(ctx.workspaceId).map((execution) => `${execution.workOrderId}|${formatInTimeZone(new Date(execution.startedAt), zone, "yyyy-MM-dd")}`));
  const today = planToday(ctx, now);
  for (let back = 1; back <= MISSED_LOOKBACK_DAYS; back += 1) {
    const day = new Date(Date.parse(`${today}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    let seen: Record<string, { id: string; orderId: string; start: string; end: string; began?: boolean; energy?: Energy }> = {};
    try { seen = JSON.parse(store.getSetting(ctx.workspaceId, `nudge.blocks:${day}`) ?? "{}"); } catch { continue; }
    for (const block of Object.values(seen)) {
      if (!block.began || !block.energy || answered.has(`${block.id}|${day}`) || startedOn.has(`${block.orderId}|${day}`)) continue;
      const [sh, sm] = block.start.split(":").map(Number), [eh, em] = block.end.split(":").map(Number);
      const blockMinutes = ((eh ?? 0) * 60 + (em ?? 0)) - ((sh ?? 0) * 60 + (sm ?? 0));
      if (blockMinutes > 0) samples.push({ at: toZonedInstant(day, block.end, zone), slot: block.energy.slot, need: block.energy.need,
        planned: block.energy.efficiency, blockMinutes, minutes: 0, done: false });
    }
  }
  return learnedEfficiency(samples);
}
/** How far back the blocks seen under way are read for ones that went by unused. */
const MISSED_LOOKBACK_DAYS = 28;

/**
 * Everything the scheduler is given for the person's week, built once: the planner input itself plus the pieces `scheduledBlocks`
 * needs afterwards to name, tag and extend the result. Pulled out so the cache key and the bench script read the same input.
 */
export function planningInputFor(ctx: AccessContext, today: string, committed: PersistedScheduleBlock[]) {
  const days = planDays(today);
  const preferences = effectiveSchedulePreferences(ctx).preferences;
  const zone = preferences.timeZone;
  const iso = (day: string, time: string) => toZonedInstant(day, time, zone);
  const now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();
  // 「后面都推 10 分钟」 holds the time from now until then (`shiftToday`).
  const delay = delayBlock(ctx, now, zone);
  const busy = [...committed.filter((block) => block.day)
    .map((block) => ({ day: block.day!, start: block.start, end: block.end })), ...(delay ? [delay] : [])];
  const slots = availableSlots(readAvailability(ctx), days, busy);
  const capacity = latestCapacity(ctx, now);
  const currentEnergy = previewScope.getStore()?.currentEnergy ?? (capacity.basis.includes("self_report") && capacity.level !== "uncalibrated"
    ? capacity.level : undefined);
  const currentClock = formatInTimeZone(now, zone, "HH:mm");
  const currentSlot = slots.findIndex((slot) => slot.day === today && slot.end > currentClock);
  const clockBlockers: PlanResult["blockers"] = [];
  // The energy expected in each slot: the person's word for the slot they are in, the model's for the rest when it is sure enough,
  // the pattern's otherwise (docs/one-input.md §5).
  const model = energyModel(ctx, readAvailability(ctx));
  // A tired day (sleep debt, a heart-rate reading off the person's baseline) holds today's work without a deadline below its share.
  const dayCapacity = model.capacity(now.toISOString(), today);
  const instants = slots.flatMap((slot, index) => {
    try { const start = iso(slot.day, slot.start); return [{ start, end: iso(slot.day, slot.end),
      day: slot.day, energy: currentEnergy && index === currentSlot ? currentEnergy : slotEnergy(model, String(start), slot.energy) }]; }
    catch (error) {
      clockBlockers.push({ taskId: "availability", code: error instanceof Error ? error.message : "AVAILABILITY_LOCAL_TIME_INVALID",
        message: tOf(ctx)("{{day}} {{start}}–{{end}} 跨越时钟调整，请修改这段可用时间", { day: slot.day, start: slot.start, end: slot.end }) });
      return [];
    }
  });
  const capacityIds = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const allOrders = getStore().listWorkOrders(ctx.workspaceId);
  const orders = withoutShadowingDemos(allOrders, capacityIds)
    .filter((order) => ACTIONABLE.includes(order.state) && !capacityIds.has(order.identityId));
  const stateById = new Map(allOrders.map((order) => [order.id, order.state]));
  const dependencyBlockers = orders.filter((order) => (plannerTaskOf(ctx, order).dependsOn ?? [])
    .some((id) => stateById.get(id) !== "accepted" && !orders.some((item) => item.id === id)))
    .map((order) => ({ taskId: order.id, code: "DEPENDENCY_NOT_READY",
      message: tOf(ctx)("{{title}}的前置作业尚未验收，暂不排入", { title: order.intent }) }));
  // Each line's share of the week: what the person set, else what they said in the interview. A line with a share also offers its
  // library work (milestone due beyond the window) as floor-only, so a far deadline no longer means no hours at all.
  const shares = readLineShares(ctx);
  const library = new Set(orders.filter((order) => libraryUntil(ctx, order, today) && (shares?.[order.identityId] ?? 0) > 0).map((order) => order.id));
  const eligibleOrders = orders.filter((order) => !dependencyBlockers.some((item) => item.taskId === order.id) && (!libraryUntil(ctx, order, today) || library.has(order.id)));
  const needsLookahead = eligibleOrders.some((order) => {
    const task = plannerTaskOf(ctx, order);
    return task.deadlineTier === 4 && Boolean(task.deadline);
  });
  const lookaheadAvailability = needsLookahead ? availableSlots(readAvailability(ctx), planDays(today, 56), busy)
    .flatMap((slot) => {
      try { return [{ start: iso(slot.day, slot.start), end: iso(slot.day, slot.end),
        day: slot.day, energy: slot.energy }]; }
      catch { return []; }
    }) : undefined;

  const expanded = plannerItemsFor(ctx, eligibleOrders);
  // Frozen blocks of work still open. One that a hard constraint now lands on moves if it was only kept or inside the commit window;
  // one the person started or locked stays (they are asked about it, `locked_conflict`), unless they already accepted the overlap.
  // Kept or committed blocks that land on each other or on a held block are let go as well, and a lock older than the task's deferral
  // (`notBefore`) lapses; a block the person started stays whatever happened since (`settleFrozen`).
  const busyInstants = busy.flatMap((block, index) => { try { return [{ id: `busy:${index}`, start: Date.parse(iso(block.day, block.start)), end: Date.parse(iso(block.day, block.end)) }]; } catch { return []; } });
  const releaseAt = new Map(expanded.flatMap((entry) => entry.task.notBefore ? [[entry.task.id, Date.parse(entry.task.notBefore)] as const] : []));
  const frozen = settleFrozen(readFrozen(ctx, now).filter((item) => expanded.some((entry) => entry.task.id === plannerIdOfBlock(item.blockId))),
    busyInstants, (blockId) => releaseAt.get(plannerIdOfBlock(blockId))).kept;
  const pinned = frozen.map((item) => ({ taskId: plannerIdOfBlock(item.blockId), start: item.start, end: item.end }));
  const efficiency = personalEfficiency(ctx, now);
  const input: PlanningInput = { locale: localeFor(ctx),
    now,
    horizonDays: days.length,
    mode: preferences.mode, params: effectiveParams(ctx),
    ...(currentEnergy ? { currentEnergy, currentDay: today } : {}),
    tasks: expanded.map((item) => library.has(item.orderId)
      ? (({ deadline: _d, ...task }) => ({ ...task, deadlineTier: 3 as const, floorOnly: true }))(item.task) : item.task),
    ...(shares ? { lineShares: shares } : {}),
    ...(dayCapacity.multiplier < 1 ? { capacityByDay: { [today]: dayCapacity.multiplier } } : {}),
    ...(efficiency ? { efficiency } : {}),
    availability: instants,
    ...(lookaheadAvailability ? { lookaheadAvailability } : {}),
    frozenBlocks: [...committed.filter((block) => block.day && block.id.startsWith("scheduled:"))
      .map((block) => ({ taskId: plannerIdOfBlock(block.id), start: iso(block.day!, block.start),
        end: iso(block.day!, block.end) })), ...pinned]
  };
  return { input, days, busy, preferences, zone, iso, now, currentEnergy, dayCapacity, clockBlockers, instants, capacityIds, allOrders, orders,
    stateById, dependencyBlockers, library, expanded, frozen, pinned };
}

/**
 * The cache key of this planning input: everything but `now`, with the slot the person is in and their self-reported energy standing
 * in for it (`scheduleInputHash`), so time passing inside a slot keeps the optimal plan and crossing into the next one solves again.
 */
export function scheduleHashOf(input: PlanningInput, instants: Array<{ start: string; end: string }>, currentEnergy?: string): string {
  const slot = instants.find((item) => Date.parse(item.end) > input.now.getTime());
  return scheduleInputHash(input, `${slot?.start ?? ""}|${currentEnergy ?? ""}`);
}

async function scheduledBlocks(ctx: AccessContext, today: string, committed: PersistedScheduleBlock[]): Promise<{
  blocks: PersistedScheduleBlock[]; schedule: PersistedPlan["schedule"]
}> {
  const { input, days, busy, preferences, zone, iso, now, currentEnergy, clockBlockers, instants, capacityIds, allOrders, orders,
    stateById, dependencyBlockers, library, expanded, frozen, pinned } = planningInputFor(ctx, today, committed);
  // The page gets the greedy plan at once; the optimal one is solved in the background and used once cached (docs/loop-and-scout.md
  // §2). A preview neither reads nor asks for it: it must show what the change does to the plan the person has, at once.
  const greedy = await planSchedule(input, { solver: "none" });
  const hash = scheduleHashOf(input, instants, currentEnergy);
  const cached = inPreview() ? undefined : optimalFor(ctx, hash);
  if (!cached && !inPreview()) requestOptimal(ctx, input, hash);
  const result = cached ? { ...cached.result, plan: { blocks: cached.result.plan.blocks.filter((block) => Date.parse(block.end) > now.getTime()) } } : greedy;
  const placed = result.plan.blocks.filter((block) => !block.frozen);
  const orderStates = new Map(orders.map((order) => [order.id, order.state]));
  const itemById = new Map(expanded.map((item) => [item.task.id, item]));
  const intents = new Map(orders.map((order) => [order.id, taskTitleOf(order)]));
  const tentative = (taskId: string) => ["approved", "preparing"].includes(orderStates.get(taskId.split("#")[0]!) ?? "");
  const named = (taskId: string) => { const item = itemById.get(taskId); return { title: item?.title ?? taskId, task: intents.get(item?.orderId ?? "") ?? item?.title ?? taskId,
    ...(item?.step ? { step: item.step } : {}) }; };
  const energyNeeds = new Map(orders.map((order) => [order.id, humanCoreOf(order)?.energy]));
  // A new segment never takes an id a frozen block holds: the frozen one keeps its id and its time.
  const frozenIds = new Set(frozen.map((item) => item.blockId));
  const occurrences = new Map<string, number>();
  const nextIndex = (taskId: string) => {
    let index = (occurrences.get(taskId) ?? 0) + 1;
    while (frozenIds.has(scheduledBlockId(taskId, index))) index += 1;
    occurrences.set(taskId, index);
    return index;
  };
  const blocks = placed.map((block) => {
    const index = nextIndex(block.taskId);
    const blockDay = formatInTimeZone(new Date(block.start), zone, "yyyy-MM-dd");
    const needsRestCheck = currentEnergy === "low" && blockDay === today &&
      energyNeeds.get(block.taskId.split("#")[0]!) === "high" && Date.parse(block.start) > now.getTime();
    // 「精力偏低」: the slot has less energy than the work needs, so the block runs longer than the estimate (planner `efficiency`).
    const tag = block.progressOnly ? "本周未排完" : needsRestCheck ? "休息后复评" : block.efficiency ? "精力偏低"
      : library.has(block.taskId.split("#")[0]!) ? "按主线份额" : tentative(block.taskId) ? "暂定" : undefined;
    const slot = instants.find((item) => Date.parse(block.start) >= Date.parse(String(item.start)) && Date.parse(block.start) < Date.parse(String(item.end)));
    const need = itemById.get(block.taskId)?.task.energy;
    return {
    id: scheduledBlockId(block.taskId, index),
    lane: "human" as const,
    ...named(block.taskId), ...(tag ? { tag } : {}),
    ...(slot && need ? { energy: { slot: slot.energy, need, efficiency: block.efficiency ?? 1 } } : {}),
    day: blockDay,
    start: formatInTimeZone(new Date(block.start), zone, "HH:mm"),
    end: formatInTimeZone(new Date(block.end), zone, "HH:mm"),
    source: "排程",
    readOnly: true
  }; });
  // Second pass, the preview: where proposals still waiting for approval would go, placed only into the
  // time the approved work left free (the approved blocks are frozen for it), so a preview can never move
  // committed work. `proposed:` blocks are drawn dashed and are never published to any calendar.
  const proposals = withoutShadowingDemos(allOrders, capacityIds)
    .filter((order) => order.state === "awaiting_plan_approval" && !capacityIds.has(order.identityId)
      && !((plannerTaskOf(ctx, order).dependsOn ?? []).some((id) => stateById.get(id) !== "accepted" && !orders.some((item) => item.id === id))));
  const preview = proposals.length ? await planSchedule({
    now, horizonDays: days.length, mode: preferences.mode, params: effectiveParams(ctx),
    tasks: proposals.map((order) => plannerTaskOf(ctx, order)),
    availability: instants,
    frozenBlocks: [...committed.filter((block) => block.day && block.id.startsWith("scheduled:"))
      .map((block) => ({ taskId: plannerIdOfBlock(block.id), start: iso(block.day!, block.start), end: iso(block.day!, block.end) })),
      ...result.plan.blocks.map((block) => ({ taskId: block.taskId, start: block.start, end: block.end }))]
  }, { solver: "none" }).catch(() => undefined) : undefined;
  const proposalTitles = new Map(proposals.map((order) => [order.id, taskTitleOf(order)]));
  const previewSeen = new Map<string, number>();
  const previewBlocks = (preview?.plan.blocks ?? []).filter((block) => !block.frozen && proposalTitles.has(block.taskId)).map((block) => {
    const index = (previewSeen.get(block.taskId) ?? 0) + 1;
    previewSeen.set(block.taskId, index);
    return {
      id: `proposed:${block.taskId}${index > 1 ? `:${index}` : ""}`, lane: "human" as const,
      title: proposalTitles.get(block.taskId) ?? block.taskId, task: proposalTitles.get(block.taskId) ?? block.taskId, tag: "待批准",
      day: formatInTimeZone(new Date(block.start), zone, "yyyy-MM-dd"),
      start: formatInTimeZone(new Date(block.start), zone, "HH:mm"),
      end: formatInTimeZone(new Date(block.end), zone, "HH:mm"),
      source: "预览·待批准", readOnly: true
    };
  });
  blocks.push(...previewBlocks);
  // Frozen blocks, each under its own id at its own time: started or locked ones say so; kept ones read as ordinary scheduled blocks.
  for (const item of frozen) {
    const taskId = plannerIdOfBlock(item.blockId);
    const tag = item.reason === "pinned" || item.reason === "locked" ? "已锁定" : tentative(taskId) ? "暂定" : undefined;
    blocks.push({ id: item.blockId, lane: "human" as const, ...named(taskId), ...(tag ? { tag } : {}),
      day: formatInTimeZone(new Date(item.start), zone, "yyyy-MM-dd"), start: formatInTimeZone(new Date(item.start), zone, "HH:mm"),
      end: formatInTimeZone(new Date(item.end), zone, "HH:mm"), source: "排程", readOnly: true });
  }
  // Third pass, pencilled in: what found no room in the person's hours, placed between 07:00 and 23:00 outside them. Dashed, never
  // published, never counted as planned; starting one (`pinBlock`) makes it formal.
  const unplaced = new Set(result.blockers.map((blocker) => blocker.taskId));
  const leftovers = expanded.filter((item) => unplaced.has(item.task.id) && !frozen.some((entry) => plannerIdOfBlock(entry.blockId) === item.task.id));
  if (leftovers.length) {
    const offBusy = [...busy, ...blocks.filter((block) => block.day).map((block) => ({ day: block.day!, start: block.start, end: block.end }))];
    const offInstants = availableSlots(offHoursWindows(readAvailability(ctx)), days, offBusy).flatMap((slot) => {
      try { return [{ start: iso(slot.day, slot.start), end: iso(slot.day, slot.end), day: slot.day, energy: slot.energy }]; } catch { return []; }
    });
    const optional = offInstants.length ? await planSchedule({ now, horizonDays: days.length, mode: preferences.mode, params: effectiveParams(ctx),
      tasks: leftovers.map((item) => item.task), availability: offInstants,
      frozenBlocks: [...result.plan.blocks.map((block) => ({ taskId: block.taskId, start: block.start, end: block.end })), ...pinned]
    }, { solver: "none" }).catch(() => undefined) : undefined;
    const seen = new Map<string, number>();
    for (const block of (optional?.plan.blocks ?? []).filter((item) => !item.frozen && itemById.has(item.taskId))) {
      const index = (seen.get(block.taskId) ?? 0) + 1;
      seen.set(block.taskId, index);
      blocks.push({ id: scheduledBlockId(block.taskId, index).replace(/^scheduled:/, "optional:"), lane: "human" as const, ...named(block.taskId), tag: "预排",
        day: formatInTimeZone(new Date(block.start), zone, "yyyy-MM-dd"), start: formatInTimeZone(new Date(block.start), zone, "HH:mm"),
        end: formatInTimeZone(new Date(block.end), zone, "HH:mm"), source: "预排·非工作时段", readOnly: true });
    }
  }
  return { blocks, schedule: { status: clockBlockers.length || dependencyBlockers.length
    ? blocks.length ? "partial" : "infeasible" : result.status,
    blockers: [...result.blockers, ...clockBlockers, ...dependencyBlockers],
    solver: result.solver, ...(result.bufferRelaxed ? { bufferRelaxed: true } : {}),
    ...(result.notes?.length ? { notes: result.notes } : {}), ...(inPreview() ? {} : { inputHash: hash, optimal: Boolean(cached) }) } };
}

/**
 * How far a forecast that judges risk must run: past the furthest deadline of an approved milestone (a week beyond it), never under
 * the usual eight weeks nor over 26. An eight-week run called work due in 100 days 「八周内无法排完」 and asked about it as at risk —
 * not finishing inside the run says nothing about a deadline that lies beyond it (2026-10-21, the owner's account).
 */
export function riskHorizonDays(ctx: AccessContext): number {
  const today = planToday(ctx);
  const furthest = getStore().listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "approved")
    .map((milestone) => milestoneDeadline(ctx, milestone.id) ?? "").filter((day) => day > today).sort().at(-1);
  if (!furthest) return 56;
  const days = Math.round((Date.parse(`${furthest}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 8;
  return Math.min(182, Math.max(56, days));
}

/** `horizonDays`: how far the simulation runs — eight weeks unless the plan page asks for four weeks or up to six months. */
export function loadGoalForecast(ctx: AccessContext, horizonDays = 56): ForecastResult & { inferredRegularBlocks: number } {
  ensureSeeded(ctx);
  const store = getStore();
  const { capacity, inferred } = netCapacity(ctx, horizonDays);
  // An approved milestone's own deadline is one the person confirmed by approving it; the goal setting only overrides it.
  // Without the fallback no milestone had a deadline here unless it was typed a second time, so nothing was ever at risk.
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const goals = store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved")
    .map((item) => { const weight = effectiveWeight(ctx, item.id); return { id: item.id, title: item.title, weight,
      importance: weight >= IMPORTANT_WEIGHT ? "important" as const : "ordinary" as const,
      confirmedDeadline: readGoalSettings(ctx, item.id)?.confirmedDeadline ?? anchors.get(item.id) ?? null }; });
  const orders = store.listWorkOrders(ctx.workspaceId);
  const preferences = effectiveSchedulePreferences(ctx).preferences;
  // Step by step where a task has a plan, so the forecast counts only the work that is left.
  // A task waiting in the library starts no earlier than the day it enters the schedule, so a window that opens too late for the work
  // shows up here as a risk instead of a forecast that assumed it had already started.
  const today = planToday(ctx);
  const opens = new Map(orders.flatMap((order) => { const day = libraryUntil(ctx, order, today); return day ? [[order.id, day] as const] : []; }));
  // The person's hours: the assistant's preparation takes none of them (docs/work-split.md).
  const tasks = plannerItemsFor(ctx, orders.filter((order) => ACTIONABLE.includes(order.state) && onPersonsBoard(order)), { hold: false }).map((item) => {
    const day = opens.get(item.orderId);
    const start = day ? toZonedInstant(day, "00:00", preferences.timeZone) : undefined;
    return start && (!item.task.notBefore || item.task.notBefore < start) ? { ...item.task, notBefore: start } : item.task;
  });
  const completedIds = new Set(orders.filter((order) => order.state === "accepted").map((order) => order.id));
  return { ...forecastGoals(goals, tasks, capacity, completedIds), inferredRegularBlocks: inferred };
}

/**
 * What each of the next `horizonDays` days leaves of the person's available hours once the calendar, their own fixed events and the
 * travel to them are taken out: the forecast's capacity, and the weekly commitment's (docs/rituals.md). A regular calendar event seen on
 * two or more weeks is assumed again past the first week, where the synced calendar does not reach yet.
 */
export function netCapacity(ctx: AccessContext, horizonDays: number): { capacity: Array<{ day: string; netMinutes: number; source: "declared" | "calendar_adjusted" }>; inferred: number } {
  const store = getStore();
  const preferences = effectiveSchedulePreferences(ctx).preferences;
  const days = planDays(planToday(ctx), horizonDays);
  const committed = ((store.listPlanVersions(ctx.workspaceId)[0]?.payload as { blocks?: PersistedScheduleBlock[] } | undefined)
    ?.blocks ?? []).filter((block) => block.day && !(block.id.startsWith("graph_calendar:") && isCancelledEvent(block.title)));
  const signatures = new Map<string, Set<string>>();
  for (const block of committed.filter((item) => item.id.startsWith("graph_calendar:"))) {
    const weekday = new Date(`${block.day}T00:00:00Z`).getUTCDay();
    const key = `${weekday}|${block.start}|${block.end}|${block.title}`;
    signatures.set(key, (signatures.get(key) ?? new Set()).add(block.day!));
  }
  const regular = [...signatures].filter(([, observed]) => observed.size >= 2);
  const inferred = days.slice(7).flatMap((day) => regular.flatMap(([key]) => {
    const [weekday, start, end] = key.split("|");
    if (Number(weekday) !== new Date(`${day}T00:00:00Z`).getUTCDay()) return [];
    const real = committed.some((block) => block.day === day && block.start < end! && block.end > start!);
    return real ? [] : [{ day, start: start!, end: end! }];
  }));
  const busy = [...committed.map((block) => ({ day: block.day!, start: block.start, end: block.end })), ...inferred,
    ...((events) => [...events, ...travelBlocks(events, travelStateOf(ctx), localeFor(ctx))])(personEventBlocks(ctx, days)).map((block) => ({ day: block.day!, start: block.start, end: block.end }))];
  const slots = availableSlots(readAvailability(ctx), days, busy);
  const capacity = days.map((day) => ({ day, netMinutes: slots.filter((slot) => slot.day === day).reduce((sum, slot) => {
    try { return sum + (Date.parse(toZonedInstant(day, slot.end, preferences.timeZone))
      - Date.parse(toZonedInstant(day, slot.start, preferences.timeZone))) / 60_000; }
    catch { return sum; }
  }, 0), source: busy.some((block) => block.day === day) ? "calendar_adjusted" as const : "declared" as const }));
  return { capacity, inferred: inferred.length };
}

/** The person's minutes left on each order (its open steps' usual estimates, else the whole task's), the way the forecast counts them. */
export function remainingMinutesOf(ctx: AccessContext, orders: ActionableOrder[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of plannerItemsFor(ctx, orders, { hold: false })) out.set(item.orderId, (out.get(item.orderId) ?? 0) + item.task.estimate.p50Minutes);
  return out;
}

/** The input-box events (`schedule.events`) on these days, as plan blocks. */
function personEventBlocks(ctx: AccessContext, days: string[]): PersistedScheduleBlock[] {
  try { return fixedEventBlocks(JSON.parse(getStore().getSetting(ctx.workspaceId, FIXED_EVENTS) ?? "[]") as FixedEvent[], days, localeFor(ctx)); } catch { return []; }
}

/**
 * The calendar's blocks are stored; the scheduled ones are derived on read. Persisting a schedule would mean the plan disagreed with
 * the work orders the moment one of them moved. The person's own fixed events (typed into the input box) are busy time too, derived
 * on read like the schedule itself. A cancelled meeting still on the calendar (imported before cancellations were dropped) holds no time.
 */
function committedBlocks(ctx: AccessContext, payload: unknown): PersistedScheduleBlock[] {
  const blocks = [...((payload as { blocks?: PersistedScheduleBlock[] }).blocks ?? []).filter((block) => !(block.id.startsWith("graph_calendar:") && isCancelledEvent(block.title))),
    ...personEventBlocks(ctx, planDays(planToday(ctx)))];
  // Getting to an event at a physical place, and back, is busy time too (「路上」, `travelBlocks`).
  return [...blocks, ...travelBlocks(blocks, travelStateOf(ctx), localeFor(ctx))];
}

/** The person's travel settings, places and map estimates (`readTravelState`). */
export const travelStateOf = (ctx: AccessContext) => readTravelState((key) => getStore().getSetting(ctx.workspaceId, key));

/**
 * The energy question's value-of-information gate (docs/energy-and-ecosystem.md §6): would the answer change what the person does in
 * the next three hours? The greedy plan is made twice, with the current slot's energy as if they had said 「低」 and 「高」, and the
 * question is worth asking only when the two heads differ (`planHeadDiffers`). Cached per schedule epoch (`scheduleHashOf`: the input,
 * the slot the person is in, their reported energy), so the two-minute nudge pass solves at most twice per slot and input.
 */
export const ENERGY_VOI_SETTING = "energy.voi";
export async function energyAnswerMatters(ctx: AccessContext): Promise<boolean> {
  const store = getStore();
  const stored = store.listPlanVersions(ctx.workspaceId)[0];
  if (!stored) return false;
  const today = planToday(ctx);
  const committed = committedBlocks(ctx, stored.payload);
  const { input, instants, currentEnergy } = planningInputFor(ctx, today, committed);
  const hash = scheduleHashOf(input, instants, currentEnergy);
  try {
    const cached = JSON.parse(store.getSetting(ctx.workspaceId, ENERGY_VOI_SETTING) ?? "null") as { hash?: string; differs?: boolean } | null;
    if (cached?.hash === hash && typeof cached.differs === "boolean") return cached.differs;
  } catch { /* computed afresh */ }
  const headAt = async (level: "low" | "high") => (await planSchedule(withPreview({ currentEnergy: level }, () => planningInputFor(ctx, today, committed)).input,
    { solver: "none" })).plan.blocks;
  const [low, high] = [await headAt("low"), await headAt("high")];
  const differs = planHeadDiffers(low, high, input.now);
  store.setSetting(ctx.workspaceId, ENERGY_VOI_SETTING, JSON.stringify({ hash, differs }));
  return differs;
}

export async function loadCurrentPlan(ctx: AccessContext): Promise<PersistedPlan> {
  // Reused until the ledger changes or a minute passes (`lib/ledger-memo.ts`); a preview always computes its own.
  if (inPreview()) return computeCurrentPlan(ctx);
  return memoByLedgerAsync(getStore(), `plan:${ctx.workspaceId}:${localeFor(ctx)}:${appNow().toISOString().slice(0, 16)}`, 60_000, () => computeCurrentPlan(ctx));
}

async function computeCurrentPlan(ctx: AccessContext): Promise<PersistedPlan> {
  ensureSeeded(ctx);
  const store = getStore();
  const stored = store.listPlanVersions(ctx.workspaceId)[0];
  if (!stored) throw new Error("PLAN_VERSION_NOT_FOUND");
  const committed = committedBlocks(ctx, stored.payload);
  // A real, computed preview beats an empty page: the scheduler runs against sane defaults even before
  // the person has saved their own time zone, availability and mode. `usingDefaultPreferences` is what
  // lets the page say so, instead of either lying about it or blocking on it.
  const suggested = await scheduledBlocks(ctx, planToday(ctx), committed);
  if (!inPreview()) noteScheduleChanges(ctx, committed, suggested.blocks, appNow());
  return {
    id: stored.id,
    version: stored.version,
    blocks: [...committed, ...suggested.blocks],
    schedule: suggested.schedule,
    usingDefaultPreferences: effectiveSchedulePreferences(ctx).isDefault
  };
}

/**
 * 「作业 3 因 11:30 会议后移 30 分钟」 (docs/loop-and-scout.md §1): when a calendar change has come in since the schedule was last looked
 * at, each work block whose old time the new event now covers is named with where it went and why. Kept as `schedule.changeSummary`
 * (`{ at, realityAt, items, basis }`, the latest only); `basis` is the scheduled blocks' times the next comparison starts from. The
 * re-plan itself is derived on read and has nothing to undo, so the way back is 「钉回原位」: lock that block at its old time.
 */
export const CHANGE_SUMMARY = "schedule.changeSummary";
export type ScheduleChange = { blockId: string; title: string; day: string; from: { start: string; end: string }; to: { day: string; start: string; end: string }; cause: string };
type ChangeSummary = { at: string; realityAt: string; items: ScheduleChange[]; basis: Record<string, { day: string; start: string; end: string }> };
function noteScheduleChanges(ctx: AccessContext, committed: PersistedScheduleBlock[], blocks: PersistedScheduleBlock[], now: Date): void {
  const store = getStore();
  let saved: Partial<ChangeSummary> = {};
  try { saved = JSON.parse(store.getSetting(ctx.workspaceId, CHANGE_SUMMARY) ?? "{}"); } catch { /* none */ }
  const basis = Object.fromEntries(blocks.filter((block) => block.id.startsWith("scheduled:") && block.day)
    .map((block) => [block.id, { day: block.day!, start: block.start, end: block.end }]));
  const reality = store.listEvents(ctx.workspaceId, { type: "plan.reality_changed" }).at(-1);
  const realityAt = reality?.createdAt ?? "";
  const sameBasis = JSON.stringify(basis) === JSON.stringify(saved.basis ?? {});
  if (sameBasis && realityAt === (saved.realityAt ?? "")) return;
  let items = saved.items ?? [];
  let at = saved.at ?? now.toISOString();
  if (reality && realityAt !== saved.realityAt && saved.basis) {
    const added = new Set(((reality.payload as { changes?: RealityChange[] }).changes ?? []).filter((change) => change.kind !== "remove").map((change) => change.blockId));
    const external = committed.filter((block) => added.has(block.id) && block.day);
    const titles = new Map(blocks.map((block) => [block.id, block.title]));
    items = Object.entries(saved.basis).flatMap(([blockId, before]) => {
      const after = basis[blockId];
      if (!after || (after.day === before.day && after.start === before.start && after.end === before.end)) return [];
      const cause = external.find((block) => block.day === before.day && block.start < before.end && block.end > before.start);
      return cause ? [{ blockId, title: titles.get(blockId) ?? blockId, day: before.day, from: { start: before.start, end: before.end },
        to: after, cause: `${cause.start} ${cause.title}` }] : [];
    });
    at = now.toISOString();
  }
  store.setSetting(ctx.workspaceId, CHANGE_SUMMARY, JSON.stringify({ at, realityAt, items, basis } satisfies ChangeSummary));
}
/** What Today shows: the last summary while it is under a day old. */
export function readChangeSummary(ctx: AccessContext, now = appNow()): ScheduleChange[] {
  try {
    const saved = JSON.parse(getStore().getSetting(ctx.workspaceId, CHANGE_SUMMARY) ?? "{}") as Partial<ChangeSummary>;
    return saved.at && now.getTime() - Date.parse(saved.at) < 86_400_000 ? saved.items ?? [] : [];
  } catch { return []; }
}

/**
 * Steps split again because they did not get done on two days (adaptive granularity, `requestFinerSplits` in the worker): named in the
 * change summary on Today for a day once the smaller plan exists. Said there and nowhere else — no push, nothing to answer.
 */
export type FinerSplitNote = { orderId: string; title: string; step: string; days: number };
export function readFinerSplits(ctx: AccessContext, now = appNow()): FinerSplitNote[] {
  const store = getStore();
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const planned = store.listEvents(ctx.workspaceId, { type: "task.steps_planned" });
  return store.listEvents(ctx.workspaceId, { type: "task.steps_replan_requested" }).flatMap((event) => {
    const split = (event.payload as { finerSplit?: { title?: string; days?: string[] } }).finerSplit;
    const order = orders.get(event.entityId);
    const redone = planned.find((item) => item.entityId === event.entityId && item.createdAt > event.createdAt);
    if (!split || !order || !redone || now.getTime() - Date.parse(redone.createdAt) >= 86_400_000) return [];
    return [{ orderId: order.id, title: taskTitleOf(order), step: split.title ?? "", days: split.days?.length ?? 2 }];
  });
}

/** The most recent `plan.explained` event for today, if the explainer has ever run for it. Read from
 * the ledger like `lastNight` — there is no separate "current explanation" row, just the event trail. */
export function loadPlanExplanation(ctx: AccessContext, today: string): {
  summary: string; nextActionReason: string; alternatives: Array<{ id: string; reason: string }>;
} | null {
  const event = [...getStore().listEvents(ctx.workspaceId, { type: "plan.explained", entityId: today })].at(-1);
  if (!event) return null;
  const payload = event.payload as { summary?: string; nextActionReason?: string; alternatives?: Array<{ id: string; reason: string }> };
  if (!payload.summary || !payload.nextActionReason) return null;
  return { summary: payload.summary, nextActionReason: payload.nextActionReason, alternatives: payload.alternatives ?? [] };
}

export type CalendarConnectorState = {
  /** A stored delta cursor is proof a sync really completed; nothing else writes one. */
  synced: boolean;
  importedBlocks: number;
  lastChangeAt: string | null;
  lastChangeCount: number;
};

/**
 * What the calendar connector has actually done, read from the ledger rather than declared.
 *
 * The Connections page used to say "未配置凭据，未执行探测" for every row including the one connector
 * that was working — the page whose whole job is "what is connected" was wrong about the only thing
 * that was. Declared status and observed status are different claims, and only the second is useful.
 */
export function loadCalendarConnectorState(ctx: AccessContext): CalendarConnectorState {
  const store = getStore();
  const plan = store.listPlanVersions(ctx.workspaceId)[0];
  const blocks = ((plan?.payload as { blocks?: Array<{ id?: string }> } | undefined)?.blocks ?? [])
    .filter((block) => String(block.id).startsWith("graph_calendar:"));
  const last = store.listEvents(ctx.workspaceId, { type: "plan.reality_changed" }).at(-1);
  return {
    synced: store.hasAnySyncCursor(ctx.workspaceId, "graph_calendar"),
    importedBlocks: blocks.length,
    lastChangeAt: last?.createdAt ?? null,
    lastChangeCount: ((last?.payload as { changes?: unknown[] } | undefined)?.changes ?? []).length
  };
}

export type MilestoneInput = {
  id?: string;
  identityId: string;
  projectId: string;
  title: string;
  status: StoredMilestone["status"];
  successCriteria: SuccessCriterion[];
  /** Which `StoredMilestoneTemplate` these criteria were built from, if any — drives the deterministic
   * confidence computed below. Left undefined for a deliberately free-formed milestone. */
  templateId?: string;
};

/**
 * Creates a milestone, or writes a new version of one that exists.
 *
 * Editing never overwrites: the primary key is `(id, version)`, so a change writes `version + 1` and
 * the version a gate already judged against stays readable forever. Without that, re-reading an old
 * acceptance would show it judged against criteria that did not exist at the time.
 */
export function saveMilestoneEdit(ctx: AccessContext, input: MilestoneInput): { ok: true; id: string; version: number } | { ok: false; code: string } {
  const title = input.title.trim();
  if (!title || title.length > 200) return { ok: false, code: "MILESTONE_TITLE_REQUIRED" };
  if (!identityLines(ctx).some((pack) => pack.id === input.identityId)) {
    return { ok: false, code: "MILESTONE_IDENTITY_UNKNOWN" };
  }
  const projectId = input.projectId.trim() || `${input.identityId}-default`;
  const store = getStore();
  const existing = input.id ? store.listMilestones(ctx.workspaceId).find((item) => item.id === input.id) : undefined;
  if (input.id && !existing) return { ok: false, code: "MILESTONE_NOT_FOUND" };

  const version = existing ? existing.version + 1 : 1;
  const id = existing?.id ?? `milestone-${randomUUID()}`;
  const template = input.templateId
    ? store.listMilestoneTemplates(ctx.workspaceId, input.identityId).find((item) => item.id === input.templateId)
    : undefined;
  if (input.templateId && !template) return { ok: false, code: "MILESTONE_TEMPLATE_UNKNOWN" };
  const confidence = computeMilestoneConfidence(input.successCriteria, template);
  try {
    store.saveMilestone({
      id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
      identityId: input.identityId, projectId, title,
      version, status: input.status, successCriteria: input.successCriteria,
      ...(input.templateId ? { templateId: input.templateId } : {}), confidence,
      // Follows templateId the same way confidence does: present only when a template is actually
      // chosen (on this save, not merely at some point in the past), so re-picking "不套用" on an edit
      // correctly drops it rather than leaving a stale bank from a template no longer in effect.
      ...(template?.evidenceQuestionDefaults.length ? { evidenceQuestionBank: template.evidenceQuestionDefaults } : {})
    });
  } catch (error) {
    // `saveMilestone` throws the criterion blocker code, which is the specific thing the person needs
    // to fix — collapsing it into a generic failure would hide which criterion was rejected.
    return { ok: false, code: error instanceof Error ? error.message : "MILESTONE_SAVE_FAILED" };
  }
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `milestone:saved:${id}:${version}`,
    type: existing ? "milestone.revised" : "milestone.created", entityId: id,
    payload: { version, status: input.status, title, criteria: input.successCriteria.length }
  });
  // A cross-line relation is approved together with its downstream milestone (batch or single approval alike).
  if (input.status === "approved" && existing?.status !== "approved") approveArtifactRelationsFor(store, ctx.workspaceId, ctx.principalId, id);
  return { ok: true, id, version };
}

export type MilestoneTemplateInput = {
  identityId: string;
  kind: "deliverable" | "threshold" | "validation" | "recurring_cadence" | "decision";
  titleHint: string;
  successCriteriaDefaults: SuccessCriterion[];
};

/**
 * A user (or, via the assistant widget's `templateProposal`, the assistant on the user's explicit
 * request) adding a new milestone template directly — not a draft needing a second approval step, the
 * same way editing a milestone's own fields is not. `crossline-milestone-architect` only ever reads
 * `approved`-equivalent templates when proposing, and every template saved here is immediately usable.
 */
export function saveMilestoneTemplate(ctx: AccessContext, input: MilestoneTemplateInput):
  { ok: true; id: string } | { ok: false; code: string } {
  const titleHint = input.titleHint.trim();
  if (!titleHint || titleHint.length > 200) return { ok: false, code: "TEMPLATE_TITLE_REQUIRED" };
  if (!identityLines(ctx).some((pack) => pack.id === input.identityId)) {
    return { ok: false, code: "TEMPLATE_IDENTITY_UNKNOWN" };
  }
  const checked = validateSuccessCriteria(input.successCriteriaDefaults, localeFor(ctx));
  if (!checked.ok) return { ok: false, code: checked.blocker.code };
  const id = `template-${randomUUID()}`;
  getStore().saveMilestoneTemplate({
    id, workspaceId: ctx.workspaceId, kind: input.kind, identityId: input.identityId, titleHint,
    successCriteriaDefaults: input.successCriteriaDefaults, evidenceQuestionDefaults: [], source: "user"
  });
  return { ok: true, id };
}

/**
 * Batch decision on candidate milestone relations, which is the mode `requiredApproval` asks for.
 *
 * Only candidates move. An id that is already approved, refuted or simply unknown comes back in
 * `skipped` — reporting it as decided would tell the person their click did something it did not.
 */
export function decideMilestoneRelations(ctx: AccessContext, ids: string[], decision: "approved" | "archived"):
  | { ok: true; decided: string[]; skipped: string[] }
  | { ok: false; code: string } {
  if (requiredApproval("approve_milestone_relations") !== "batch") return { ok: false, code: "APPROVAL_MODE_UNEXPECTED" };
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200))];
  if (!unique.length) return { ok: false, code: "NO_RELATIONS_SELECTED" };
  const store = getStore();
  // Keyed on the decision and the exact set, so a double-submitted form writes one event, and a
  // genuinely different selection later is still recorded.
  const key = `relations:${decision}:${[...unique].sort().join(",")}`.slice(0, 400);
  const result = store.decideMilestoneRelations(ctx.workspaceId, ctx.principalId, unique, decision, key);
  // A relation the person turned down says which kinds of link they do not believe in; later proposals are given it.
  if (decision === "archived") {
    const titles = new Map(store.listMilestones(ctx.workspaceId).map((milestone) => [milestone.id, milestone.title]));
    for (const relation of store.listMilestoneRelations(ctx.workspaceId).filter((item) => result.decided.includes(item.id))) {
      store.addPreference({ workspaceId: ctx.workspaceId, source: "relation_rejected", scope: "all", weight: 0.8, refId: relation.id,
        text: tOf(ctx)("跨主线关系「{{from}} → {{to}}」（{{kind}}）被本人驳回", { from: titles.get(relation.fromMilestoneId) ?? relation.fromMilestoneId,
          to: titles.get(relation.toMilestoneId) ?? relation.toMilestoneId, kind: relationKindLabel[relation.kind] ? tOf(ctx)(relationKindLabel[relation.kind]!) : relation.kind }) });
    }
  }
  return { ok: true, ...result };
}

export function addCapturedTaskWithId(
  ctx: AccessContext,
  input: { title: string; context?: string },
  id: string,
  idempotencyKey: string
): string {
  getStore().capture({ id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    title: input.title, context: input.context ?? "" }, idempotencyKey);
  return id;
}

export type ExecutionResult = { ok: true } | { ok: false; code: string };

// A WorkOrder can be executed more than once (blocked → approved → restarted), so every execution-scoped
// idempotency key is numbered by how many executions that WorkOrder already has.
function executionRun(workspaceId: string, workOrderId: string): number {
  return getStore().listExecutions(workspaceId).filter((item) => item.workOrderId === workOrderId).length;
}

function findWorkOrder(workspaceId: string, workOrderId: string) {
  return getStore().listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
}

/**
 * Approves a proposal. `acceptanceStandard` is the standard as the person edited it on the card before approving (one line per item, in
 * the order of the proposal's evidence contract): it replaces the contract's wording, and from then on the task is judged by it and
 * nothing more (the owner's decision of 2026-10-15). Without it the proposal's own contract is the standard, fixed at approval.
 */
export function approveWorkOrderProposal(ctx: AccessContext, workOrderId: string, options: { acceptanceStandard?: string[]; completionMode?: CompletionMode } = {}): ExecutionResult {
  if (requiredApproval("approve_work_orders") === "never") return { ok: false, code: "APPROVAL_NOT_PERMITTED" };
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "approved") return { ok: true };
  // A blocked WorkOrder is recoverable by the same human approval that admitted it; the transition table
  // has always allowed it, and refusing here would strand a real item with no way back.
  if (workOrder.state !== "awaiting_plan_approval" && workOrder.state !== "blocked") return { ok: false, code: "PROPOSAL_NOT_APPROVABLE" };
  const edited = (options.acceptanceStandard ?? []).map((line) => String(line).trim().slice(0, 300)).filter(Boolean).slice(0, 10);
  if (edited.length) {
    const payload = (workOrder.payload ?? {}) as { evidenceContract?: Array<{ kind?: string; description?: string; why?: string; required?: boolean }> };
    const before = payload.evidenceContract ?? [];
    const evidenceContract = edited.map((description, index) => ({ kind: before[index]?.kind ?? "record", description,
      why: before[index]?.why ?? tOf(ctx)("本人批准时定下的验收标准"), required: before[index]?.required ?? true }));
    getStore().saveWorkOrder({ ...workOrder, payload: { ...payload, evidenceContract,
      acceptanceStandard: { fixedAt: new Date().toISOString(), lines: edited, by: "person" } } });
  }
  if (options.completionMode) setCompletionMode(ctx, workOrderId, options.completionMode);
  getStore().transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "plan.approved", approvalId: ctx.principalId },
    `proposal-approved:${workOrderId}:${executionRun(ctx.workspaceId, workOrderId)}`);
  return { ok: true };
}

/**
 * The person's own choice of how finishing a task is taken (「点完成即验收」 / 「完成后再问结果」), on the proposal card or the task: it
 * overrides the model's judgement (`completionRule` in core). Any state before completion.
 */
export function setCompletionMode(ctx: AccessContext, workOrderId: string, mode: CompletionMode): ExecutionResult {
  if (mode !== "self_evident" && mode !== "needs_assessment") return { ok: false, code: "COMPLETION_MODE_INVALID" };
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (["accepted", "archived"].includes(workOrder.state)) return { ok: false, code: "WORK_ORDER_CLOSED" };
  getStore().saveWorkOrder({ ...workOrder, payload: { ...((workOrder.payload ?? {}) as object), completionMode: mode } });
  return { ok: true };
}

/**
 * Materials are ready. `source` records who actually prepared them: until AI preparation lands the
 * honest answer is "the human did", and a preparation that never finishes must not strand the item.
 */
export function markMaterialsReady(ctx: AccessContext, workOrderId: string, source: "human" | "ai"): ExecutionResult {
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "ready_for_human") return { ok: true };
  if (workOrder.state !== "preparing") return { ok: false, code: "MATERIALS_NOT_PREPARING" };
  getStore().transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "materials.ready" },
    `materials-ready:${workOrderId}:${executionRun(ctx.workspaceId, workOrderId)}:${source}`);
  return { ok: true };
}

/**
 * Asks for material preparation to be tried again.
 *
 * A failed preparation is deliberately not retried on a timer, so without this an order blocked by a
 * transient failure — or by a bug that has since been fixed — stayed blocked forever with only the
 * "I prepared them myself" escape.
 */
export function retryMaterialPreparation(ctx: AccessContext, workOrderId: string): ExecutionResult {
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state !== "preparing") return { ok: false, code: "MATERIALS_NOT_PREPARING" };
  getStore().appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `materials:retry:${workOrderId}:${Date.now()}`,
    type: "materials.retry_requested", entityId: workOrderId, payload: { requestedBy: ctx.principalId }
  });
  return { ok: true };
}

/**
 * Discards a WorkOrder the person does not want, with their reason on the record.
 *
 * Every state in the machine has always allowed `archived`, but nothing in the app ever emitted it, so
 * a proposal the analysis got wrong stayed on the board forever with only "approve it" or "leave it
 * sitting there" as options. An accepted WorkOrder is excluded: discarding finished work would be
 * rewriting history rather than cleaning up an inbox.
 */
/**
 * Reasons the system itself gave when it withdrew work (demo cleanup, a re-split, an input the person handed over). Those withdrawals are
 * the system's own drafts being replaced, not decisions the person made, and the 已丢弃 drawer does not show them — the person sees
 * the plan as it now stands, not every version it went through. Newer withdrawals carry `bySystem` on the event instead of relying on
 * this list; it covers the ones written before that flag existed.
 */
// Older rows carry the earlier wording, so both forms stay in the list.
// i18n-ignore-start: stored reasons matched by code
const SYSTEM_ARCHIVE_REASONS = ["示例作业自动清理", "自动反推旧版", "你已经在等这项输入", "你已经提供了这项输入", "你说这个里程碑先不拆",
  "该输入已在等待中", "该输入已由本人提供", "本人选择暂不拆分该里程碑"];
// i18n-ignore-end
export function archivedBySystem(payload: unknown): boolean {
  const value = payload as { bySystem?: boolean; reason?: string } | undefined;
  return value?.bySystem === true || SYSTEM_ARCHIVE_REASONS.some((reason) => (value?.reason ?? "").startsWith(reason));
}

/**
 * A milestone the architect replaced on its own: archived without the person ever editing it (every edit, archiving included, writes
 * `milestone.revised`). The 主线 page leaves these out; what the person archived stays in its fold.
 */
export function milestonesRetiredBySystem(ctx: AccessContext): Set<string> {
  const store = getStore();
  const touched = new Set(store.listEvents(ctx.workspaceId, { type: "milestone.revised" }).map((event) => event.entityId));
  return new Set(store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "archived" && !touched.has(milestone.id))
    .map((milestone) => milestone.id));
}

export function archiveWorkOrder(ctx: AccessContext, workOrderId: string, reason: string, options: { bySystem?: boolean } = {}): ExecutionResult {
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "archived") return { ok: true };
  if (workOrder.state === "accepted") return { ok: false, code: "WORK_ORDER_ALREADY_ACCEPTED" };
  const store = getStore();
  // Keyed per attempt: a restored order can be archived again, and a fixed key would make that second archive a silent no-op.
  const attempt = store.listEvents(ctx.workspaceId, { type: "work_order.archived", entityId: workOrderId }).length;
  const suffix = attempt ? `:${attempt}` : "";
  // The reason rides on its own event rather than the transition: `transitionWorkOrder` carries only
  // the fields the state machine itself validates, and a discard reason is a note, not a state input.
  // It is optional — a slip or a duplicate needs no explanation. `from` is what a restore goes back to.
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `archive-reason:${workOrderId}${suffix}`,
    type: "work_order.archived", entityId: workOrderId,
    payload: { reason: reason.trim().slice(0, 200), from: workOrder.state, ...(options.bySystem ? { bySystem: true } : {}) }
  });
  const result = store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "archived" }, `archive:${workOrderId}${suffix}`);
  if (!result.changed) return { ok: false, code: "WORK_ORDER_NOT_ARCHIVABLE" };
  return { ok: true };
}

/** Takes an archived order back to the state it was archived from (恢复 in the archive drawer, or an undo). */
export function restoreWorkOrder(ctx: AccessContext, workOrderId: string): ExecutionResult {
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state !== "archived") return { ok: true };
  const store = getStore();
  const archives = store.listEvents(ctx.workspaceId, { type: "work_order.archived", entityId: workOrderId });
  const to = restoreTargetOf((archives.at(-1)?.payload as { from?: string } | undefined)?.from);
  const result = store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "archive.restored", to },
    `archive-restored:${workOrderId}:${archives.length}`);
  return result.changed ? { ok: true } : { ok: false, code: "WORK_ORDER_NOT_RESTORABLE" };
}

/** Takes a discarded capture back to where it was. */
export function restoreCapture(ctx: AccessContext, captureId: string): ExecutionResult {
  try {
    getStore().restoreCapture(ctx.workspaceId, captureId);
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "CAPTURE_RESTORE_FAILED";
    return { ok: false, code };
  }
}

/** Discards a raw capture. The WorkOrder equivalent is `archiveWorkOrder`; captures had no exit. */
export function discardCapture(ctx: AccessContext, captureId: string, reason: string): ExecutionResult {
  try {
    getStore().discardCapture(ctx.workspaceId, captureId, reason);
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "CAPTURE_DISCARD_FAILED";
    return { ok: false, code };
  }
}

/** Whether the person could start this order now without waiting for materials (see `plannerTaskOf`). */
export function inputsReady(order: { state: string; payload: unknown }): boolean {
  if (order.state === "ready_for_human" || order.state === "active") return true;
  return order.state === "approved" && !((order.payload as { materialContract?: unknown[] } | undefined)?.materialContract ?? []).length;
}

export function startWorkOrderExecution(ctx: AccessContext, workOrderId: string, at?: string): ExecutionResult {
  const store = getStore();
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "active") {
    // Active with no open session: a confirmed block closed the last one, and starting again has to time something.
    if (!store.listExecutions(ctx.workspaceId, workOrderId).some((execution) => !execution.endedAt))
      store.openSession(ctx.workspaceId, workOrderId, ctx.principalId, at);
    return { ok: true };
  }
  const run = executionRun(ctx.workspaceId, workOrderId);
  if (workOrder.state === "approved") {
    // Needing materials used to be a dead end: nothing emitted `automation.started`, so any WorkOrder
    // whose analysis did its job was stuck forever. Preparation is now a real state you pass through.
    const materials = (workOrder.payload as { materialContract?: unknown[] }).materialContract ?? [];
    // Already prepared once. Sending it back to `preparing` would strand it: the worker skips orders
    // that already have materials, so nothing would ever move it on, and the person would be looking at
    // 「材料准备中」 for materials sitting on disk. This is the path a restored-from-blocked order takes.
    if (materials.length && store.listMaterials(ctx.workspaceId, workOrderId).length === 0) {
      store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "automation.started" }, `materials-preparing:${workOrderId}:${run}`);
      return { ok: false, code: "MATERIALS_PREPARING" };
    }
    store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "materials.not_required" }, `materials-not-required:${workOrderId}:${run}`);
  } else if (workOrder.state !== "ready_for_human") {
    return { ok: false, code: "EXECUTION_NOT_STARTABLE" };
  }
  store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "human.started" }, `execution:${workOrderId}:${run}:started`,
    { durationObserved: true, ...(at ? { occurredAt: at } : {}) });
  return { ok: true };
}

export function pauseWorkOrderExecution(ctx: AccessContext, workOrderId: string, reason: string, at?: string): ExecutionResult {
  if (!reason.trim()) return { ok: false, code: "INTERRUPTION_REASON_REQUIRED" };
  if (findWorkOrder(ctx.workspaceId, workOrderId)?.state !== "active" || !hasOpenSession(ctx.workspaceId, workOrderId)) return { ok: false, code: "NO_ACTIVE_EXECUTION" };
  getStore().pauseExecution(ctx.workspaceId, workOrderId, reason.trim(), at);
  return { ok: true };
}

export function resumeWorkOrderExecution(ctx: AccessContext, workOrderId: string, at?: string): ExecutionResult {
  if (findWorkOrder(ctx.workspaceId, workOrderId)?.state !== "active" || !hasOpenSession(ctx.workspaceId, workOrderId)) return { ok: false, code: "NO_ACTIVE_EXECUTION" };
  getStore().resumeExecution(ctx.workspaceId, workOrderId, at);
  return { ok: true };
}

/**
 * An active order can have no open session: a confirmed block (the completion check, the wrap-up, the return page) closes the session it
 * covers while the task stays active. Pausing or resuming it then is a refusal, not a store error: the floating timer's 结束 pressed after
 * answering 「做得怎么样」 on the phone threw `NO_ACTIVE_EXECUTION` out of the route (found by the month simulation).
 */
function hasOpenSession(workspaceId: string, workOrderId: string): boolean {
  return getStore().listExecutions(workspaceId, workOrderId).some((execution) => !execution.endedAt);
}

/** What a completion did: always accepted; `followUp` is the question the 小帮手 will ask later when the result is not known yet. */
export type CompletionResult = { ok: true; completion?: { mode: CompletionMode; followUp?: string } } | { ok: false; code: string };

/** Recorded on `assessment.pending`: what to ask about a finished task whose result is not known yet, and from when (`lib/outcome-check.ts`). */
export type PendingAssessment = { reason: string; question: string; askAfter: string; milestoneId: string };

/**
 * The person pressed 完成: that is the acceptance (the owner's decision of 2026-10-15, `completionRule` in core). The order goes through
 * `human.completed` (the session closes, the duration is observed, files are handed on) and straight on to `accepted` — no gate, no
 * question, no evidence required, milestone-bound or not. `outcome` is the optional 「完成情况」 the person gave (顺利 / 勉强 / 有遗漏 and a
 * line). Work whose result is not known when it is finished (`needs_assessment`: an exam's score, a draft's quality, an exploration) also
 * leaves an `assessment.pending` record the 小帮手 asks about later at an idle moment — unless the person already said how it went and
 * nothing else is to come (a score always is).
 */
export function completeWorkOrderExecution(ctx: AccessContext, workOrderId: string, evidence: EvidenceClaimInput[],
  checklistAnswers: ChecklistAnswer[] = [], at?: string, report?: { minutes: number; source: "one_tap" | "activity" },
  outcome?: CompletionOutcome): CompletionResult {
  const store = getStore();
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  // Already handed in (a replayed offline command, or an order completed before this rule that still waits for the gate).
  if (workOrder.state === "evidence_review" || workOrder.state === "accepted") return { ok: true };
  if (workOrder.state !== "active") return { ok: false, code: "EXECUTION_NOT_ACTIVE" };
  const baseline = durationPriorFor(workOrder.identityId, workOrder.payload);
  const run = executionRun(ctx.workspaceId, workOrderId) - 1;
  store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "human.completed" },
    `execution:${workOrderId}:${run}:completed`,
    { evidence, ...(checklistAnswers.length ? { checklistAnswers } : {}), ...(at ? { occurredAt: at } : {}),
      ...(report ? { reportedMinutes: report.minutes, reportedSource: report.source } : {}),
      ...(baseline ? { durationCalibrationBaseline: baseline } : {}) });
  store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "evidence.accepted", approvalId: ctx.principalId, onCompletion: true },
    `completion-accepted:${workOrderId}:${run}`, { ...(at ? { occurredAt: at } : {}), ...(baseline ? { durationCalibrationBaseline: baseline } : {}) });
  const doneAt = at ?? new Date().toISOString();
  if (outcome) store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `work_order.outcome:${workOrderId}:${run}`,
    type: "work_order.outcome_reported", entityId: workOrderId, payload: { level: outcome.level, note: outcome.note, at: doneAt, source: "completion" } });
  // The follow-up question is written now, in the language of this moment.
  const rule = completionRule(workOrder, localeFor(ctx));
  const followUp = rule.mode === "needs_assessment" && (rule.reason === "result_pending" || !outcome);
  if (followUp) {
    const pending: PendingAssessment = { reason: rule.reason ?? "quality", question: rule.question ?? "", milestoneId: workOrder.milestoneId,
      askAfter: new Date(Date.parse(doneAt) + (rule.askAfterHours ?? 2) * 3_600_000).toISOString() };
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `assessment.pending:${workOrderId}:${run}`,
      type: "assessment.pending", entityId: workOrderId, payload: pending });
  }
  return { ok: true, completion: { mode: rule.mode, ...(followUp && rule.question ? { followUp: rule.question } : {}) } };
}

export function acceptWorkOrderEvidence(ctx: AccessContext, workOrderId: string): ExecutionResult {
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "accepted") return { ok: true };
  if (workOrder.state !== "evidence_review") return { ok: false, code: "EVIDENCE_REVIEW_NOT_READY" };
  if (workOrder.milestoneId) return { ok: false, code: "MILESTONE_GATE_REQUIRED" };
  const baseline = durationPriorFor(workOrder.identityId, workOrder.payload);
  getStore().transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "evidence.accepted", approvalId: ctx.principalId },
    `evidence-accepted:${workOrderId}:${executionRun(ctx.workspaceId, workOrderId)}`,
    { ...(baseline ? { durationCalibrationBaseline: baseline } : {}) });
  return { ok: true };
}

export function revokeAutoAcceptedWorkOrder(ctx: AccessContext, workOrderId: string, reason: string): ExecutionResult {
  const store = getStore();
  // Keyed on the attempt, not just the work order — the same reason a gate re-judgement is. A work
  // order can be auto-accepted, revoked, re-judged and auto-accepted again more than once, and a key
  // that only named the work order reused a spent one on the second revoke: `appendEvent` silently
  // no-ops on a repeated idempotency key, `transitionWorkOrder` returned `changed: false`, and this
  // function returned `{ ok: true }` anyway without checking. The person saw the page reload and
  // believed the revoke worked; the ledger never left `accepted`.
  const attempt = store.listEvents(ctx.workspaceId, { type: "milestone_gate.auto_acceptance_revoked", entityId: workOrderId }).length;
  try {
    store.revokeAutoAcceptance(ctx.workspaceId, workOrderId, reason, `auto-acceptance-revoked:${workOrderId}:${attempt}`);
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "AUTO_ACCEPTANCE_REVOKE_FAILED";
    return { ok: false, code };
  }
}

export function blockWorkOrderEvidence(ctx: AccessContext, workOrderId: string, reason: string): ExecutionResult {
  if (!reason.trim()) return { ok: false, code: "BLOCK_REASON_REQUIRED" };
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state !== "evidence_review") return { ok: false, code: "EVIDENCE_REVIEW_NOT_READY" };
  getStore().transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "blocked", reason: reason.trim() },
    `evidence-blocked:${workOrderId}:${executionRun(ctx.workspaceId, workOrderId)}`);
  return { ok: true };
}

// Estimates live on the WorkOrder, where they carry their own source, observation count and confidence.
// A task without one falls back to the pack's labelled prior rather than to a number invented here.
// Today reads work_orders, not tasks. Reading tasks meant a capture that was successfully analysed
// vanished from the home page, because analysis only ever writes a WorkOrder.
const ACTIONABLE = ["approved", "preparing", "ready_for_human", "active"];

/** Why the scheduler left a task out, in the plan page's words; the planner's own messages repeat the title and address the person. */
const UNPLACED_REASON: Record<string, string> = {
  Q4_NEEDS_DATE_OR_PROMOTION: "无截止日且重要性低于 60，暂不排入；设定截止日或提高重要性后排入",
  Q4_BEYOND_FORECAST_HORIZON: "截止日在 8 周之后，暂不排入",
  Q4_WAITING_LATEST_START: "截止尚远，最迟开工日之前暂不排入",
  DEADLINE_CAPACITY: "截止日前的可用时段不足",
  NO_CAPACITY: "本次排程范围内的可用时段已排满，之后的时段再排入",
  NO_CONTINUOUS_SLOT: "需要一段连续时间，现有最长空档不够",
  PROGRESS_ONLY: "本周只排入 45 分钟进度",
  DEPENDENCY_NOT_READY: "前置任务尚未验收"
};

/** One task as the scheduler saw it, and what it did with it: why it sits where it does on the plan page's 「排程依据」. */
export type RankedTask = { id: string; title: string; line: string; milestoneId: string; tier: 1 | 2 | 3 | 4; weight: number;
  deadline: string | null; notBefore: string | null; firstDay: string | null; firstStart: string | null; weekMinutes: number; blocker: string | null;
  /** In the task library: the day it enters the schedule (`libraryUntil`). */
  libraryUntil: string | null;
  /** What is left of it (open steps only, where it has a step plan), usual and cautious. */
  p50Minutes: number; p85Minutes: number };

/**
 * The real ordering, read off the same planner input and the same result the calendar shows (no second ranking of its own): each
 * actionable task's tier, weight, deadline and release, its first block and its minutes in the next seven days, and — for one that was
 * not placed — the planner's own reason. Listed in the scheduler's own priority: placed before unplaced, then urgency tier, then
 * importance, then deadline.
 */
export function planRanking(ctx: AccessContext, plan: PersistedPlan): RankedTask[] {
  const store = getStore();
  const t = tOf(ctx);
  const capacityIds = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const orders = withoutShadowingDemos(store.listWorkOrders(ctx.workspaceId), capacityIds)
    .filter((order) => ACTIONABLE.includes(order.state) && !capacityIds.has(order.identityId));
  const today = planToday(ctx);
  const weekEnd = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const minutesOf = (block: PersistedScheduleBlock) => {
    const [sh, sm] = block.start.split(":").map(Number), [eh, em] = block.end.split(":").map(Number);
    return (eh! * 60 + em!) - (sh! * 60 + sm!);
  };
  const items = plannerItemsFor(ctx, orders);
  const ranked = orders.map((order): RankedTask => {
    const task = plannerTaskOf(ctx, order);
    const own = items.filter((item) => item.orderId === order.id);
    const blocks = plan.blocks.filter((block) => block.day && block.id.startsWith("scheduled:") && block.id.split(":")[1] === order.id)
      .sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`));
    const blocker = plan.schedule.blockers.find((item) => item.taskId === order.id || item.taskId.startsWith(`${order.id}#`));
    const local = (instant: string | undefined) => instant ? formatInTimeZone(new Date(instant), zone, "yyyy-MM-dd") : null;
    return { id: order.id, title: taskTitleOf(order), line: order.identityId, milestoneId: order.milestoneId, tier: task.deadlineTier,
      weight: task.weight, deadline: local(task.deadline), notBefore: local(task.notBefore),
      firstDay: blocks[0]?.day ?? null, firstStart: blocks[0]?.start ?? null,
      weekMinutes: blocks.filter((block) => block.day! >= today && block.day! < weekEnd).reduce((sum, block) => sum + minutesOf(block), 0),
      blocker: blocks.length || !blocker ? null : UNPLACED_REASON[blocker.code] ? t(UNPLACED_REASON[blocker.code]!) : blocker.message,
      libraryUntil: libraryUntil(ctx, order, today),
      p50Minutes: own.reduce((sum, item) => sum + item.task.estimate.p50Minutes, 0),
      p85Minutes: own.reduce((sum, item) => sum + item.task.estimate.p85Minutes, 0) };
  });
  return ranked.sort((a, b) => (a.firstDay ? 0 : 1) - (b.firstDay ? 0 : 1) || a.tier - b.tier || b.weight - a.weight
    || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")
    || `${a.firstDay ?? ""} ${a.firstStart ?? ""}`.localeCompare(`${b.firstDay ?? ""} ${b.firstStart ?? ""}`));
}

/**
 * The demo work orders every account is seeded with exist to show the flow. Once the person has any work of their own (in any state
 * short of discarded) they stop being recommended or scheduled: Today's 「下一步」 and the plan must never hold a made-up task next to a
 * real midterm. They stay on the Workbench, where they can be discarded.
 *
 * Every caller lists the person's own work (Today's 「下一步」, the schedule, its preview and ranking), so the assistant's preparation and
 * the questions to the person (`payload.owner`, docs/work-split.md) are left out here too: they get no calendar time and no card.
 */
export function withoutShadowingDemos<T extends { state: string; identityId: string; payload: unknown }>(all: T[], capacityIds: Set<string>): T[] {
  const orders = all.filter(onPersonsBoard);
  const demo = (order: T) => Boolean((order.payload as { seeded?: boolean }).seeded);
  const hasOwnWork = orders.some((order) => !demo(order) && order.state !== "archived" && !capacityIds.has(order.identityId));
  return hasOwnWork ? orders.filter((order) => !demo(order)) : orders;
}

/** Minutes left in these same-day slots from `nowClock` (HH:mm) on: a slot already over counts nothing, one under way counts its rest. */
export function remainingMinutes(slots: Array<{ start: string; end: string }>, nowClock: string): number {
  const clockMinutes = (clock: string) => { const [h, m] = clock.split(":"); return Number(h) * 60 + Number(m); };
  const nowMinutes = clockMinutes(nowClock);
  return slots.reduce((sum, slot) => sum + Math.max(0, clockMinutes(slot.end) - Math.max(clockMinutes(slot.start), nowMinutes)), 0);
}

type ActionableOrder = ReturnType<CrosslineStore["listWorkOrders"]>[number];

const humanCoreOf = (order: ActionableOrder) =>
  ((order.payload as { humanCore?: Array<{ energy?: string; interruptible?: boolean }> }).humanCore ?? [])[0];

/**
 * This person's calibration, fitted on every finished task whose estimate came from the analysis: how far the
 * model's p50 tends to be off, overall and per (line × kind), and whether correcting it actually beat the raw
 * number in a backtest (`packages/core/src/calibration.ts`). Cached until a new observation lands — the backtest
 * refits once per point and is read on every page.
 */
const calibrationCache = new Map<string, { key: string; report: CalibrationReport }>();
export function workspaceCalibration(ctx: AccessContext, now = new Date()): CalibrationReport {
  const rows = getStore().listAllDurationObservations(ctx.workspaceId).filter((row) => row.llmP50Minutes !== null && row.llmP85Minutes !== null);
  const key = `${rows.length}:${rows.at(-1)?.createdAt ?? ""}:${now.toISOString().slice(0, 10)}`;
  const cached = calibrationCache.get(ctx.workspaceId);
  if (cached?.key === key) return cached.report;
  const report = calibrationReport(rows.map((row) => ({ identityId: row.identityId, family: row.family, llmP50: row.llmP50Minutes!, llmP85: row.llmP85Minutes!,
    actualMinutes: row.interruptionDominant ? 0 : row.observedMinutes, observedAt: row.observedAt, contextVersion: row.contextVersion, censored: row.censored })),
    now, ANALYSIS_CONTEXT_VERSION);
  calibrationCache.set(ctx.workspaceId, { key, report });
  return report;
}

/**
 * The estimate actually used for scheduling and display: the analysis's own number, corrected by this person's
 * record once the correction has proved itself (otherwise unchanged, marked as still learning). Read fresh, never
 * written back, so the stored estimate stays what the analysis said and every observation keeps improving it.
 * It replaces two stacked corrections — a per-kind average that discarded the task's own estimate, and a global
 * ratio with no shrinkage applied after three completions.
 */
export const resolvedEstimate = (ctx: AccessContext, order: ActionableOrder): Estimate =>
  calibratedEstimate(order.estimate, workspaceCalibration(ctx), order.identityId, (order.payload as { family?: string } | undefined)?.family);

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
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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
const riskBufferOf = (ctx: AccessContext, milestoneId: string | undefined): number => {
  const stored = milestoneId ? parseMilestoneRisks(getStore().getSetting(ctx.workspaceId, MILESTONE_RISKS_SETTING))[milestoneId] : undefined;
  if (!stored || !("risks" in stored)) return 0;
  const decision = readRiskDecisions(ctx)[milestoneId!];
  return decision?.how === "accept" && decision.fingerprint === stored.fingerprint ? riskBufferDays(stored.risks) : 0;
};

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

/** Milestone titles and the calendar's own blocks, read once per ledger change for every planner task. */
function milestoneTitleOf(ctx: AccessContext, milestoneId: string): string {
  return memoByLedger(getStore(), `milestone-titles:${ctx.workspaceId}`, 60_000,
    () => new Map(getStore().listMilestones(ctx.workspaceId).map((milestone) => [milestone.id, milestone.title]))).get(milestoneId) ?? "";
}
function fixedBlocksOf(ctx: AccessContext): PersistedScheduleBlock[] {
  return memoByLedger(getStore(), `fixed-blocks:${ctx.workspaceId}`, 60_000, () =>
    ((getStore().listPlanVersions(ctx.workspaceId)[0]?.payload as { blocks?: PersistedScheduleBlock[] } | undefined)?.blocks ?? [])
      .filter((block) => block.day && !(block.id.startsWith("graph_calendar:") && isCancelledEvent(block.title))));
}

const plannerTaskOf = (ctx: AccessContext, order: ActionableOrder) => {
  const preferences = readSchedulePreferences(ctx);
  const riskBuffer = riskBufferOf(ctx, order.milestoneId);
  const milestoneDue = milestoneDeadline(ctx, order.milestoneId);
  const weight = effectiveWeight(ctx, order.milestoneId);
  const important = weight >= IMPORTANT_WEIGHT;
  // A task with its own due day (a homework due Monday) has a deadline whether or not its milestone's was confirmed.
  const ownDue = (order.payload as { dueDate?: string }).dueDate;
  const hasDeadline = Boolean(milestoneDue) || Boolean(ownDue && /^\d{4}-\d{2}-\d{2}$/.test(ownDue));
  // Before the person saved any preferences the older rule applies to work without a deadline; a deadline always lifts it.
  const tier = hasDeadline ? important ? 1 : 2 : preferences ? important ? 3 : 4
    : order.state === "approved" ? 3 : order.identityId === (process.env.CROSSLINE_PRIMARY_CLOCK_ID ?? linePacks(ctx).find((pack) => pack.masterClock)?.id) ? 1 : 2;
  const core = humanCoreOf(order);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const landing = byproductLanding(ctx, order);
  // The assistant's preparation for this task takes none of the person's time and is due before it begins (docs/work-split.md §4): it
  // does not hold the task off the calendar.
  const offBoard = memoByLedger(getStore(), `off-board:${ctx.workspaceId}`, 5_000, () =>
    new Set(getStore().listWorkOrders(ctx.workspaceId).filter((item) => !onPersonsBoard(item)).map((item) => item.id)));
  const dependsOn = (landing ? landing.dependsOn : (order.payload as { dependsOn?: string[] }).dependsOn)?.filter((id) => !offBoard.has(id));
  const preview = previewScope.getStore();
  const release = preview?.notBefore?.[order.id] ?? releaseDayOf(ctx, order);
  const dueDate = preview?.dueDates?.[order.id] ?? landing?.dueDate ?? (order.payload as { dueDate?: string }).dueDate;
  return {
    id: order.id, title: taskTitleOf(order), identityId: order.identityId, milestoneId: order.milestoneId, weight,
    estimate: scaledEstimate(resolvedEstimate(ctx, order), preview?.estimates?.[order.id]),
    ...(core?.energy ? { energy: core.energy as "low" | "medium" | "high" } : {}),
    // Materials stand between the proposal and the human until the order reaches ready_for_human — when it needs any. An approved
    // order with no material contract can be started as it is (`startWorkOrderExecution` passes straight through), and every
    // backplanned step is one: counting them as not ready left 「下一步」 empty with five approved orders on the board.
    inputsReady: inputsReady(order),
    // A byproduct's landing never outranks real work: lowest tier, with its own T+2 window once the main order is done.
    deadlineTier: (landing ? 4 : tier) as 1 | 2 | 3 | 4,
    // The earlier of the milestone's deadline and the task's own due date (the capture's 「10月21号前」, a homework's due day): a
    // homework due before the exam it counts towards is due on its own day. The milestone's deadline used to count only once schedule
    // preferences had been saved, which a new account never has.
    ...(() => {
      const day = [milestoneDue,
        dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : undefined].filter((value): value is string => Boolean(value)).sort()[0];
      // Work towards a sitting (an exam held in that day's class) is due when the sitting begins, not at midnight.
      const sitting = day && day === milestoneDue && order.milestoneId ? sittingStartOn(milestoneTitleOf(ctx, order.milestoneId), day, fixedBlocksOf(ctx)) : undefined;
      return day ? { deadline: toZonedInstant(day, sitting ?? "23:59", zone) } : {};
    })(),
    ...(release ? { notBefore: toZonedInstant(release, "00:00", zone) } : {}),
    ...(dependsOn?.length ? { dependsOn } : {}),
    ...(riskBuffer ? { riskBufferDays: riskBuffer } : {}),
    interruptible: core?.interruptible ?? true
  };
};

/**
 * The first day this order may be worked on. Waiting for someone: the expected day while it is still ahead;
 * once that day has passed without the person saying it came, not before tomorrow — the Today card asks, and
 * scheduling work on data that may not exist is the thing the waiting item is there to stop. Arrived or
 * dropped: no constraint. Without a waiting item, the release date the capture itself named.
 */
/**
 * The person saying a task waits for someone: 「师兄 10/8 左右给数据」. The same waiting item analysis would have
 * written, made by hand — for a task analysed before the analysis read such dates, or one it missed.
 */
export function addWaitingForOrder(ctx: AccessContext, workOrderId: string, input: { who: string; what: string; expectedAt: string; approximate: boolean }):
  { ok: true; id: string } | { ok: false; code: string } {
  const order = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (["accepted", "archived"].includes(order.state)) return { ok: false, code: "WORK_ORDER_CLOSED" };
  const what = input.what.trim();
  if (!what || what.length > 200 || input.who.length > 60 || !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedAt)) return { ok: false, code: "INVALID_WAITING_INPUT" };
  const id = `wait-${workOrderId}-${getStore().listWaitingItems(ctx.workspaceId).filter((item) => item.blocks.includes(workOrderId)).length}`;
  getStore().saveWaitingItem({ id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, title: what, who: input.who.trim(),
    expectedAt: input.expectedAt, approximate: input.approximate, followUpAt: input.expectedAt, state: "open", blocks: [workOrderId], source: "manual" });
  return { ok: true, id };
}

/** The person's answer to a waiting item's 「到了吗？」. 「到了」 frees the work it held up for scheduling now. */
export function answerWaiting(ctx: AccessContext, id: string, answer: { kind: "arrived" } | { kind: "cancelled" } | { kind: "deferred"; followUpAt: string }):
  { ok: true } | { ok: false; code: string } {
  try {
    if (answer.kind === "deferred" && answer.followUpAt <= planToday(ctx)) return { ok: false, code: "WAITING_FOLLOW_UP_NOT_FUTURE" };
    return getStore().answerWaitingItem(ctx.workspaceId, id, answer, ctx.principalId).changed ? { ok: true } : { ok: false, code: "WAITING_ITEM_CLOSED" };
  } catch (error) {
    return { ok: false, code: error instanceof Error ? error.message : "WAITING_ANSWER_FAILED" };
  }
}

/**
 * What the screen record says the open session of this order took: minutes in work-like apps since it started.
 * Only with the detail consent, and only ever a suggestion the person confirms at completion — offline work
 * (paper, a lab, a meeting) is invisible to it.
 */
export function suggestedSessionMinutes(ctx: AccessContext, workOrderId: string, now = new Date()): number | undefined {
  const open = getStore().listExecutions(ctx.workspaceId, workOrderId).find((execution) => !execution.endedAt);
  return open ? activityMinutes(ctx, open.startedAt, now.toISOString()) : undefined;
}

/** Productive minutes the screen record holds between two instants, with the detail consent only; under five reads as nothing. */
export function activityMinutes(ctx: AccessContext, from: string, to: string): number | undefined {
  const store = getStore();
  if (store.getSetting(ctx.workspaceId, ACTIVITY_DETAIL_CONSENT) !== "granted") return undefined;
  const start = Date.parse(from), end = Date.parse(to);
  const minutes = store.listActivitySegments(ctx.workspaceId, from)
    .filter((segment) => !segment.idle && PRODUCTIVE.has(segment.category as ActivityCategory))
    .reduce((sum, segment) => sum + Math.max(0, Math.min(Date.parse(segment.end), end) - Math.max(Date.parse(segment.start), start)) / 60_000, 0);
  return minutes >= 5 ? Math.round(minutes) : undefined;
}

/**
 * A byproduct's landing order (see `#materializeByproducts`): it waits for its main order to be *done* — handed in,
 * not necessarily judged — and then has the same day to two days after to land, while the material is fresh.
 */
export function byproductLanding(ctx: AccessContext, order: { payload: unknown }): { dependsOn: string[]; dueDate?: string } | undefined {
  const primaryId = (order.payload as { byproductOf?: string } | undefined)?.byproductOf;
  if (!primaryId) return undefined;
  const store = getStore();
  const primary = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === primaryId);
  if (!primary || !["evidence_review", "accepted"].includes(primary.state)) return { dependsOn: [primaryId] };
  const doneAt = store.listExecutions(ctx.workspaceId, primaryId).map((execution) => execution.endedAt).filter((at): at is string => Boolean(at)).sort().at(-1);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const doneDay = doneAt ? formatInTimeZone(new Date(doneAt), zone, "yyyy-MM-dd") : planToday(ctx);
  return { dependsOn: [], dueDate: new Date(Date.parse(`${doneDay}T00:00:00Z`) + BYPRODUCT_LAG_DAYS * 86_400_000).toISOString().slice(0, 10) };
}

export function releaseDayOf(ctx: AccessContext, order: { id: string; payload: unknown }): string | undefined {
  const waiting = getStore().listWaitingItems(ctx.workspaceId).filter((item) => item.blocks.includes(order.id));
  const today = planToday(ctx);
  const open = waiting.filter((item) => item.state === "open");
  if (open.length) {
    const latest = open.map((item) => item.expectedAt > today ? item.expectedAt : item.followUpAt > today ? item.followUpAt
      : new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)).sort().at(-1);
    return latest;
  }
  if (waiting.length) return undefined;
  const release = (order.payload as { notBefore?: string }).notBefore;
  return release && /^\d{4}-\d{2}-\d{2}$/.test(release) && release > today ? release : undefined;
}

/**
 * The milestone a line's card names. Only an approved one is "current": the card used to take the first milestone of the line
 * in any state, so a line with nothing but unapproved drafts (or an archived starter) announced one of them as where it stood.
 * The earliest-due approved milestone wins; with only drafts, the card says so instead.
 */
export function currentMilestoneLabel(milestones: Array<{ id: string; identityId: string; status: string; title: string }>,
  deadlines: Map<string, string | null | undefined>, identityId: string, locale?: Locale): string {
  const mine = milestones.filter((milestone) => milestone.identityId === identityId);
  const approved = mine.filter((milestone) => milestone.status === "approved")
    .sort((a, b) => (deadlines.get(a.id) ?? "9999").localeCompare(deadlines.get(b.id) ?? "9999"));
  if (approved[0]) return approved[0].title;
  const drafts = mine.filter((milestone) => milestone.status === "draft").length;
  const t = tFor(locale);
  return drafts ? t("{{count}} 个里程碑草稿待批准", { count: drafts }) : t("等待批准里程碑");
}

export const LOCAL_ACTIVITY_CONSENT = "localActivity.consent";
/** The second, separate consent: which app and window were in front. Mirrors the worker's names (it cannot be imported here). */
export const ACTIVITY_DETAIL_CONSENT = "localActivity.consentV2";
export const ACTIVITY_PAUSED_UNTIL = "localActivity.pausedUntil";
export const ACTIVITY_BLACKLIST = "activity.blacklist";

/**
 * What last night's expansion actually did. A night that did not run says so with its reason — the
 * alternative is showing an older expansion as if it were this morning's, which is the same class of
 * lie as a fabricated metric.
 */
export type LastNight = { state: "none" } | { state: "ran"; proposals: number } | { state: "skipped"; reason: string };
export function lastNight(workspaceId: string, now: Date, locale?: Locale): LastNight {
  const since = new Date(now.getTime() - 36 * 60 * 60_000).toISOString();
  const event = [...getStore().listEvents(workspaceId)]
    .reverse()
    .find((item) => item.type.startsWith("flywheel.nightly.") && item.createdAt >= since);
  if (!event) return { state: "none" };
  const payload = event.payload as { code?: string; message?: string; proposals?: number };
  if (event.type === "flywheel.nightly.ran") return { state: "ran", proposals: payload.proposals ?? 0 };
  // Shown on 周复盘: the stored message of a failed run or an unreadable quota is the runtime's own error text (a JSON-RPC body), so
  // those two are said in words by their code.
  const plain: Record<string, string> = { COST_SIGNAL_UNAVAILABLE: "读不到模型额度，今晚不运行。", FLYWHEEL_RUN_FAILED: "扩展运行出错，下一晚重试。" };
  const t = tFor(locale);
  return { state: "skipped", reason: (payload.code && plain[payload.code] ? t(plain[payload.code]!) : undefined) ?? payload.message ?? payload.code ?? t("未记录原因") };
}

const dayOf = (iso: string) => iso.slice(0, 10);

/** Every WorkOrder's first arrival at `accepted`, deduped by entity — a revoke-then-reaccept cycle must
 * not count as two completions of the same thing. */
export function firstAcceptedAt(workspaceId: string): Map<string, string> {
  const earliest = new Map<string, string>();
  for (const event of getStore().listEvents(workspaceId, { type: "work_order.transitioned" })) {
    if ((event.payload as { to?: string }).to !== "accepted") continue;
    const seen = earliest.get(event.entityId);
    if (!seen || event.createdAt < seen) earliest.set(event.entityId, event.createdAt);
  }
  return earliest;
}

/**
 * Streak and weekly count, read straight off real acceptance timestamps. No protected streak and no
 * grace period: a day with nothing accepted yet reads as a real 0, the same "reflect the database's
 * literal current state" rule every other honest-state widget in this app already follows — there is no
 * "keep your streak" nudge and no un-breaking it after the fact. Pure, like `effectiveEstimate` — the
 * hydration (`firstAcceptedAt`'s ledger read) happens in `loadDashboard`.
 */
export function acceptanceProgress(timestamps: string[], timeZone: string, now: Date): { streakDays: number; weekCount: number } {
  const localDay = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(t));
  const weekCount = timestamps.filter((iso) => Date.parse(iso) >= now.getTime() - 7 * 86_400_000).length;
  const days = new Set(timestamps.map((iso) => localDay(Date.parse(iso))));
  let streakDays = 0;
  for (let cursor = now.getTime(); days.has(localDay(cursor)); cursor -= 86_400_000) streakDays += 1;
  return { streakDays, weekCount };
}

/** Interruptions per active hour, per day, from real executions — never from a guess about the day. */
function interruptionDensity(workspaceId: string): Array<{ day: string; perActiveHour: number }> {
  const byDay = new Map<string, { interruptions: number; activeMinutes: number }>();
  for (const execution of getStore().listExecutions(workspaceId)) {
    if (!execution.endedAt || !execution.durationObserved) continue;
    const wall = (Date.parse(execution.endedAt) - Date.parse(execution.startedAt)) / 60_000;
    const activeMinutes = Math.max(0, wall - execution.pauseMinutes);
    const day = dayOf(execution.startedAt);
    const bucket = byDay.get(day) ?? { interruptions: 0, activeMinutes: 0 };
    bucket.interruptions += execution.interruptions.length;
    bucket.activeMinutes += activeMinutes;
    byDay.set(day, bucket);
  }
  return [...byDay.entries()]
    .filter(([, bucket]) => bucket.activeMinutes > 0)
    .map(([day, bucket]) => ({ day, perActiveHour: bucket.interruptions / (bucket.activeMinutes / 60) }));
}

function latestCapacity(ctx: AccessContext, now: Date): DashboardData["capacity"] {
  const store = getStore();
  const observations = store.listEnergyObservations(ctx.workspaceId);
  const consent = store.getSetting(ctx.workspaceId, LOCAL_ACTIVITY_CONSENT);
  return deriveCapacity({
    now: now.toISOString(),
    selfReports: observations
      .filter((item) => item.source === "self_report" && item.level !== "uncalibrated")
      .map((item) => ({ level: item.level as "low" | "medium" | "high", confidence: item.confidence, observedAt: item.observedAt })),
    dailyActivity: observations
      .filter((item) => item.source === "local_activity")
      .map((item) => ({ day: dayOf(item.observedAt), activeMinutes: item.aggregate.activeMinutes ?? 0, windowSwitches: item.aggregate.windowSwitches ?? 0 })),
    interruptionDensity: interruptionDensity(ctx.workspaceId),
    localActivityConsent: consent === "granted" ? "granted" : consent === "denied" ? "denied" : "unasked",
    locale: localeFor(ctx)
  });
}

const toAction = (ctx: AccessContext, order: ActionableOrder | undefined, reason: string): DashboardAction | undefined => order ? ({
  id: order.id,
  title: order.intent,
  identityId: order.identityId,
  estimate: resolvedEstimate(ctx, order),
  ...(humanCoreOf(order)?.energy ? { energy: humanCoreOf(order)!.energy as "low" | "medium" | "high" } : {}),
  reason,
  // An unbound task (analysed before any milestone existed, or serving none) is not waiting for anything; it says so.
  milestone: getStore().listMilestones(ctx.workspaceId).find((item) => item.id === order.milestoneId)?.title ?? tOf(ctx)("未挂里程碑"),
  inputsReady: inputsReady(order)
}) : undefined;

// `taskDetailById`/`milestoneDetailById` are deliberately not part of this return type: they're batched
// in `page.tsx` instead, to avoid a circular import between this file and `lib/task-detail.ts` (which
// already imports from here). `page.tsx` spreads them into what this returns before handing it to
// `DashboardView`.
/**
 * What the Today head says about energy (docs/energy-and-ecosystem.md §3.4): the model's reading of now — the one the schedule uses —
 * with its basis, the day's capacity when it is held below its share, and the person's own word when they gave it in the last four
 * hours (which then also stands for the current slot).
 */
function energyEstimateFor(ctx: AccessContext, now: Date, today: string, timeZone: string): NonNullable<DashboardData["energyEstimate"]> {
  const model = energyModel(ctx, readAvailability(ctx));
  const prediction = model.predict(now.toISOString());
  // The day's curve for Today's energy card (2026-10-28): the same model read every half hour from 06:00 to midnight, with the person's
  // own cut points between low, medium and high. Without a known last sleep the model reads nothing, and no curve is drawn.
  const points = Array.from({ length: 36 }, (_, index) => 360 + index * 30).flatMap((minute) => {
    let at: string;
    try { at = toZonedInstant(today, `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`, timeZone); } catch { return []; }
    const alertness = model.predict(at).alertness;
    return alertness === undefined ? [] : [{ minute, alertness }];
  });
  const [hour = "0", minuteOfHour = "0"] = formatInTimeZone(now, timeZone, "HH:mm").split(":");
  const curve = points.length >= 12 ? { points, low: model.calibration.low, high: model.calibration.high, nowMinute: Number(hour) * 60 + Number(minuteOfHour) } : undefined;
  const capacity = model.capacity(now.toISOString(), today);
  const report = getStore().listEnergyObservations(ctx.workspaceId)
    .filter((item) => item.source === "self_report" && item.level !== "uncalibrated" && now.getTime() - Date.parse(item.observedAt) < 4 * 3_600_000)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  return { level: prediction.level, confidence: prediction.confidence, basis: prediction.basis,
    ...(capacity.multiplier < 1 ? { capacity } : {}),
    ...(report ? { selfReport: report.level as "low" | "medium" | "high" } : {}),
    ...(curve ? { curve } : {}) };
}

export async function loadDashboard(ctx: AccessContext): Promise<Omit<DashboardData, "taskDetailById" | "milestoneDetailById">> {
  const t = tOf(ctx);
  ensureSeeded(ctx);
  const store = getStore();
  const orders = store.listWorkOrders(ctx.workspaceId);
  // Row order must not leak into the page: `updated_at` ties break on id, so whether the clock
  // ticked mid-seed decided the order and Today reshuffled between loads.
  // Capacity is a constraint, not an identity competing for the same list. Keyed on the pack's `kind`
  // rather than the literal id "health", so a different pack set keeps the same distinction.
  const capacityIdentityIds = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();
  // Work waiting in the task library is not recommended either: it enters 「下一步」 when it enters the schedule.
  const libraryDay = planToday(ctx, now);
  const active = withoutShadowingDemos(orders, capacityIdentityIds)
    .filter((order) => !capacityIdentityIds.has(order.identityId) && ACTIONABLE.includes(order.state) && !libraryUntil(ctx, order, libraryDay))
    .sort((a, b) => ACTIONABLE.indexOf(a.state) - ACTIONABLE.indexOf(b.state) || a.id.localeCompare(b.id));
  const capacity = latestCapacity(ctx, now);
  const outcomes = readTransitionOutcomes(store.listEvents(ctx.workspaceId, { type: "energy.transition_outcome" }));
  const forecast = capacity.level === "uncalibrated" ? {} : Object.fromEntries(active.flatMap((order) => {
    const needed = humanCoreOf(order)?.energy;
    return needed === "low" || needed === "medium" || needed === "high"
      ? [[order.id, predictEnergyTransition(capacity.level as "low" | "medium" | "high",
        needed, outcomes).predicted]] : [];
  }));
  // Work that may not start yet — a homework not out, a wait not answered (`releaseDayOf`) — is not offered as 「下一步」 with 开始计时:
  // the scheduler already kept it off today, and the recommendation offered 「完成 ECE 555 作业 3」 before it was posted (2026-10-15).
  const startable = active.filter((order) => { const release = releaseDayOf(ctx, order); return !release || release <= libraryDay; });
  const actions = recommendNextActions(startable.map((order) => plannerTaskOf(ctx, order)), 40,
    capacity.level === "uncalibrated" ? undefined : capacity.level, now, forecast);
  const milestones = store.listMilestones(ctx.workspaceId);
  const identityPacks = identityLines(ctx);
  const timeZone = readSchedulePreferences(ctx)?.timeZone
    ?? process.env.CROSSLINE_TIME_ZONE?.trim() ?? "America/Chicago";
  const time = new Intl.DateTimeFormat(intlLocale(localeFor(ctx)), {
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone
  }).format(now);
  const acceptedAt = firstAcceptedAt(ctx.workspaceId);
  const progress = acceptanceProgress([...acceptedAt.values()], timeZone, now);

  // Today's own capacity read: the weekly pattern for today only, not the calendar-adjusted multi-week
  // forecast Plan already owns.
  const today = planToday(ctx, now);
  const committedMinutes = active.reduce((sum, order) => sum + resolvedEstimate(ctx, order).p50Minutes, 0);

  // Reuses the same Plan-page scheduling read (`loadCurrentPlan` → `scheduledBlocks`) so Today's line and
  // the B lens agree on what "14:00–14:40" means instead of Today inventing a second notion of "when".
  // This is what makes `loadDashboard` async now — it used to stay sync specifically to avoid this call.
  const plan = await loadCurrentPlan(ctx);
  // What is still usable today: the weekly pattern minus today's calendar commitments, from now on. It
  // used to count the whole day's pattern, so at 21:10 the header still said 420 minutes were free.
  const busyToday = plan.blocks.filter((block) => (block.day ?? today) === today && !block.id.startsWith("scheduled:"))
    .map((block) => ({ day: today, start: block.start, end: block.end }));
  const availableMinutes = remainingMinutes(availableSlots(readAvailability(ctx), [today], busyToday),
    formatInTimeZone(now, timeZone, "HH:mm"));
  const blockByWorkOrderToday = new Map(plan.blocks
    .filter((block) => (block.day ?? today) === today && block.id.startsWith("scheduled:"))
    .map((block) => [block.id.split(":")[1]!, block]));
  const milestoneTitleById = new Map(milestones.map((milestone) => [milestone.id, milestone.title]));

  // Read once, shared by both `flywheel` and `flywheelStrip` below — they used to each run this same
  // query independently.
  const approvedOrCandidateRelations = store.listMilestoneRelations(ctx.workspaceId)
    // Approved and candidate both show — same distinction the star map already draws with a dashed
    // line ("虚线为待周复盘确认"), just spelled out in words instead of a line style.
    .filter((relation) => relation.status === "approved" || relation.status === "candidate");

  // Cross-identity relations touching a milestone behind today's actionable work — the plain-English
  // "doing A moves B forward" that the star map only ever shows as an edge and a one-word kind label.
  const todayMilestoneIds = new Set(active.map((order) => order.milestoneId));
  const flywheel = approvedOrCandidateRelations
    .filter((relation) => todayMilestoneIds.has(relation.fromMilestoneId) || todayMilestoneIds.has(relation.toMilestoneId))
    .slice(0, 3)
    .map((relation) => ({
      id: relation.id,
      fromTitle: milestones.find((item) => item.id === relation.fromMilestoneId)?.title ?? relation.fromMilestoneId,
      toTitle: milestones.find((item) => item.id === relation.toMilestoneId)?.title ?? relation.toMilestoneId,
      kindLabel: relationKindLabel[relation.kind] ?? relation.kind,
      explanation: relation.explanation,
      pending: relation.status === "candidate"
    }));

  // Milestone-centric flywheel strip: nodes are milestones touched by any approved/candidate relation,
  // ordered left-to-right by their most recent real signal (a gate judgement or an acceptance recorded
  // against them) so newly active milestones surface at the right edge. Resolved fresh on every page
  // load — not a live push — so "grows to the right" means "next time this loads", which is what an
  // SSR app can promise; a milestone with a relation but no activity yet just sorts toward the left.
  const flywheelStrip = (() => {
    const relations = approvedOrCandidateRelations;
    if (!relations.length) return { nodes: [], edges: [] };

    const milestoneById = new Map(milestones.map((item) => [item.id, item]));
    const nodeIds = new Set<string>();
    for (const relation of relations) {
      if (milestoneById.has(relation.fromMilestoneId)) nodeIds.add(relation.fromMilestoneId);
      if (milestoneById.has(relation.toMilestoneId)) nodeIds.add(relation.toMilestoneId);
    }

    const gateEvents = store.listEvents(ctx.workspaceId, { type: "milestone_gate.judged" });
    const latestGateAt = new Map<string, string>();
    for (const event of gateEvents) {
      const milestoneId = (event.payload as { milestoneId?: string }).milestoneId;
      if (!milestoneId) continue;
      const seen = latestGateAt.get(milestoneId);
      if (!seen || event.createdAt > seen) latestGateAt.set(milestoneId, event.createdAt);
    }
    const latestAcceptedAtByMilestone = new Map<string, string>();
    for (const order of orders) {
      const when = acceptedAt.get(order.id);
      if (!when || !order.milestoneId) continue;
      const seen = latestAcceptedAtByMilestone.get(order.milestoneId);
      if (!seen || when > seen) latestAcceptedAtByMilestone.set(order.milestoneId, when);
    }
    const recencyOf = (milestoneId: string) => {
      const a = latestGateAt.get(milestoneId) ?? "";
      const b = latestAcceptedAtByMilestone.get(milestoneId) ?? "";
      return a > b ? a : b;
    };

    const nodes = [...nodeIds].map((id) => {
      const milestone = milestoneById.get(id)!;
      const acceptedCount = orders.filter((order) => order.milestoneId === id && order.state === "accepted").length;
      const gateCount = gateEvents.filter((event) => (event.payload as { milestoneId?: string }).milestoneId === id).length;
      const latestSignal = acceptedCount > 0 ? t("已验收 {{count}} 次", { count: acceptedCount })
        : gateCount > 0 ? t("已判定 {{count}} 次", { count: gateCount }) : t("等待进展");
      return { id, identityId: milestone.identityId, title: milestone.title, latestSignal, recency: recencyOf(id) };
    }).sort((a, b) => a.recency < b.recency ? -1 : a.recency > b.recency ? 1 : 0);

    const nodeIndex = new Set(nodes.map((node) => node.id));
    const edgeBuckets = new Map<string, { from: string; to: string; kinds: Record<string, number>; pending: boolean; count: number }>();
    for (const relation of relations) {
      if (!nodeIndex.has(relation.fromMilestoneId) || !nodeIndex.has(relation.toMilestoneId)) continue;
      const key = `${relation.fromMilestoneId}->${relation.toMilestoneId}`;
      const bucket = edgeBuckets.get(key) ?? { from: relation.fromMilestoneId, to: relation.toMilestoneId, kinds: {}, pending: false, count: 0 };
      bucket.kinds[relation.kind] = (bucket.kinds[relation.kind] ?? 0) + 1;
      bucket.count += 1;
      if (relation.status === "candidate") bucket.pending = true;
      edgeBuckets.set(key, bucket);
    }
    const edges = [...edgeBuckets.values()].map((bucket) => {
      const topKind = Object.entries(bucket.kinds).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      return { from: bucket.from, to: bucket.to, count: bucket.count, pending: bucket.pending, kindLabel: relationKindLabel[topKind] ? t(relationKindLabel[topKind]!) : topKind };
    });

    return { nodes: nodes.map(({ id, identityId, title, latestSignal }) => ({ id, identityId, title, latestSignal })), edges };
  })();

  const stepPlans = new Map(store.listStepPlans(ctx.workspaceId).map((plan) => [plan.workOrderId, plan]));
  const planBlocked = new Set(store.listEvents(ctx.workspaceId, { type: "task.steps_blocked" }).map((event) => event.entityId));
  const readyProposals = orders.filter((order) => order.state === "awaiting_plan_approval" && !(order.payload as { seeded?: boolean } | undefined)?.seeded
    && proposalReady(order, stepPlans.get(order.id), { planBlocked: planBlocked.has(order.id), exempt: capacityIdentityIds.has(order.identityId) }));
  // Unapproved work is never scheduled, so a proposal due within a week is named above 「下一步」 (W-31).
  const anchorDays = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const urgentProposal = nearestDueProposal(readyProposals.map((order) => ({ id: order.id, title: taskTitleOf(order),
    due: (order.payload as { dueDate?: string } | undefined)?.dueDate || (order.milestoneId ? readGoalSettings(ctx, order.milestoneId)?.confirmedDeadline ?? anchorDays.get(order.milestoneId) : undefined) })), libraryDay);
  const energySelected = capacity.level !== "uncalibrated";
  const primaryReason = energySelected
    ? actions.primary?.deadline && Date.parse(actions.primary.deadline) - now.getTime() <= 24 * 60 * 60_000
      ? t("已确认截止时间临近；即使当前精力不匹配仍优先显示，请考虑先休息 10 分钟")
      : actions.primary?.energy === capacity.level
        ? t(capacity.level === "low" ? "当前低精力自评与所需精力匹配，输入已就绪" : capacity.level === "high" ? "当前高精力自评与所需精力匹配，输入已就绪"
          : "当前中精力自评与所需精力匹配，输入已就绪")
        : t("暂无精力完全匹配的就绪作业，展示可执行的最高优先级备选")
    : t("输入已就绪，按目标重要性和估时推荐；尚无新鲜精力自评");
  const primary = toAction(ctx, active.find((task) => task.id === actions.primary?.id), primaryReason);
  const higherPriority = toAction(ctx, active.find((task) => task.id === actions.higherPriority?.id),
    t("优先级更高，但当前精力与任务要求不匹配；保留供本人决定"));
  const lowEnergy = toAction(ctx, active.find((task) => task.id === actions.lowEnergy?.id), t("标注为低精力任务，启动阻力最小"));
  const shortGap = toAction(ctx, active.find((task) => task.id === actions.shortGap?.id), t("先验 p85 在 40 分钟以内，可放进短空档"));
  return {
    principalId: ctx.principalId,
    workspaceId: ctx.workspaceId,
    nowLabel: time,
    nowIso: now.toISOString(),
    timeZone,
    clockPinned: Boolean(process.env.CROSSLINE_FIXED_NOW),
    dateLabel: new Intl.DateTimeFormat("en-US", { day: "2-digit", timeZone }).format(now),
    monthLabel: new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone }).format(now).toUpperCase(),
    // 「本机活动采集未开启」 points at a switch only this computer's owner has (2026-10-15 walkthrough): not said to a guest.
    capacity: assistantAvailable(store, ctx.workspaceId) ? capacity
      : { ...capacity, blockers: capacity.blockers.filter((blocker) => blocker.code !== "LOCAL_ACTIVITY_NOT_AUTHORISED") },
    energyEstimate: energyEstimateFor(ctx, now, today, timeZone),
    energyLearning: energyCalibration(outcomes),
    // Only proposals that are decisions already: one whose steps are still being planned is not counted (`proposalReady`, W-31).
    awaitingApproval: readyProposals.length,
    ...(urgentProposal ? { urgentProposal } : {}),
    // Milestones that exist and wait for approval, and whether any exist at all: an empty 「下一步」 says which step comes next.
    milestones: { drafts: new Set(store.listMilestones(ctx.workspaceId).filter((item) => item.status === "draft").map((item) => item.id)).size,
      any: store.listMilestones(ctx.workspaceId).some((item) => item.status !== "archived"),
      firstDrafts: firstDraftsState(store.getSetting(ctx.workspaceId, FIRST_DRAFTS_SETTING), store.listMilestones(ctx.workspaceId).some((item) => item.status !== "archived"), now),
      backplanning: milestonesBeingBackplanned(store, ctx.workspaceId, libraryDay) },
    ...(primary ? { primary } : {}),
    ...(higherPriority ? { higherPriority } : {}),
    ...(lowEnergy ? { lowEnergy } : {}),
    ...(shortGap ? { shortGap } : {}),
    care: store.listCapacityCommitments(ctx.workspaceId).map((item) => ({ title: item.title, minimumMinutes: item.minimumMinutes })),
    progress,
    todayCapacity: { availableMinutes, committedMinutes },
    flywheel,
    flywheelStrip,
    identities: identityPacks.map((pack) => {
      const anchorsByMilestone = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
      const identityOrders = orders.filter((order) => order.identityId === pack.id);
      const completed = identityOrders.filter((order) => order.state === "accepted").length;
      const total = identityOrders.length;
      return {
        id: pack.id,
        label: pack.label,
        accent: accents[pack.id] ?? "#6D5EF5",
        completedCount: completed,
        activeMilestone: currentMilestoneLabel(milestones, anchorsByMilestone, pack.id, localeFor(ctx)),
        taskCount: total - completed,
        totalCount: total,
        pct: total > 0 ? Math.round((completed / total) * 100) : 0
      };
    }),
    // Ordered by what needs the person next, then capped — not captures first, then whatever fits.
    // With captures first, six raw notes filled the whole list and the proposal that had just come back
    // from analysis was pushed off the page, which is the same broken link as never listing it at all.
    // A `discarded` capture is not listed at all; it used to fall through to the 「正在分析」 branch and
    // come back as though the system were still working on something the person had thrown away.
    upcoming: [
      ...orders.filter((order) => order.state === "awaiting_plan_approval").map((order) => ({
        id: order.id, title: order.intent, identityId: order.identityId, status: t("待批准"),
        ...(order.milestoneId && milestoneTitleById.has(order.milestoneId)
          ? { milestoneTitle: milestoneTitleById.get(order.milestoneId)! } : {})
      })),
      // A scheduled block's real `HH:mm–HH:mm` beats a duration guess whenever the planner actually
      // placed this order today; when it did not (dependency blocker, no capacity left, pushed to a
      // later day), `time` stays unset and the status text says so explicitly instead of a vague "待排程".
      ...active.map((order) => {
        const block = blockByWorkOrderToday.get(order.id);
        const status = order.state === "approved" ? t("已批准 · 等待材料")
          : order.state === "preparing" ? t("材料准备中")
          : order.state === "active" ? t("执行中")
          : block ? t("预计 {{minutes}} 分钟", { minutes: resolvedEstimate(ctx, order).p50Minutes })
          : t("预计 {{minutes}} 分钟 · 规划器未排入今天", { minutes: resolvedEstimate(ctx, order).p50Minutes });
        return {
          id: order.id, title: order.intent, identityId: order.identityId, status,
          ...(block ? { time: `${block.start}–${block.end}` } : {}),
          ...(order.milestoneId && milestoneTitleById.has(order.milestoneId)
            ? { milestoneTitle: milestoneTitleById.get(order.milestoneId)! } : {})
        };
      }),
      ...store.listCaptures(ctx.workspaceId)
        .filter((item) => item.state === "blocked" || item.state === "captured" || item.state === "analyzing")
        .map((item) => ({
          id: item.id, title: item.title, identityId: "unclassified",
          status: item.state === "captured" ? t("已保存 · 未分类 / 未估时 · Workbench 分析")
            : item.state === "blocked" ? t("分析阻塞 · 可人工处理") : t("正在分析")
        }))
    ].slice(0, 6),
    // Real activity, not a proxy read off `milestone.status` alone — that used to call every
    // milestone-bound WorkOrder still in flight "零进展" the moment it had not yet reached
    // `accepted`, which is the everyday case, not the exception.
    milestonePulse: milestones.slice(0, 4).map((milestone) => {
      const acceptedCount = [...acceptedAt.keys()]
        .filter((id) => orders.find((order) => order.id === id)?.milestoneId === milestone.id).length;
      return {
        id: milestone.id,
        identity: ((label) => label ? t(label) : milestone.identityId)(identityPacks.find((pack) => pack.id === milestone.identityId)?.label),
        title: milestone.title,
        evidence: acceptedCount
          ? t(milestone.status === "approved" ? "已批准 · 已验收 {{count}} 次" : "等待批准 · 已验收 {{count}} 次", { count: acceptedCount })
          : milestone.status === "approved" ? t("已批准 · 等待新证据") : t("等待批准")
      };
    })
  };
}
