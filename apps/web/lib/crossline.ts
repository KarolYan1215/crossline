import "server-only";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { CrosslineStore, type EvidenceClaimInput, type StoredMilestone } from "@crossline/db";
import { availableSlots, deriveCapacity, requiredApproval, validateAvailability, DEFAULT_AVAILABILITY,
  defaultMilestoneTemplates, computeMilestoneConfidence, PRODUCTIVE, type ActivityCategory, validateSuccessCriteria, goalSettingKey, ANALYSIS_CONTEXT_VERSION, calibrationReport, calibratedEstimate,
  type CalibrationReport, presetImportance, taskTitleOf, type ImportancePreset, restoreTargetOf,
  type AccessContext, type AvailabilityWindow, type Estimate, type SuccessCriterion, type ChecklistAnswer, FIXED_EVENTS, fixedEventBlocks, type FixedEvent } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { forecastGoals, normalizeParams, paramsFor, planSchedule, recommendNextActions, type ForecastResult, type PlanResult,
  type ScheduleParams } from "@crossline/planner";
import { energyCalibration, predictEnergyTransition, readTransitionOutcomes } from "./energy-learning";
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
  return new Intl.DateTimeFormat("en-CA", { timeZone: (ctx && readSchedulePreferences(ctx)?.timeZone)
    ?? process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago" }).format(now);
}

/** The key the weekly availability lives under. One settings row, not a new table. */
export { AVAILABILITY_SETTING } from "@crossline/core";
import { AVAILABILITY_SETTING, RELATION_KIND_LABEL } from "@crossline/core";
import { identityLines, linePacks } from "./lines";
const PREFERENCES_SETTING = "schedule.preferences";
export type SchedulePreferences = { timeZone: string; mode: "buffered" | "asap";
  importance: Record<string, "important" | "ordinary">;
  /** The four packing numbers set on the plan page; absent, `mode` stands for its preset. */
  params?: ScheduleParams };

export type GoalSettings = { importance: "important" | "ordinary";
  confirmedDeadline: string | null; sourceQuote: string | null;
  /** 0–100, set with the slider; `importance` follows it (60 and above is important). */
  weight?: number };
const goalKey = goalSettingKey;

export function readGoalSettings(ctx: AccessContext, id: string): GoalSettings | null {
  const raw = getStore().getSetting(ctx.workspaceId, goalKey(id));
  if (!raw) return null;
  try { return JSON.parse(raw) as GoalSettings; } catch { return null; }
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
    // A partial save (only a deadline, say) on a goal with no settings yet keeps the importance the schedule already used for it.
    : input.importance === undefined ? previous?.importance ?? readSchedulePreferences(ctx)?.importance[id] ?? "ordinary" : undefined;
  if (importance !== "important" && importance !== "ordinary") return { ok: false, code: "GOAL_IMPORTANCE_INVALID" };
  const date = input.confirmedDeadline === undefined ? previous?.confirmedDeadline ?? null : input.confirmedDeadline;
  if (date !== null && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date))
    return { ok: false, code: "GOAL_DEADLINE_INVALID" };
  const quote = typeof input.sourceQuote === "string" ? input.sourceQuote.trim() : previous?.sourceQuote ?? "";
  if (quote.length > 500) return { ok: false, code: "GOAL_QUOTE_TOO_LONG" };
  const next: GoalSettings = { importance, confirmedDeadline: date as string | null,
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
      pastAdjustments: [...(adjustments.get(item.identityId)?.values() ?? [])] })];
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
    new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
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
  const raw = getStore().getSetting(ctx.workspaceId, AVAILABILITY_SETTING);
  if (!raw) return DEFAULT_AVAILABILITY;
  try { return validateAvailability(JSON.parse(raw)); } catch { return DEFAULT_AVAILABILITY; }
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
  status: "draft" | "approved" | "superseded";
  blocks: PersistedScheduleBlock[];
  schedule: Pick<PlanResult, "status" | "blockers" | "solver" | "bufferRelaxed" | "notes">;
  /** True when nobody has saved a real time zone/availability/mode yet and this is computed off
   * defaults — a real, honestly-labelled preview rather than an empty page. */
  usingDefaultPreferences: boolean;
  changes: Array<{
    id: string;
    kind: "add" | "move" | "remove" | "conflict";
    explanation: string;
    afterBlockId?: string;
    status: "pending" | "approved" | "excluded";
  }>;
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

// A prior is honest only when it really comes from the pack. Deriving p25/p85 from one hand-written
// number and labelling the result `identity_prior` was a fabricated interval wearing a real label.
function identityPrior(identityId: string, family: string) {
  const pack = defaultIdentityPacks().find((item) => item.id === identityId && item.kind === "identity");
  const prior = pack?.durationPriors[family] ?? pack?.durationPriors.review;
  return { ...(prior ?? { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 }),
    source: "identity_prior" as const, observationCount: 0, confidence: "low" as const };
}

/** The two example diffs a pre-scheduler database was seeded with, cleared once on open. */
const RETIRED_SEED_CHANGES = ["personal-plan-v1-change-1", "personal-plan-v1-change-2"];

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

/**
 * True for a workspace nobody has set up yet: no profile, no interview, no goals, no work. Such a person is
 * sent to the interview instead of an empty board that tells them nothing.
 */
export function needsOnboarding(ctx: AccessContext): boolean {
  // Seeding first: with example data switched on, a brand-new account has its board only after this runs.
  ensureSeeded(ctx);
  const store = getStore();
  return !store.listProfileFacts(ctx.workspaceId).length
    && !store.getLatestOnboardingSession(ctx.workspaceId)
    && !store.listMilestones(ctx.workspaceId).some((milestone) => milestone.status !== "archived")
    && !store.listWorkOrders(ctx.workspaceId).length;
}

export function ensureSeeded(ctx: AccessContext): void {
  const store = getStore();
  // Example milestones, relations and work orders exist only so the e2e suite and the unit tests have a board
  // to drive. A real account starts empty: its goals come from the interview, not from four placeholders that
  // every user shared and none of them chose.
  if (process.env.CROSSLINE_SEED_EXAMPLES === "1") {
    // Earlier seeds wrote no projectId, and analysis only offers milestones that have one, so an existing
    // database would stay permanently unanalysable. Re-seeding is idempotent and repairs those rows.
    const seeded = store.listMilestones(ctx.workspaceId);
    if (seeded.length === 0 || seeded.some((milestone) => milestone.id.endsWith("-starter") && !milestone.projectId)) {
      for (const pack of seedIdentities()) {
        store.saveMilestone({
          id: `${pack.id}-starter`, ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
          identityId: pack.id, projectId: `${pack.id}-default`,
          title: starterMilestoneTitles[pack.id] ?? `为「${pack.label}」确定第一个可验收的里程碑`,
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
          ?? { title: `写下「${pack.label}」当前最该推进的一件事`, energy: "medium" as const, priorFamily: "review" };
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
      version: 1, status: "draft", payload: { blocks: [] }
    });
  }

  // A database seeded before the scheduler was wired up still holds the five example blocks and the
  // two example diffs. `loadCurrentPlan` no longer reads the blocks, but the diffs are `pending` and
  // `approvePlanVersion` refuses while anything is pending — so leaving them would make the plan
  // permanently unapprovable over demo rows that no longer mean anything.
  for (const changeId of RETIRED_SEED_CHANGES) {
    const change = store.listPlanChanges(ctx.workspaceId, "personal-plan-v1").find((item) => item.id === changeId);
    if (change && change.status === "pending") store.savePlanChange({ ...change, status: "excluded" });
  }
  for (const plan of store.listPlanVersions(ctx.workspaceId)) {
    const blocks = (plan.payload as { blocks?: PersistedScheduleBlock[] }).blocks ?? [];
    const real = blocks.filter((block) => block.source !== "示例数据");
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
export function toZonedInstant(day: string, time: string, zone: string): string {
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
/** Blocks the person started from a pencilled-in (off-hours) block: fixed at that time, as real as anything scheduled. */
export const SCHEDULE_PINS = "schedule.pins";
type Pin = { taskId: string; day: string; start: string; end: string };
export function readPins(ctx: AccessContext, today: string): Pin[] {
  try { return (JSON.parse(getStore().getSetting(ctx.workspaceId, SCHEDULE_PINS) ?? "[]") as Pin[]).filter((pin) => pin.day >= today); }
  catch { return []; }
}
/**
 * Local re-planning (decided 2026-10-08): when an event is added, the work blocks it does not touch stay where they were and only the
 * ones it lands on move. The blocks to keep are written here with an expiry a week out; the scheduler freezes those still valid — the task
 * still open, the slot not taken by anything since — and places the rest. A change that should re-plan everything (availability, packing
 * numbers, importance) clears it.
 */
export const SCHEDULE_KEEP = "schedule.keep";
export function readKeep(ctx: AccessContext, today: string, now: Date): Pin[] {
  try {
    const kept = JSON.parse(getStore().getSetting(ctx.workspaceId, SCHEDULE_KEEP) ?? "null") as { until?: string; blocks?: Pin[] } | null;
    return kept?.until && Date.parse(kept.until) > now.getTime() ? (kept.blocks ?? []).filter((pin) => pin.day >= today) : [];
  } catch { return []; }
}
export function writeKeep(ctx: AccessContext, blocks: Pin[], now: Date): void {
  getStore().setSetting(ctx.workspaceId, SCHEDULE_KEEP, JSON.stringify({ until: new Date(now.getTime() + 7 * 86_400_000).toISOString(), blocks }));
}

/** Starting a pencilled-in block makes it formal: its time is kept for that task (or step) from now on. */
export function pinBlock(ctx: AccessContext, blockId: string, at: { day: string; start: string; end: string }): { ok: true } | { ok: false; code: string } {
  if (!blockId.startsWith("optional:") || !/^\d{4}-\d{2}-\d{2}$/.test(at.day) || !/^\d{2}:\d{2}$/.test(at.start) || !/^\d{2}:\d{2}$/.test(at.end) || at.end <= at.start)
    return { ok: false, code: "PIN_INVALID" };
  const taskId = plannerIdOfBlock(blockId);
  const pins = readPins(ctx, planToday(ctx)).filter((pin) => pin.taskId !== taskId);
  getStore().setSetting(ctx.workspaceId, SCHEDULE_PINS, JSON.stringify([...pins, { taskId, ...at }]));
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
  availability?: AvailabilityWindow[]; params?: ScheduleParams; weights?: Record<string, number> };
const previewScope = new AsyncLocalStorage<PreviewOverrides>();
export const withPreview = <T>(overrides: PreviewOverrides, run: () => T): T => previewScope.run(overrides, run);
const scaledEstimate = <E extends { p25Minutes: number; p50Minutes: number; p85Minutes: number }>(estimate: E, p50: number | undefined): E =>
  p50 === undefined || p50 <= 0 ? estimate : { ...estimate, p50Minutes: Math.round(p50), p25Minutes: Math.max(1, Math.round(estimate.p25Minutes * p50 / Math.max(1, estimate.p50Minutes))),
    p85Minutes: Math.max(Math.round(p50), Math.round(estimate.p85Minutes * p50 / Math.max(1, estimate.p50Minutes))) };

/**
 * The planner's input for a set of orders. A task with a step plan is placed step by step: each open, schedulable step is its own
 * planner task, keeping the task's tier, deadline and release, the step's own window, and its dependencies (on earlier steps, and for
 * its first steps on the work the task itself waits for). A task without a plan yet is placed whole, as before.
 */
function plannerItemsFor(ctx: AccessContext, orders: ActionableOrder[]) {
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const overrides = previewScope.getStore()?.estimates ?? {};
  const stepPlans = new Map(getStore().listStepPlans(ctx.workspaceId).map((plan) => [plan.workOrderId, plan]));
  const openSteps = (orderId: string) => stepPlans.get(orderId)?.steps.filter((step) => step.status === "planned" && step.schedulable) ?? [];
  const plannerIdsOf = (orderId: string) => { const steps = openSteps(orderId); return steps.length ? steps.map((step) => stepTaskId(orderId, step.id)) : [orderId]; };
  return orders.flatMap((order) => {
    const base = plannerTaskOf(ctx, order);
    const steps = openSteps(order.id);
    if (!steps.length) return [{ task: base, orderId: order.id, title: order.intent, step: undefined as string | undefined }];
    const open = new Set(steps.map((step) => step.id));
    const external = (base.dependsOn ?? []).flatMap((id) => plannerIdsOf(id));
    return steps.map((step) => {
      const internal = step.dependsOn.filter((dep) => open.has(dep)).map((dep) => stepTaskId(order.id, dep));
      const stepStart = step.notBefore ? toZonedInstant(step.notBefore, "00:00", zone) : undefined;
      const stepDue = step.dueBy ? toZonedInstant(step.dueBy, "23:59", zone) : undefined;
      const notBefore = [base.notBefore, stepStart].filter(Boolean).sort().at(-1);
      const deadline = [base.deadline, stepDue].filter(Boolean).sort()[0];
      const { notBefore: _n, deadline: _d, dependsOn: _deps, ...rest } = base;
      const id = stepTaskId(order.id, step.id);
      return { orderId: order.id, title: `${order.intent} · ${step.title}`, step: step.title as string | undefined, task: { ...rest, id,
        title: `${order.intent} · ${step.title}`, estimate: scaledEstimate({ ...base.estimate, ...step.estimate }, overrides[id]),
        ...(notBefore ? { notBefore } : {}), ...(deadline ? { deadline } : {}),
        ...(internal.length || external.length ? { dependsOn: internal.length ? internal : external } : {}) } };
    });
  });
}

async function scheduledBlocks(ctx: AccessContext, today: string, committed: PersistedScheduleBlock[]): Promise<{
  blocks: PersistedScheduleBlock[]; schedule: PersistedPlan["schedule"]
}> {
  const days = planDays(today);
  const busy = committed.filter((block) => block.day)
    .map((block) => ({ day: block.day!, start: block.start, end: block.end }));
  const slots = availableSlots(readAvailability(ctx), days, busy);
  const preferences = effectiveSchedulePreferences(ctx).preferences;
  const zone = preferences.timeZone;
  const iso = (day: string, time: string) => toZonedInstant(day, time, zone);
  const now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();
  const capacity = latestCapacity(ctx, now);
  const currentEnergy = capacity.basis.includes("self_report") && capacity.level !== "uncalibrated"
    ? capacity.level : undefined;
  const currentClock = formatInTimeZone(now, zone, "HH:mm");
  const currentSlot = slots.findIndex((slot) => slot.day === today && slot.end > currentClock);
  const clockBlockers: PlanResult["blockers"] = [];
  const instants = slots.flatMap((slot, index) => {
    try { return [{ start: iso(slot.day, slot.start), end: iso(slot.day, slot.end),
      day: slot.day, energy: currentEnergy && index === currentSlot ? currentEnergy : slot.energy }]; }
    catch (error) {
      clockBlockers.push({ taskId: "availability", code: error instanceof Error ? error.message : "AVAILABILITY_LOCAL_TIME_INVALID",
        message: `${slot.day} ${slot.start}–${slot.end} 跨越时钟调整，请修改这段可用时间` });
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
      message: `${order.intent}的前置作业尚未验收，暂不排入` }));
  const eligibleOrders = orders.filter((order) => !dependencyBlockers.some((item) => item.taskId === order.id) && !libraryUntil(ctx, order, today));
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
  const pins = readPins(ctx, today).filter((pin) => expanded.some((item) => item.task.id === pin.taskId));
  const overlapsBusy = (pin: Pin) => busy.some((block) => block.day === pin.day && block.start < pin.end && block.end > pin.start);
  const kept = readKeep(ctx, today, now).filter((pin) => expanded.some((item) => item.task.id === pin.taskId) && !pins.some((other) => other.taskId === pin.taskId) && !overlapsBusy(pin));
  const pinned = [...pins, ...kept].flatMap((pin) => { try { return [{ taskId: pin.taskId, start: iso(pin.day, pin.start), end: iso(pin.day, pin.end) }]; } catch { return []; } });
  const result = await planSchedule({
    now,
    horizonDays: days.length,
    mode: preferences.mode, params: effectiveParams(ctx),
    ...(currentEnergy ? { currentEnergy, currentDay: today } : {}),
    tasks: expanded.map((item) => item.task),
    availability: instants,
    ...(lookaheadAvailability ? { lookaheadAvailability } : {}),
    frozenBlocks: [...committed.filter((block) => block.day && block.id.startsWith("scheduled:"))
      .map((block) => ({ taskId: plannerIdOfBlock(block.id), start: iso(block.day!, block.start),
        end: iso(block.day!, block.end) })), ...pinned]
  });
  const placed = result.plan.blocks.filter((block) => !block.frozen);
  const orderStates = new Map(orders.map((order) => [order.id, order.state]));
  const itemById = new Map(expanded.map((item) => [item.task.id, item]));
  const intents = new Map(orders.map((order) => [order.id, taskTitleOf(order)]));
  const tentative = (taskId: string) => ["approved", "preparing"].includes(orderStates.get(taskId.split("#")[0]!) ?? "");
  const named = (taskId: string) => { const item = itemById.get(taskId); return { title: item?.title ?? taskId, task: intents.get(item?.orderId ?? "") ?? item?.title ?? taskId,
    ...(item?.step ? { step: item.step } : {}) }; };
  const energyNeeds = new Map(orders.map((order) => [order.id, humanCoreOf(order)?.energy]));
  const occurrences = new Map<string, number>();
  const blocks = placed.map((block) => {
    const index = (occurrences.get(block.taskId) ?? 0) + 1;
    occurrences.set(block.taskId, index);
    const blockDay = formatInTimeZone(new Date(block.start), zone, "yyyy-MM-dd");
    const needsRestCheck = currentEnergy === "low" && blockDay === today &&
      energyNeeds.get(block.taskId.split("#")[0]!) === "high" && Date.parse(block.start) > now.getTime();
    const tag = block.progressOnly ? "本周未排完" : needsRestCheck ? "休息后复评" : tentative(block.taskId) ? "暂定" : undefined;
    return {
    id: scheduledBlockId(block.taskId, index),
    lane: "human" as const,
    ...named(block.taskId), ...(tag ? { tag } : {}),
    day: blockDay,
    start: formatInTimeZone(new Date(block.start), zone, "HH:mm"),
    end: formatInTimeZone(new Date(block.end), zone, "HH:mm"),
    source: "建议·未批准",
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
  }).catch(() => undefined) : undefined;
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
  // Started from a pencilled-in block: fixed where the person started it.
  for (const pin of pins) blocks.push({ id: scheduledBlockId(pin.taskId, 1), lane: "human" as const, ...named(pin.taskId), tag: "已开始",
    day: pin.day, start: pin.start, end: pin.end, source: "本人开始", readOnly: true });
  // Kept where they were when an event was added (local re-planning): drawn as ordinary scheduled blocks.
  for (const pin of kept) {
    const index = (occurrences.get(pin.taskId) ?? 0) + 1;
    occurrences.set(pin.taskId, index);
    const tag = tentative(pin.taskId) ? "暂定" : undefined;
    blocks.push({ id: scheduledBlockId(pin.taskId, index), lane: "human" as const, ...named(pin.taskId), ...(tag ? { tag } : {}),
      day: pin.day, start: pin.start, end: pin.end, source: "建议·未批准", readOnly: true });
  }
  // Third pass, pencilled in: what found no room in the person's hours, placed between 07:00 and 23:00 outside them. Dashed, never
  // published, never counted as planned; starting one (`pinBlock`) makes it formal.
  const unplaced = new Set(result.blockers.map((blocker) => blocker.taskId));
  const leftovers = expanded.filter((item) => unplaced.has(item.task.id) && !pins.some((pin) => pin.taskId === item.task.id));
  if (leftovers.length) {
    const offBusy = [...busy, ...blocks.filter((block) => block.day).map((block) => ({ day: block.day!, start: block.start, end: block.end }))];
    const offInstants = availableSlots(offHoursWindows(readAvailability(ctx)), days, offBusy).flatMap((slot) => {
      try { return [{ start: iso(slot.day, slot.start), end: iso(slot.day, slot.end), day: slot.day, energy: slot.energy }]; } catch { return []; }
    });
    const optional = offInstants.length ? await planSchedule({ now, horizonDays: days.length, mode: preferences.mode, params: effectiveParams(ctx),
      tasks: leftovers.map((item) => item.task), availability: offInstants,
      frozenBlocks: [...result.plan.blocks.map((block) => ({ taskId: block.taskId, start: block.start, end: block.end })), ...pinned]
    }).catch(() => undefined) : undefined;
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
    ...(result.notes?.length ? { notes: result.notes } : {}) } };
}

export function loadGoalForecast(ctx: AccessContext): ForecastResult & { inferredRegularBlocks: number } {
  ensureSeeded(ctx);
  const store = getStore();
  const preferences = effectiveSchedulePreferences(ctx).preferences;
  const days = planDays(planToday(ctx), 56);
  const committed = ((store.listPlanVersions(ctx.workspaceId)[0]?.payload as { blocks?: PersistedScheduleBlock[] } | undefined)
    ?.blocks ?? []).filter((block) => block.day);
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
    ...personEventBlocks(ctx, days).map((block) => ({ day: block.day!, start: block.start, end: block.end }))];
  const slots = availableSlots(readAvailability(ctx), days, busy);
  const capacity = days.map((day) => ({ day, netMinutes: slots.filter((slot) => slot.day === day).reduce((sum, slot) => {
    try { return sum + (Date.parse(toZonedInstant(day, slot.end, preferences.timeZone))
      - Date.parse(toZonedInstant(day, slot.start, preferences.timeZone))) / 60_000; }
    catch { return sum; }
  }, 0), source: busy.some((block) => block.day === day) ? "calendar_adjusted" as const : "declared" as const }));
  // An approved milestone's own deadline is one the person confirmed by approving it; the goal setting only overrides it.
  // Without the fallback no milestone had a deadline here unless it was typed a second time, so nothing was ever at risk.
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const goals = store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved")
    .map((item) => { const weight = effectiveWeight(ctx, item.id); return { id: item.id, title: item.title, weight,
      importance: weight >= IMPORTANT_WEIGHT ? "important" as const : "ordinary" as const,
      confirmedDeadline: readGoalSettings(ctx, item.id)?.confirmedDeadline ?? anchors.get(item.id) ?? null }; });
  const orders = store.listWorkOrders(ctx.workspaceId);
  // Step by step where a task has a plan, so the forecast counts only the work that is left.
  // A task waiting in the library starts no earlier than the day it enters the schedule, so a window that opens too late for the work
  // shows up here as a risk instead of a forecast that assumed it had already started.
  const today = planToday(ctx);
  const opens = new Map(orders.flatMap((order) => { const day = libraryUntil(ctx, order, today); return day ? [[order.id, day] as const] : []; }));
  const tasks = plannerItemsFor(ctx, orders.filter((order) => ACTIONABLE.includes(order.state))).map((item) => {
    const day = opens.get(item.orderId);
    const start = day ? toZonedInstant(day, "00:00", preferences.timeZone) : undefined;
    return start && (!item.task.notBefore || item.task.notBefore < start) ? { ...item.task, notBefore: start } : item.task;
  });
  const completedIds = new Set(orders.filter((order) => order.state === "accepted").map((order) => order.id));
  return { ...forecastGoals(goals, tasks, capacity, completedIds), inferredRegularBlocks: inferred.length };
}

/** The input-box events (`schedule.events`) on these days, as plan blocks. */
function personEventBlocks(ctx: AccessContext, days: string[]): PersistedScheduleBlock[] {
  try { return fixedEventBlocks(JSON.parse(getStore().getSetting(ctx.workspaceId, FIXED_EVENTS) ?? "[]") as FixedEvent[], days); } catch { return []; }
}

export async function loadCurrentPlan(ctx: AccessContext): Promise<PersistedPlan> {
  ensureSeeded(ctx);
  const store = getStore();
  const stored = store.listPlanVersions(ctx.workspaceId)[0];
  if (!stored) throw new Error("PLAN_VERSION_NOT_FOUND");
  const payload = stored.payload as { blocks?: PersistedScheduleBlock[] };
  // The calendar's blocks are stored; the scheduled ones are derived on read. Persisting a schedule
  // would mean the plan disagreed with the work orders the moment one of them moved.
  // The person's own fixed events (typed into the input box) are busy time too, derived on read like the schedule itself.
  const committed = [...(payload.blocks ?? []), ...personEventBlocks(ctx, planDays(planToday(ctx)))];
  // A real, computed preview beats an empty page: the scheduler runs against sane defaults even before
  // the person has saved their own time zone, availability and mode. `usingDefaultPreferences` is what
  // lets the page say so, instead of either lying about it or blocking on it.
  const suggested = await scheduledBlocks(ctx, planToday(ctx), committed);
  return {
    id: stored.id,
    version: stored.version,
    status: stored.status,
    blocks: [...committed, ...suggested.blocks],
    schedule: suggested.schedule,
    usingDefaultPreferences: effectiveSchedulePreferences(ctx).isDefault,
    changes: store.listPlanChanges(ctx.workspaceId, stored.id).map((change) => {
      const after = change.after as { blockId?: string } | undefined;
      return {
        id: change.id,
        kind: change.kind,
        explanation: change.explanation,
        ...(after?.blockId ? { afterBlockId: after.blockId } : {}),
        status: change.status
      };
    })
  };
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
  const checked = validateSuccessCriteria(input.successCriteriaDefaults);
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
        text: `跨主线关系「${titles.get(relation.fromMilestoneId) ?? relation.fromMilestoneId} → ${titles.get(relation.toMilestoneId) ?? relation.toMilestoneId}」（${relationKindLabel[relation.kind] ?? relation.kind}）被本人驳回` });
    }
  }
  return { ok: true, ...result };
}

/**
 * Resolves one pending plan change.
 *
 * Without this a conflict was a dead end: `approvePlanVersion` refuses while one is pending, and nothing
 * could move it out of `pending` — so a single calendar change would have made the plan permanently
 * unapprovable. Excluding a change is a decision, and the ledger records it as one.
 */
export function resolvePlanChange(ctx: AccessContext, changeId: string, status: "approved" | "excluded"):
  | { ok: true; changed: boolean } | { ok: false; code: string } {
  if (!changeId || changeId.length > 200) return { ok: false, code: "PLAN_CHANGE_NOT_FOUND" };
  const result = getStore().resolvePlanChange(ctx.workspaceId, ctx.principalId, changeId, status, `plan-change:${changeId}:${status}`);
  return { ok: true, changed: result.changed };
}

export function approvePlanVersion(ctx: AccessContext, planId: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const plan = store.listPlanVersions(ctx.workspaceId).find((item) => item.id === planId);
  if (!plan) return { ok: false, code: "PLAN_VERSION_NOT_FOUND" };
  if (plan.status === "approved") return { ok: true };
  if (plan.status !== "draft") return { ok: false, code: "PLAN_VERSION_NOT_APPROVABLE" };

  const changes = store.listPlanChanges(ctx.workspaceId, planId);
  if (changes.some((change) => change.kind === "conflict" && change.status === "pending")) {
    return { ok: false, code: "PLAN_HAS_UNRESOLVED_CONFLICT" };
  }
  for (const change of changes) {
    store.savePlanChange({ ...change, status: change.status === "pending" ? "approved" : change.status });
  }
  store.savePlanVersion({ ...plan, status: "approved" });
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `plan-approved:${planId}`, type: "plan.approved", entityId: planId,
    payload: { from: "draft", to: "approved", approvedChangeIds: changes.filter((change) => change.status === "pending").map((change) => change.id) }
  });
  return { ok: true };
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

export function approveWorkOrderProposal(ctx: AccessContext, workOrderId: string): ExecutionResult {
  if (requiredApproval("approve_work_orders") === "never") return { ok: false, code: "APPROVAL_NOT_PERMITTED" };
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "approved") return { ok: true };
  // A blocked WorkOrder is recoverable by the same human approval that admitted it; the transition table
  // has always allowed it, and refusing here would strand a real item with no way back.
  if (workOrder.state !== "awaiting_plan_approval" && workOrder.state !== "blocked") return { ok: false, code: "PROPOSAL_NOT_APPROVABLE" };
  getStore().transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "plan.approved", approvalId: ctx.principalId },
    `proposal-approved:${workOrderId}:${executionRun(ctx.workspaceId, workOrderId)}`);
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
const SYSTEM_ARCHIVE_REASONS = ["示例作业自动清理", "自动反推旧版", "你已经在等这项输入", "你已经提供了这项输入", "你说这个里程碑先不拆",
  "该输入已在等待中", "该输入已由本人提供", "本人选择暂不拆分该里程碑"];
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
  if (workOrder.state === "active") return { ok: true };
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
  if (findWorkOrder(ctx.workspaceId, workOrderId)?.state !== "active") return { ok: false, code: "NO_ACTIVE_EXECUTION" };
  getStore().pauseExecution(ctx.workspaceId, workOrderId, reason.trim(), at);
  return { ok: true };
}

export function resumeWorkOrderExecution(ctx: AccessContext, workOrderId: string, at?: string): ExecutionResult {
  if (findWorkOrder(ctx.workspaceId, workOrderId)?.state !== "active") return { ok: false, code: "NO_ACTIVE_EXECUTION" };
  getStore().resumeExecution(ctx.workspaceId, workOrderId, at);
  return { ok: true };
}

export function completeWorkOrderExecution(ctx: AccessContext, workOrderId: string, evidence: EvidenceClaimInput[],
  checklistAnswers: ChecklistAnswer[] = [], at?: string, report?: { minutes: number; source: "one_tap" | "activity" }): ExecutionResult {
  const store = getStore();
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "evidence_review") return { ok: true };
  if (workOrder.state !== "active") return { ok: false, code: "EXECUTION_NOT_ACTIVE" };
  store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "human.completed" },
    `execution:${workOrderId}:${executionRun(ctx.workspaceId, workOrderId) - 1}:completed`,
    { evidence, ...(checklistAnswers.length ? { checklistAnswers } : {}), ...(at ? { occurredAt: at } : {}),
      ...(report ? { reportedMinutes: report.minutes, reportedSource: report.source } : {}) });
  return { ok: true };
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
  NO_CAPACITY: "可用时段内没有空位",
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
      blocker: blocks.length || !blocker ? null : UNPLACED_REASON[blocker.code] ?? blocker.message,
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
 */
export function withoutShadowingDemos<T extends { state: string; identityId: string; payload: unknown }>(orders: T[], capacityIds: Set<string>): T[] {
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

const plannerTaskOf = (ctx: AccessContext, order: ActionableOrder) => {
  const preferences = readSchedulePreferences(ctx);
  const goal = readGoalSettings(ctx, order.milestoneId);
  const weight = effectiveWeight(ctx, order.milestoneId);
  const important = weight >= IMPORTANT_WEIGHT;
  const tier = preferences ? goal?.confirmedDeadline ? important ? 1 : 2 : important ? 3 : 4
    : order.state === "approved" ? 3 : order.identityId === (process.env.CROSSLINE_PRIMARY_CLOCK_ID ?? linePacks(ctx).find((pack) => pack.masterClock)?.id) ? 1 : 2;
  const core = humanCoreOf(order);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const landing = byproductLanding(ctx, order);
  const dependsOn = landing ? landing.dependsOn : (order.payload as { dependsOn?: string[] }).dependsOn;
  const preview = previewScope.getStore();
  const release = preview?.notBefore?.[order.id] ?? releaseDayOf(ctx, order);
  const dueDate = preview?.dueDates?.[order.id] ?? landing?.dueDate ?? (order.payload as { dueDate?: string }).dueDate;
  return {
    id: order.id, title: order.intent, identityId: order.identityId, milestoneId: order.milestoneId, weight,
    estimate: scaledEstimate(resolvedEstimate(ctx, order), preview?.estimates?.[order.id]),
    ...(core?.energy ? { energy: core.energy as "low" | "medium" | "high" } : {}),
    // Materials stand between the proposal and the human until the order reaches ready_for_human — when it needs any. An approved
    // order with no material contract can be started as it is (`startWorkOrderExecution` passes straight through), and every
    // backplanned step is one: counting them as not ready left 「下一步」 empty with five approved orders on the board.
    inputsReady: inputsReady(order),
    // A byproduct's landing never outranks real work: lowest tier, with its own T+2 window once the main order is done.
    deadlineTier: (landing ? 4 : tier) as 1 | 2 | 3 | 4,
    // The earlier of the goal's confirmed deadline and the task's own due date (the capture's 「10月21号前」, a homework's due day):
    // a homework due before the exam it counts towards is due on its own day.
    ...(() => {
      const day = [goal?.confirmedDeadline && preferences ? goal.confirmedDeadline : undefined,
        dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : undefined].filter((value): value is string => Boolean(value)).sort()[0];
      return day ? { deadline: toZonedInstant(day, "23:59", zone) } : {};
    })(),
    ...(release ? { notBefore: toZonedInstant(release, "00:00", zone) } : {}),
    ...(dependsOn?.length ? { dependsOn } : {}),
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
  const store = getStore();
  if (store.getSetting(ctx.workspaceId, ACTIVITY_DETAIL_CONSENT) !== "granted") return undefined;
  const open = store.listExecutions(ctx.workspaceId, workOrderId).find((execution) => !execution.endedAt);
  if (!open) return undefined;
  const from = Date.parse(open.startedAt);
  const minutes = store.listActivitySegments(ctx.workspaceId, open.startedAt)
    .filter((segment) => !segment.idle && PRODUCTIVE.has(segment.category as ActivityCategory))
    .reduce((sum, segment) => sum + Math.max(0, Math.min(Date.parse(segment.end), now.getTime()) - Math.max(Date.parse(segment.start), from)) / 60_000, 0);
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
  return { dependsOn: [], dueDate: new Date(Date.parse(`${doneDay}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10) };
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
  deadlines: Map<string, string | null | undefined>, identityId: string): string {
  const mine = milestones.filter((milestone) => milestone.identityId === identityId);
  const approved = mine.filter((milestone) => milestone.status === "approved")
    .sort((a, b) => (deadlines.get(a.id) ?? "9999").localeCompare(deadlines.get(b.id) ?? "9999"));
  if (approved[0]) return approved[0].title;
  const drafts = mine.filter((milestone) => milestone.status === "draft").length;
  return drafts ? `${drafts} 个里程碑草稿待批准` : "等待批准里程碑";
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
export function lastNight(workspaceId: string, now: Date): LastNight {
  const since = new Date(now.getTime() - 36 * 60 * 60_000).toISOString();
  const event = [...getStore().listEvents(workspaceId)]
    .reverse()
    .find((item) => item.type.startsWith("flywheel.nightly.") && item.createdAt >= since);
  if (!event) return { state: "none" };
  const payload = event.payload as { code?: string; message?: string; proposals?: number };
  if (event.type === "flywheel.nightly.ran") return { state: "ran", proposals: payload.proposals ?? 0 };
  return { state: "skipped", reason: payload.message ?? payload.code ?? "未记录原因" };
}

const dayOf = (iso: string) => iso.slice(0, 10);

/** Every WorkOrder's first arrival at `accepted`, deduped by entity — a revoke-then-reaccept cycle must
 * not count as two completions of the same thing. */
function firstAcceptedAt(workspaceId: string): Map<string, string> {
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
    localActivityConsent: consent === "granted" ? "granted" : consent === "denied" ? "denied" : "unasked"
  });
}

const toAction = (ctx: AccessContext, order: ActionableOrder | undefined, reason: string): DashboardAction | undefined => order ? ({
  id: order.id,
  title: order.intent,
  identityId: order.identityId,
  estimate: resolvedEstimate(ctx, order),
  ...(humanCoreOf(order)?.energy ? { energy: humanCoreOf(order)!.energy as "low" | "medium" | "high" } : {}),
  reason,
  milestone: getStore().listMilestones(ctx.workspaceId).find((item) => item.id === order.milestoneId)?.title ?? "等待确认",
  inputsReady: inputsReady(order)
}) : undefined;

// `taskDetailById`/`milestoneDetailById` are deliberately not part of this return type: they're batched
// in `page.tsx` instead, to avoid a circular import between this file and `lib/task-detail.ts` (which
// already imports from here). `page.tsx` spreads them into what this returns before handing it to
// `DashboardView`.
export async function loadDashboard(ctx: AccessContext): Promise<Omit<DashboardData, "taskDetailById" | "milestoneDetailById">> {
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
  const actions = recommendNextActions(active.map((order) => plannerTaskOf(ctx, order)), 40,
    capacity.level === "uncalibrated" ? undefined : capacity.level, now, forecast);
  const milestones = store.listMilestones(ctx.workspaceId);
  const identityPacks = identityLines(ctx);
  const timeZone = readSchedulePreferences(ctx)?.timeZone
    ?? process.env.CROSSLINE_TIME_ZONE?.trim() ?? "America/Chicago";
  const time = new Intl.DateTimeFormat("zh-CN", {
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
      const latestSignal = acceptedCount > 0 ? `已验收 ${acceptedCount} 次`
        : gateCount > 0 ? `已判定 ${gateCount} 次` : "等待进展";
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
      return { from: bucket.from, to: bucket.to, count: bucket.count, pending: bucket.pending, kindLabel: relationKindLabel[topKind] ?? topKind };
    });

    return { nodes: nodes.map(({ id, identityId, title, latestSignal }) => ({ id, identityId, title, latestSignal })), edges };
  })();

  const energySelected = capacity.level !== "uncalibrated";
  const primaryReason = energySelected
    ? actions.primary?.deadline && Date.parse(actions.primary.deadline) - now.getTime() <= 24 * 60 * 60_000
      ? "已确认截止时间临近；即使当前精力不匹配仍优先显示，请考虑先休息 10 分钟"
      : actions.primary?.energy === capacity.level
        ? `当前${capacity.level === "low" ? "低" : capacity.level === "high" ? "高" : "中"}精力自评与所需精力匹配，输入已就绪`
        : "暂无精力完全匹配的就绪作业，展示可执行的最高优先级备选"
    : "输入已就绪，按目标重要性和估时推荐；尚无新鲜精力自评";
  const primary = toAction(ctx, active.find((task) => task.id === actions.primary?.id), primaryReason);
  const higherPriority = toAction(ctx, active.find((task) => task.id === actions.higherPriority?.id),
    "优先级更高，但当前精力与任务要求不匹配；保留供本人决定");
  const lowEnergy = toAction(ctx, active.find((task) => task.id === actions.lowEnergy?.id), "标注为低精力任务，启动阻力最小");
  const shortGap = toAction(ctx, active.find((task) => task.id === actions.shortGap?.id), "先验 p85 在 40 分钟以内，可放进短空档");
  return {
    principalId: ctx.principalId,
    workspaceId: ctx.workspaceId,
    nowLabel: time,
    nowIso: now.toISOString(),
    timeZone,
    clockPinned: Boolean(process.env.CROSSLINE_FIXED_NOW),
    dateLabel: new Intl.DateTimeFormat("en-US", { day: "2-digit", timeZone }).format(now),
    monthLabel: new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone }).format(now).toUpperCase(),
    capacity,
    energyLearning: energyCalibration(outcomes),
    awaitingApproval: orders.filter((order) => order.state === "awaiting_plan_approval").length,
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
        activeMilestone: currentMilestoneLabel(milestones, anchorsByMilestone, pack.id),
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
        id: order.id, title: order.intent, identityId: order.identityId, status: "待批准",
        ...(order.milestoneId && milestoneTitleById.has(order.milestoneId)
          ? { milestoneTitle: milestoneTitleById.get(order.milestoneId)! } : {})
      })),
      // A scheduled block's real `HH:mm–HH:mm` beats a duration guess whenever the planner actually
      // placed this order today; when it did not (dependency blocker, no capacity left, pushed to a
      // later day), `time` stays unset and the status text says so explicitly instead of a vague "待排程".
      ...active.map((order) => {
        const block = blockByWorkOrderToday.get(order.id);
        const status = order.state === "approved" ? "已批准 · 等待材料"
          : order.state === "preparing" ? "材料准备中"
          : order.state === "active" ? "执行中"
          : block ? `预计 ${resolvedEstimate(ctx, order).p50Minutes} 分钟`
          : `预计 ${resolvedEstimate(ctx, order).p50Minutes} 分钟 · 规划器未排入今天`;
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
          status: item.state === "captured" ? "已保存 · 未分类 / 未估时 · Workbench 分析"
            : item.state === "blocked" ? "分析阻塞 · 可人工处理" : "正在分析"
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
        identity: identityPacks.find((pack) => pack.id === milestone.identityId)?.label ?? milestone.identityId,
        title: milestone.title,
        evidence: acceptedCount
          ? `${milestone.status === "approved" ? "已批准" : "等待批准"} · 已验收 ${acceptedCount} 次`
          : milestone.status === "approved" ? "已批准 · 等待新证据" : "等待批准"
      };
    })
  };
}
