import "server-only";
import { randomUUID } from "node:crypto";
import {
  currentRiskReview, draftingProgress, FIRST_DRAFTS_SETTING, firstDraftsState, MILESTONE_DRAFTING_SETTING, readMilestoneDrafting, type DraftingProgress, MILESTONE_RISKS_SETTING, milestoneRiskFingerprint, parseMilestoneRisks, riskCriteriaKeys,
  ruleMilestoneRisks, supplyWarnings, taskProgress, timeOrderProblem, type AccessContext, type MilestoneRisk, type SuccessCriterion
} from "@crossline/core";
import { readStoredArtifactPlan } from "@crossline/db";
import { appNow, effectiveWeight, getStore, importancePresets, loadCurrentPlan, loadGoalForecast, milestonesRetiredBySystem, planToday, readGoalSettings, relationKindLabel, saveGoalSettings } from "./crossline";
import { listCourseTargets } from "./targets";
import { identityLines } from "./lines";

/**
 * Everything the 主线 page draws, read once: milestones on a date axis, the ticks before each (the near-term results the step planner
 * marked, from the steps of the tasks serving it), what each milestone is judged by, the tasks under it, how it connects to other lines,
 * the course targets as the end of their chains, and the week's deterministic figures for the top bar.
 */
export type BoardTick = { id: string; workOrderId: string; taskTitle: string; outcome: string; day: string | null;
  /** done: reached (filled); planned: ahead (hollow); postponed: its planned day passed without it (hollow, dashed, moved to `day`). */
  state: "done" | "planned" | "postponed"; plannedDay: string | null };
export type BoardCriterion = { id: string; statement: string; quarters: number; observed?: string;
  threshold?: { comparator: "gte" | "lte"; value: number; bare?: number; unit: string } };
export type BoardRelation = { id: string; direction: "out" | "in"; otherId: string; otherTitle: string; otherLine: string; kindLabel: string;
  explanation: string; refutedWhen: string; pending: boolean; warning?: string;
  /** For a relation derived from the artifact plan: the artifact handed over, the transfer promised (and measured once checked), the check day, the counterfactual. */
  artifact?: { id: string; title: string; kind: string };
  transfer?: { metric: string; expected: number; unit: string; measured: number | null; lagDays: number; hoursSaved: number };
  checkOn?: string; counterfactual?: string;
  /** Set when the upstream milestone is now due too late for the downstream one (a deadline moved after the relation was made): drawn as a red broken line. */
  broken?: string };
export type BoardMilestone = {
  id: string; identityId: string; projectId: string; projectName?: string; title: string; status: "draft" | "approved";
  version: number; deadline?: string; daysLeft?: number; dependsOn: string[]; rationale?: string;
  criteria: BoardCriterion[]; successCriteria: SuccessCriterion[]; templateId?: string;
  tasks: Array<{ id: string; intent: string; state: string; progress: number | null; steps: Array<{ id: string; title: string; status: string; tick: string }> }>;
  ticks: BoardTick[]; relations: BoardRelation[]; confirmedDeadline: string | null;
  /**
   * Importance as the scheduler uses it (`effectiveWeight`): judged by the system (`presetWeight`, from the line's standing, its relations,
   * what is graded and how near it is) until the person moves the slider on this milestone (`ownWeight`).
   */
  weight: number; presetWeight: number; ownWeight: boolean;
  /** What could keep it from being reached: the reviewer's answer for this version (`model`), else the deterministic estimate (`rules`). */
  risks: MilestoneRisk[]; riskSource: "model" | "rules";
  retrospective?: { tasks: number; workedMinutes: number; reused: number; readings: Array<{ statement: string; observed: string }>;
    /** What the person recorded about it, once they have; it goes into the ledger and from there into their preferences. */
    note?: string };
};
export type BoardCourse = { projectId: string; identityId: string; name: string; value: string; why: string; proposed: boolean; endDay?: string };
export type MilestoneBoard = {
  today: string; milestones: BoardMilestone[]; courses: BoardCourse[]; labels: Record<string, string>; lineOrder: string[];
  /** With no milestone yet: whether the worker is designing the first drafts on its own, or that run ended without any. */
  firstDrafts?: "none" | "running" | "stalled";
  /** The last design run, line by line: lines still being designed, and why a line was left without drafts (`draftingProgress`). */
  drafting?: DraftingProgress;
  stats: { ticksDone: number; ticksPlanned: number; reuse: number; nearest?: { id: string; title: string; line: string; days: number } };
};

const QUARTERS: Record<string, number> = { met: 4, partial: 2, unmet: 0, unverifiable: 0 };
const RANK: Record<string, number> = { unverifiable: 0, unmet: 1, partial: 2, met: 3 };
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

export async function loadMilestoneBoard(ctx: AccessContext): Promise<MilestoneBoard> {
  const store = getStore();
  const today = planToday(ctx);
  const weekStart = new Date(Date.parse(`${today}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const weekEnd = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const retired = milestonesRetiredBySystem(ctx);
  const milestones = store.listMilestones(ctx.workspaceId).filter((item) => item.status !== "archived" && !retired.has(item.id));
  const byId = new Map(milestones.map((item) => [item.id, item]));
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const projects = new Map(store.listProjects(ctx.workspaceId, { includeArchived: true }).map((project) => [project.id, project.name]));
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => order.state !== "archived");
  const plans = new Map(store.listStepPlans(ctx.workspaceId).map((plan) => [plan.workOrderId, plan]));
  const blocks = (await loadCurrentPlan(ctx)).blocks;
  const firstBlock = new Map<string, string>();
  for (const block of blocks) {
    if (!block.id.startsWith("scheduled:") || !block.day) continue;
    const [, order, step] = block.id.split(":");
    const key = step && /^v\d+s\d+$/.test(step) ? `${order}#${step}` : order!;
    if (!firstBlock.has(key) || block.day < firstBlock.get(key)!) firstBlock.set(key, block.day);
  }
  const readings = new Map<string, Map<string, { met: string; observed: string }>>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "milestone_gate.judged" })) {
    const payload = event.payload as { milestoneId?: string; criteriaVerdict?: Array<{ criterionId: string; met: string; observed?: string }> };
    if (!payload.milestoneId) continue;
    const current = readings.get(payload.milestoneId) ?? new Map();
    for (const item of payload.criteriaVerdict ?? []) {
      const seen = current.get(item.criterionId);
      if (!seen || (RANK[item.met] ?? 0) > (RANK[seen.met] ?? 0)) current.set(item.criterionId, { met: item.met, observed: item.observed ?? "" });
    }
    readings.set(payload.milestoneId, current);
  }
  const rationales = new Map(store.listEvents(ctx.workspaceId, { type: "milestone.proposed" })
    .map((event) => [event.entityId, String((event.payload as { rationale?: string }).rationale ?? "")]));
  const relations = store.listMilestoneRelations(ctx.workspaceId).filter((relation) => relation.status === "approved" || relation.status === "candidate");
  const executions = store.listExecutions(ctx.workspaceId);
  const dismissed = new Set(store.listEvents(ctx.workspaceId, { type: "validation.reviewed" })
    .filter((event) => (event.payload as { subject?: string; verdict?: string }).subject === "milestone_relation"
      && (event.payload as { verdict?: string }).verdict === "dismiss").map((event) => event.entityId));
  const notes = new Map(store.listEvents(ctx.workspaceId, { type: "milestone.retrospective" })
    .map((event) => [event.entityId, String((event.payload as { note?: string }).note ?? "")]));
  const labels = Object.fromEntries(identityLines(ctx).map((pack) => [pack.id, pack.label]));
  const artifacts = new Map(readStoredArtifactPlan(store, ctx.workspaceId).artifacts.map((artifact) => [artifact.id, artifact]));
  const deadlineOf = new Map(milestones.map((milestone) => [milestone.id, readGoalSettings(ctx, milestone.id)?.confirmedDeadline ?? anchors.get(milestone.id)?.deadline]));
  const presets = importancePresets(ctx);
  const draftWeights = readDraftWeights(ctx);
  const storedRisks = parseMilestoneRisks(store.getSetting(ctx.workspaceId, MILESTONE_RISKS_SETTING));
  // The forecast's room before each approved milestone's deadline, for the rule estimate; the page still draws without it.
  let slack = new Map<string, number | null>();
  try { slack = new Map(loadGoalForecast(ctx).goals.map((goal) => [goal.milestoneId, goal.p85Minutes > 0 ? goal.slackDays : null])); } catch { /* no forecast */ }

  const board: BoardMilestone[] = milestones.map((milestone) => {
    const anchor = anchors.get(milestone.id);
    const goal = readGoalSettings(ctx, milestone.id);
    const deadline = goal?.confirmedDeadline ?? anchor?.deadline;
    const own = orders.filter((order) => order.milestoneId === milestone.id);
    const ticks: BoardTick[] = own.flatMap((order) => (plans.get(order.id)?.steps ?? []).filter((step) => step.tickOutcome).map((step) => {
      const scheduled = firstBlock.get(`${order.id}#${step.id}`) ?? null;
      const doneDay = step.status === "done" ? step.updatedAt.slice(0, 10) : null;
      const plannedDay = step.dueBy || scheduled;
      const postponed = !doneDay && Boolean(plannedDay && plannedDay < today);
      return { id: `${order.id}#${step.id}`, workOrderId: order.id, taskTitle: order.intent, outcome: step.tickOutcome,
        day: doneDay ?? (postponed ? scheduled ?? today : plannedDay ?? null), state: doneDay ? "done" as const : postponed ? "postponed" as const : "planned" as const,
        plannedDay: plannedDay ?? null };
    }));
    const reading = readings.get(milestone.id) ?? new Map();
    const criteria: BoardCriterion[] = milestone.successCriteria.map((criterion) => {
      const read = reading.get(criterion.id);
      const measure = criterion.measure;
      return { id: criterion.id, statement: criterion.statement, quarters: read ? QUARTERS[read.met] ?? 0 : 0, ...(read?.observed ? { observed: read.observed } : {}),
        ...(measure.kind === "threshold" ? { threshold: { comparator: measure.comparator === "lte" ? "lte" as const : "gte" as const, value: measure.value,
          ...(measure.bareLine !== undefined ? { bare: measure.bareLine } : {}), unit: measure.unit } } : {}) };
    });
    const relationRows: BoardRelation[] = relations.filter((relation) => relation.fromMilestoneId === milestone.id || relation.toMilestoneId === milestone.id).flatMap((relation) => {
      const out = relation.fromMilestoneId === milestone.id;
      const other = byId.get(out ? relation.toMilestoneId : relation.fromMilestoneId);
      if (!other) return [];
      // The same loose check the proposer runs on a derived relation (never blocking). Once the reviewer has found it sound, it is not shown again.
      const found = relation.artifactId && !dismissed.has(relation.id)
        ? supplyWarnings({ use: relation.explanation ?? "", counterfactual: relation.counterfactual ?? "", hoursSaved: relation.transfer?.hoursSaved ?? 0 }) : [];
      const warning = found.map((item) => item.detail).join(" ") || undefined;
      const artifact = relation.artifactId ? artifacts.get(relation.artifactId) : undefined;
      const broken = relation.artifactId && relation.transfer
        ? timeOrderProblem(deadlineOf.get(relation.fromMilestoneId), deadlineOf.get(relation.toMilestoneId), relation.transfer.lagDays, relation.kind === "recurring_feedback") ?? undefined
        : undefined;
      return [{ id: relation.id, direction: out ? "out" as const : "in" as const, otherId: other.id, otherTitle: other.title, otherLine: other.identityId,
        kindLabel: relationKindLabel[relation.kind] ?? relation.kind, explanation: relation.explanation ?? "", refutedWhen: relation.refutedWhen ?? "",
        pending: relation.status === "candidate", ...(warning ? { warning } : {}),
        ...(relation.artifactId ? { artifact: { id: relation.artifactId, title: artifact?.title ?? relation.artifactId, kind: artifact?.kind ?? "" } } : {}),
        ...(relation.transfer ? { transfer: { metric: relation.transfer.metric, expected: relation.transfer.expected, unit: relation.transfer.unit,
          measured: relation.transfer.measured, lagDays: relation.transfer.lagDays, hoursSaved: relation.transfer.hoursSaved } } : {}),
        ...(relation.checkOn ? { checkOn: relation.checkOn } : {}), ...(relation.counterfactual ? { counterfactual: relation.counterfactual } : {}),
        ...(broken ? { broken } : {}) }];
    });
    const achieved = criteria.length > 0 && criteria.every((criterion) => criterion.quarters === 4);
    const worked = executions.filter((execution) => own.some((order) => order.id === execution.workOrderId) && execution.durationObserved && execution.endedAt)
      .reduce((sum, execution) => sum + Math.max(0, Math.round((Date.parse(execution.endedAt!) - Date.parse(execution.startedAt)) / 60_000) - execution.pauseMinutes), 0);
    return {
      id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId ?? "",
      ...(milestone.projectId && projects.get(milestone.projectId) ? { projectName: projects.get(milestone.projectId)! } : {}),
      title: milestone.title, status: milestone.status as "draft" | "approved", version: milestone.version,
      ...(deadline ? { deadline, daysLeft: dayDiff(today, deadline) } : {}), dependsOn: anchor?.dependsOn ?? [],
      ...(rationales.get(milestone.id) ? { rationale: rationales.get(milestone.id)! } : {}),
      criteria, successCriteria: milestone.successCriteria, ...(milestone.templateId ? { templateId: milestone.templateId } : {}),
      tasks: own.map((order) => { const plan = plans.get(order.id); return { id: order.id, intent: order.intent, state: order.state,
        progress: plan ? taskProgress(plan.steps) : order.state === "accepted" ? 1 : null,
        steps: (plan?.steps ?? []).map((step) => ({ id: step.id, title: step.title, status: step.status, tick: step.tickOutcome })) }; }),
      ticks, relations: relationRows,
      ...(() => {
        const presetWeight = presets.get(milestone.id)?.weight ?? 50;
        const dependsOn = anchor?.dependsOn ?? [];
        const fingerprint = milestoneRiskFingerprint({ title: milestone.title, deadline: deadline ?? null, criteria: riskCriteriaKeys(milestone.successCriteria), dependsOn });
        const reviewed = currentRiskReview(storedRisks[milestone.id], fingerprint);
        const draftWeight = milestone.status === "draft" ? draftWeights[milestone.id] : undefined;
        return { presetWeight, weight: milestone.status === "approved" ? effectiveWeight(ctx, milestone.id) : draftWeight ?? presetWeight,
          ownWeight: milestone.status === "approved" ? typeof goal?.weight === "number" : draftWeight !== undefined,
          risks: reviewed ?? ruleMilestoneRisks({ today, deadline: deadline ?? null, criteria: milestone.successCriteria,
            dependsOn: dependsOn.flatMap((id) => byId.get(id) ? [{ title: byId.get(id)!.title, deadline: deadlineOf.get(id) ?? null }] : []),
            otherDeadlines: milestones.filter((other) => other.id !== milestone.id && deadlineOf.get(other.id)).map((other) => deadlineOf.get(other.id)!),
            slackDays: slack.get(milestone.id) ?? null }),
          riskSource: reviewed ? "model" as const : "rules" as const };
      })(),
      confirmedDeadline: goal?.confirmedDeadline ?? null,
      ...(achieved ? { retrospective: { tasks: own.length, workedMinutes: worked,
        reused: relationRows.filter((relation) => relation.direction === "out" && !relation.pending).length,
        readings: criteria.map((criterion) => ({ statement: criterion.statement, observed: criterion.observed ?? "" })),
        ...(notes.has(milestone.id) ? { note: notes.get(milestone.id)! } : {}) } } : {})
    };
  });

  const courses: BoardCourse[] = listCourseTargets(ctx).map((course) => {
    const ends = board.filter((milestone) => milestone.projectId === course.projectId && milestone.deadline).map((milestone) => milestone.deadline!).sort();
    return { ...course, ...(ends.length ? { endDay: ends.at(-1)! } : {}) };
  });
  const allTicks = board.flatMap((milestone) => milestone.ticks);
  const reusedSources = new Set(board.flatMap((milestone) => milestone.relations.filter((relation) => relation.direction === "out" && !relation.pending).map(() => milestone.id)));
  const nearest = board.filter((milestone) => milestone.status === "approved" && milestone.daysLeft !== undefined && milestone.daysLeft >= 0)
    .sort((a, b) => a.daysLeft! - b.daysLeft!)[0];
  return {
    today, milestones: board, courses, labels, lineOrder: Object.keys(labels),
    firstDrafts: firstDraftsState(getStore().getSetting(ctx.workspaceId, FIRST_DRAFTS_SETTING), board.length > 0),
    drafting: draftingProgress(readMilestoneDrafting(getStore().getSetting(ctx.workspaceId, MILESTONE_DRAFTING_SETTING)),
      new Set(board.map((milestone) => milestone.identityId)), appNow()),
    stats: {
      ticksDone: allTicks.filter((tick) => tick.state === "done" && tick.day && tick.day >= weekStart && tick.day <= today).length,
      ticksPlanned: allTicks.filter((tick) => tick.day && tick.day >= weekStart && tick.day < weekEnd).length,
      reuse: allTicks.filter((tick) => tick.state === "done" && tick.day && tick.day >= weekStart && reusedSources.has(board.find((milestone) => milestone.ticks.includes(tick))!.id)).length,
      ...(nearest ? { nearest: { id: nearest.id, title: nearest.title, line: nearest.identityId, days: nearest.daysLeft! } } : {})
    }
  };
}

/**
 * Records a reached milestone's retrospective: the figures the board already shows plus the person's own note. One event per
 * milestone version, so a later note replaces the earlier one on the board while both stay in the ledger.
 */
export async function recordRetrospective(ctx: AccessContext, milestoneId: string, note: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const text = note.trim();
  if (text.length > 2000) return { ok: false, code: "RETROSPECTIVE_TOO_LONG" };
  const board = await loadMilestoneBoard(ctx);
  const milestone = board.milestones.find((item) => item.id === milestoneId);
  if (!milestone?.retrospective) return { ok: false, code: "MILESTONE_NOT_REACHED" };
  const { note: _previous, ...figures } = milestone.retrospective;
  getStore().appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, type: "milestone.retrospective", entityId: milestoneId,
    idempotencyKey: `milestone:retrospective:${milestoneId}:${randomUUID()}`,
    payload: { milestoneVersion: milestone.version, identityId: milestone.identityId, title: milestone.title, ...figures, note: text } });
  if (text) getStore().addPreference({ workspaceId: ctx.workspaceId, source: "retrospective", scope: milestone.identityId, weight: 1, refId: milestoneId,
    text: `里程碑「${milestone.title}」回顾：${text}` });
  return { ok: true };
}

/** The importance the person set on a draft (`Record<milestoneId, 0–100>`), held until approval moves it into the goal settings. */
export const DRAFT_WEIGHTS_SETTING = "milestones.draftWeights";

function readDraftWeights(ctx: AccessContext): Record<string, number> {
  try {
    const value = JSON.parse(getStore().getSetting(ctx.workspaceId, DRAFT_WEIGHTS_SETTING) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch { return {}; }
}

/**
 * A draft edited before approval: its proposed deadline (the anchor's date) and its importance. An approved milestone's deadline and
 * weight are its goal settings (`/api/goals/[id]`), which the scheduler reads as the person's word; a draft is not scheduled yet, so its
 * date is the proposal itself and its weight waits beside it (`DRAFT_WEIGHTS_SETTING`) until `applyDraftWeight` runs on approval.
 */
export function saveDraftSettings(ctx: AccessContext, milestoneId: string, input: { deadline?: unknown; weight?: unknown }): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const draft = store.listMilestones(ctx.workspaceId).find((item) => item.id === milestoneId && item.status === "draft");
  if (!draft) return { ok: false, code: "MILESTONE_NOT_DRAFT" };
  if (input.deadline === undefined && input.weight === undefined) return { ok: false, code: "MILESTONE_DRAFT_NOTHING_TO_SAVE" };
  const day = input.deadline;
  if (day !== undefined && (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))
    || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)) return { ok: false, code: "MILESTONE_DATE_INVALID" };
  if (input.weight !== undefined && (typeof input.weight !== "number" || !Number.isFinite(input.weight))) return { ok: false, code: "MILESTONE_WEIGHT_INVALID" };
  if (typeof input.weight === "number") {
    const weights = readDraftWeights(ctx);
    weights[milestoneId] = Math.max(0, Math.min(100, Math.round(input.weight)));
    store.setSetting(ctx.workspaceId, DRAFT_WEIGHTS_SETTING, JSON.stringify(weights));
  }
  const anchor = store.listMilestoneAnchors(ctx.workspaceId).find((item) => item.milestoneId === milestoneId);
  if (typeof day === "string" && anchor?.deadline !== day) {
    store.saveMilestoneAnchor({ workspaceId: ctx.workspaceId, milestoneId, stage: anchor?.stage ?? 1, deadline: day, baseline: anchor?.baseline ?? "",
      target: anchor?.target ?? "", stakeholders: anchor?.stakeholders ?? [], sourceFactIds: anchor?.sourceFactIds ?? [], dependsOn: anchor?.dependsOn ?? [],
      updatedAt: new Date().toISOString() });
  }
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, type: "milestone.revised", entityId: milestoneId,
    idempotencyKey: `milestone:draft-settings:${milestoneId}:${randomUUID()}`,
    payload: { ...(typeof day === "string" ? { deadline: { previous: anchor?.deadline ?? null, next: day } } : {}),
      ...(typeof input.weight === "number" ? { weight: Math.max(0, Math.min(100, Math.round(input.weight))) } : {}) } });
  return { ok: true };
}

/** On approval: the weight set on the draft becomes the milestone's goal setting (so the slider's preset history records it too). */
export function applyDraftWeight(ctx: AccessContext, milestoneId: string): void {
  const weights = readDraftWeights(ctx);
  const weight = weights[milestoneId];
  if (weight === undefined) return;
  if (saveGoalSettings(ctx, milestoneId, { weight }).ok) {
    delete weights[milestoneId];
    getStore().setSetting(ctx.workspaceId, DRAFT_WEIGHTS_SETTING, JSON.stringify(weights));
  }
}
