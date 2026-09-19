import "server-only";
import { rankCandidates, stalledIdentities, type CandidateRelation } from "@crossline/core";
import { getStore, WORKSPACE_ID } from "./crossline";

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
};

const daysBetween = (fromIso: string, to: Date) =>
  Math.floor((to.getTime() - Date.parse(fromIso)) / 86_400_000);

export function loadWeeklyReview(now = new Date()): WeeklyReview {
  const store = getStore();
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const events = store.listEvents(WORKSPACE_ID);
  const orders = store.listWorkOrders(WORKSPACE_ID);
  const milestones = store.listMilestones(WORKSPACE_ID);

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
        intent: order?.intent ?? "(已不存在的作业)",
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

  const relations = store.listMilestoneRelations(WORKSPACE_ID);
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

  return {
    autoAccepted,
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
      .map((event) => ({ id: event.eventId, question: String((event.payload as { question?: string }).question ?? "") }))
  };
}
