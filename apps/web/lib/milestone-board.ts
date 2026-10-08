import "server-only";
import { randomUUID } from "node:crypto";
import { relationWarnings, taskProgress, type AccessContext, type SuccessCriterion } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { getStore, loadCurrentPlan, milestonesRetiredBySystem, planToday, readGoalSettings, relationKindLabel } from "./crossline";
import { listCourseTargets } from "./targets";

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
  explanation: string; refutedWhen: string; pending: boolean; warning?: string };
export type BoardMilestone = {
  id: string; identityId: string; projectId: string; projectName?: string; title: string; status: "draft" | "approved";
  version: number; deadline?: string; daysLeft?: number; dependsOn: string[]; rationale?: string;
  criteria: BoardCriterion[]; successCriteria: SuccessCriterion[]; templateId?: string;
  tasks: Array<{ id: string; intent: string; state: string; progress: number | null; steps: Array<{ id: string; title: string; status: string; tick: string }> }>;
  ticks: BoardTick[]; relations: BoardRelation[]; weight: number; confirmedDeadline: string | null;
  retrospective?: { tasks: number; workedMinutes: number; reused: number; readings: Array<{ statement: string; observed: string }>;
    /** What the person recorded about it, once they have; it goes into the ledger and from there into their preferences. */
    note?: string };
};
export type BoardCourse = { projectId: string; identityId: string; name: string; value: string; why: string; proposed: boolean; endDay?: string };
export type MilestoneBoard = {
  today: string; milestones: BoardMilestone[]; courses: BoardCourse[]; labels: Record<string, string>; lineOrder: string[];
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
  const labels = Object.fromEntries(defaultIdentityPacks().filter((pack) => pack.kind === "identity").map((pack) => [pack.id, pack.label]));

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
      // The same loose check the proposer runs (never blocking). Once the reviewer has looked and found it sound, it is not shown again.
      const source = out ? milestone : other, target = out ? other : milestone;
      const found = dismissed.has(relation.id) ? [] : relationWarnings({ kind: relation.kind, explanation: relation.explanation ?? "", refutedWhen: relation.refutedWhen ?? "" },
        { identityId: source.identityId, deadline: anchors.get(source.id)?.deadline }, { identityId: target.identityId, deadline: anchors.get(target.id)?.deadline });
      const warning = found.map((item) => item.detail).join(" ") || undefined;
      return [{ id: relation.id, direction: out ? "out" as const : "in" as const, otherId: other.id, otherTitle: other.title, otherLine: other.identityId,
        kindLabel: relationKindLabel[relation.kind] ?? relation.kind, explanation: relation.explanation ?? "", refutedWhen: relation.refutedWhen ?? "",
        pending: relation.status === "candidate", ...(warning ? { warning } : {}) }];
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
      weight: goal?.weight ?? (goal?.importance === "important" ? 75 : 50), confirmedDeadline: goal?.confirmedDeadline ?? null,
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
  return { ok: true };
}
