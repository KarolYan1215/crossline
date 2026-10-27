import "server-only";
import { rankCandidates, stalledIdentities, taskTitleOf, type AccessContext, type CandidateRelation } from "@crossline/core";
import { effectiveSchedulePreferences, getStore, planToday } from "./crossline";
import { identityLines, lineLabels } from "./lines";
import { tOf } from "./locale";
import { investment } from "./plan-stats";
import { readScheduledMinutes } from "./schedule-memory";

/**
 * This week's hours per line, planned against timed (2026-10-21, for the review page's one figure): the last seven days, the planned
 * figure from the day lengths the schedule recorded (`schedule.minutes:<day>`, only days with a record), the timed one from the sessions
 * that started in them. The same arithmetic as the plan page's 「主线投入」 (`investment`), cut to the latest week. Lines with neither
 * are left out; `hasData` is false when nothing was recorded at all, and the page then draws nothing.
 */
export function loadWeekInvestment(ctx: AccessContext): { start: string; end: string; recordedDays: number; hasData: boolean;
  lines: Array<{ line: string; label: string; planned: number; actual: number }> } {
  const store = getStore();
  const today = planToday(ctx);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const orders = store.listWorkOrders(ctx.workspaceId);
  const running = new Set(orders.filter((order) => order.state === "active").map((order) => order.id));
  const plannedByDay: Record<string, Record<string, number> | null> = {};
  for (let back = 6; back >= 0; back -= 1) {
    const day = new Date(Date.parse(`${today}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    plannedByDay[day] = readScheduledMinutes(ctx, day);
  }
  const now = (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()).toISOString();
  const result = investment({ today, zone, now, lineOrder: identityLines(ctx).map((line) => line.id), plannedByDay,
    orderLine: Object.fromEntries(orders.map((order) => [order.id, order.identityId])),
    executions: store.listExecutions(ctx.workspaceId).filter((item) => item.endedAt || running.has(item.workOrderId)), next7: {}, stated: null });
  const week = result.weeks.at(-1)!;
  const labels = lineLabels(ctx);
  const lines = result.lines.map(({ line }) => ({ line, label: labels[line] ?? line, planned: week.planned[line] ?? 0, actual: week.actual[line] ?? 0 }))
    .filter((line) => line.planned > 0 || line.actual > 0);
  return { start: week.start, end: week.end, recordedDays: week.recordedDays, hasData: lines.length > 0, lines };
}

export type WeeklyReview = {
  /** Compensating control for automatic acceptance: every one is listed, never folded into a count. */
  autoAccepted: Array<{ workOrderId: string; intent: string; milestoneId: string; acceptedAt: string; questioned: boolean }>;
  milestoneProgress: Array<{ id: string; title: string; identityId: string; verifiability: string;
    criteria: Array<{ statement: string; kind: string; met?: "met" | "partial" | "unmet" | "unverifiable" }> }>;
  findings: Array<{ eventId: string; status: "candidate" | "approved" | "revoked" | "rejected";
    milestoneId: string; summary: string; sourceUrl: string; sourceTitle: string; retrievedAt: string; staleWhen: string }>;
  /**
   * Ranked candidates joined with what each one actually claims. Approving an arrow between two ids
   * with no stated claim is not a review, so the detail travels with the ranking.
   */
  candidates: {
    highlighted: CandidateRelation[];
    kept: CandidateRelation[];
    detail: Record<string, {
      fromTitle: string; toTitle: string; fromIdentityId: string; toIdentityId: string;
      kind: string; explanation: string | null; refutedWhen: string | null;
      evidence: Array<{ uri: string; source: string; observedAt: string }>;
    }>;
  };
  stalled: Array<{ identityId: string; daysSinceLastPass: number }>;
  /** Questions the weekly Skill raised. Absent until it has run — an empty list is not a fabricated one. */
  questions: Array<{ id: string; question: string }>;
  /** Report-only proposals from `crossline-weekly-insight` — read here, never applied automatically;
   * there is no generic "apply an overlay patch" mechanism in this app to wire an apply button to. */
  insightProposals: Array<{ id: string; claim: string; observationCount: number; period: string; proposedOverlayPatch: string }>;
  /**
   * 「这件事累不累」 as the person answered it after finishing (`actualLoad` on `energy.observed`, 2026-10-20: it was stored and never
   * read), beside the energy the task was planned to need, this week's latest answer per task, the ones that differ first. Read here,
   * not learned from: it is a word about a task, not a measurement of a slot, and too sparse to backtest.
   */
  taskLoad: Array<{ workOrderId: string; title: string; identityId: string; expected?: Level; actual: Level }>;
};
type Level = "low" | "medium" | "high";
const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };

const daysBetween = (fromIso: string, to: Date) =>
  Math.floor((to.getTime() - Date.parse(fromIso)) / 86_400_000);

export function loadWeeklyReview(ctx: AccessContext, now = new Date()): WeeklyReview {
  const store = getStore();
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const events = store.listEvents(ctx.workspaceId);
  const orders = store.listWorkOrders(ctx.workspaceId);
  const milestones = store.listMilestones(ctx.workspaceId);

  // One line per work order, not per event. The audit event is appended by the gate, and a work order
  // judged twice produced two identical lines for one acceptance — a compensating control that
  // double-counts is worse than no count.
  const acceptedOnce = new Map(events
    .filter((event) => event.type === "milestone_gate.auto_accepted" && event.createdAt >= since)
    .map((event) => [event.entityId, event]));
  const autoAccepted = [...acceptedOnce.values()]
    // Only orders that really are accepted now: a revoked or re-opened one is no longer an acceptance.
    .filter((event) => orders.find((item) => item.id === event.entityId)?.state === "accepted")
    .map((event) => {
      const order = orders.find((item) => item.id === event.entityId);
      const payload = order?.payload as { autoAcceptance?: { acceptedAt?: string }; questioned?: boolean } | undefined;
      return {
        workOrderId: event.entityId,
        intent: order?.intent ?? tOf(ctx)("(已不存在的作业)"),
        milestoneId: (event.payload as { milestoneId?: string }).milestoneId ?? "",
        acceptedAt: payload?.autoAcceptance?.acceptedAt ?? event.createdAt,
        questioned: Boolean(payload?.questioned)
      };
    });

  // Best reading per criterion across every judgement: a later work order that did not touch a
  // criterion must not un-meet what an earlier one established.
  const metRank = { unverifiable: 0, unmet: 1, partial: 2, met: 3 } as const;
  type Met = keyof typeof metRank;
  const gateProgress = new Map<string, Record<string, Met>>();
  for (const event of events) {
    if (event.type !== "milestone_gate.judged") continue;
    const payload = event.payload as { milestoneId?: string; criteriaVerdict?: Array<{ criterionId: string; met: Met }> };
    if (!payload.milestoneId) continue;
    const current = gateProgress.get(payload.milestoneId) ?? {};
    for (const item of payload.criteriaVerdict ?? []) {
      const seen = current[item.criterionId];
      if (!seen || metRank[item.met] > metRank[seen]) current[item.criterionId] = item.met;
    }
    gateProgress.set(payload.milestoneId, current);
  }

  const insightDecisions = new Map(events.filter((event) => ["insight.approved", "insight.revoked", "insight.rejected"].includes(event.type))
    .map((event) => [event.entityId, event.type]));
  const findings = events
    .filter((event) => event.type === "flywheel.finding" && event.createdAt >= since)
    .map((event) => ({ ...(event.payload as Omit<WeeklyReview["findings"][number], "eventId" | "status">),
      eventId: event.eventId,
      status: (insightDecisions.get(event.eventId)?.replace("insight.", "") ?? "candidate") as WeeklyReview["findings"][number]["status"] }));

  // Every ranking input below is counted, not scored: stall days, reuse, counterexamples, real minutes.
  const lastPassByMilestone = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "milestone_gate.auto_accepted" && event.type !== "work_order.transitioned") continue;
    const to = (event.payload as { to?: string }).to;
    if (event.type === "work_order.transitioned" && to !== "accepted") continue;
    const order = orders.find((item) => item.id === event.entityId);
    if (order?.milestoneId) lastPassByMilestone.set(order.milestoneId, event.createdAt);
  }

  const relations = store.listMilestoneRelations(ctx.workspaceId);
  const candidateRows: CandidateRelation[] = relations
    .filter((relation) => relation.status === "candidate")
    .map((relation) => {
      const lastPass = lastPassByMilestone.get(relation.toMilestoneId);
      return {
        id: relation.id,
        targetMilestoneId: relation.toMilestoneId,
        reusesExistingArtifact: relation.kind === "reuses",
        counterexampleCount: relation.counterexample.length,
        costMinutes: relation.costMinutes,
        targetStalledDays: lastPass ? daysBetween(lastPass, now) : 0,
        createdAt: relation.lastValidatedAt ?? since,
        hasEvidence: relation.evidence.length > 0
      };
    });
  const ranked = rankCandidates(candidateRows);
  const titleOf = (id: string) => milestones.find((milestone) => milestone.id === id);
  const detail = Object.fromEntries(relations
    .filter((relation) => relation.status === "candidate")
    .map((relation) => [relation.id, {
      // Falling back to the raw id rather than inventing a title: a relation pointing at a milestone
      // that no longer exists should look wrong, not plausible.
      fromTitle: titleOf(relation.fromMilestoneId)?.title ?? relation.fromMilestoneId,
      toTitle: titleOf(relation.toMilestoneId)?.title ?? relation.toMilestoneId,
      fromIdentityId: titleOf(relation.fromMilestoneId)?.identityId ?? "",
      toIdentityId: titleOf(relation.toMilestoneId)?.identityId ?? "",
      kind: relation.kind,
      explanation: relation.explanation,
      refutedWhen: relation.refutedWhen,
      evidence: relation.evidence
    }]));

  const identityIds = [...new Set(milestones.map((milestone) => milestone.identityId))];
  const stalled = stalledIdentities(identityIds.map((identityId) => {
    const passes = milestones
      .filter((milestone) => milestone.identityId === identityId)
      .map((milestone) => lastPassByMilestone.get(milestone.id))
      .filter((value): value is string => Boolean(value))
      .sort();
    const latest = passes.at(-1);
    return { identityId, daysSinceLastPass: latest ? daysBetween(latest, now) : null };
  }), 7);

  const loads = new Map<string, Level>();
  for (const event of events) {
    const payload = event.payload as { context?: string; workOrderId?: string; actualLoad?: string };
    if (event.type === "energy.observed" && event.createdAt >= since && payload.context === "after_task" && payload.workOrderId
      && (payload.actualLoad === "low" || payload.actualLoad === "medium" || payload.actualLoad === "high")) loads.set(payload.workOrderId, payload.actualLoad);
  }
  const taskLoad: WeeklyReview["taskLoad"] = [...loads].flatMap(([workOrderId, actual]): WeeklyReview["taskLoad"] => {
    const order = orders.find((item) => item.id === workOrderId);
    if (!order) return [];
    const need = ((order.payload as { humanCore?: Array<{ energy?: string }> }).humanCore ?? [])[0]?.energy;
    const expected = need === "low" || need === "medium" || need === "high" ? need as Level : undefined;
    return [{ workOrderId, title: taskTitleOf(order), identityId: order.identityId, ...(expected ? { expected } : {}), actual }];
  }).sort((a, b) => Math.abs(RANK[b.actual] - RANK[b.expected ?? b.actual]) - Math.abs(RANK[a.actual] - RANK[a.expected ?? a.actual]));

  return {
    autoAccepted,
    taskLoad,
    milestoneProgress: milestones.filter((milestone) => milestone.status === "approved").map((milestone) => ({
      id: milestone.id, title: milestone.title, identityId: milestone.identityId,
      verifiability: milestone.verifiability,
      criteria: milestone.successCriteria.map((criterion) => ({
        statement: criterion.statement, kind: criterion.measure.kind,
        // What the gate has actually found for this criterion so far. Listing the standards without
        // this is a list of intentions; with it, the retro can see which ones have moved.
        ...(gateProgress.get(milestone.id)?.[criterion.id] ? { met: gateProgress.get(milestone.id)![criterion.id]! } : {})
      }))
    })),
    findings,
    candidates: { highlighted: ranked.highlighted, kept: ranked.kept, detail },
    stalled,
    questions: events
      .filter((event) => event.type === "weekly_review.question" && event.createdAt >= since)
      .map((event) => ({ id: event.eventId, question: String((event.payload as { question?: string }).question ?? "") })),
    insightProposals: events
      .filter((event) => event.type === "weekly_review.insight_proposal" && event.createdAt >= since)
      .map((event) => {
        const payload = event.payload as { id?: string; claim?: string; observationCount?: number; period?: string; proposedOverlayPatch?: string };
        return { id: payload.id ?? event.eventId, claim: payload.claim ?? "", observationCount: payload.observationCount ?? 0,
          period: payload.period ?? "", proposedOverlayPatch: payload.proposedOverlayPatch ?? "" };
      })
  };
}
