/**
 * What the weekly insight skill is allowed to return.
 *
 * This Skill never writes anything by itself — `proposedOverlayPatch` and `estimateUpdates` are text for
 * a person to read and act on if they agree, the same "proposal only, batch review" rule every other
 * Skill in this app already follows. There is no generic "apply an overlay patch" mechanism in this
 * codebase to wire an auto-apply button to, so this stays report-only until one exists.
 */
export type WeeklyInsightContext = {
  version: "crossline.weekly-insight.v1";
  period: { from: string; to: string };
  executions: Array<{ id: string; workOrderId: string; identityId: string; family: string;
    startedAt: string; endedAt: string | null; pauseMinutes: number; durationObserved: boolean }>;
  estimates: Array<{ workOrderId: string; identityId: string; family: string; p50Minutes: number }>;
  energyObservations: Array<{ id: string; level: string; observedAt: string }>;
  notificationEvents: Array<{ id: string; type: string; entityId: string; createdAt: string }>;
  planChanges: Array<{ id: string; kind: string; status: string }>;
  approvedMilestones: Array<{ id: string; identityId: string; title: string }>;
  /**
   * Byproducts — what one line's work also produced for another — planned, landed (accepted) and missed (still
   * open more than two days after their main work was done) this week. The flywheel, counted.
   */
  byproducts?: { planned: number; landed: number; missed: number; items: Array<{ id: string; lineId: string; artifact: string; status: "planned" | "landed" | "missed" }> };
};

export type InsightProposal = {
  id: string;
  claim: string;
  observationCount: number;
  period: string;
  supportingEventIds: string[];
  counterexampleEventIds: string[];
  proposedOverlayPatch: string;
};

export type WeeklyInsightResult = {
  insightProposals: InsightProposal[];
  estimateUpdates: Array<{ identityId: string; family: string; suggestedP50Minutes: number; rationale: string }>;
  retentionActions: Array<{ action: "keep" | "archive"; targetId: string; reason: string }>;
  blockers: Array<{ code: string; message: string }>;
};

const shortStr = { type: "string", minLength: 1, maxLength: 500 } as const;
const idArray = { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 200 } } as const;
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false });

export const WEEKLY_INSIGHT_OUTPUT_SCHEMA = object({
  insightProposals: {
    type: "array", maxItems: 10,
    items: object({
      id: shortStr, claim: shortStr, observationCount: { type: "integer", minimum: 0, maximum: 10_000 },
      period: shortStr, supportingEventIds: idArray, counterexampleEventIds: idArray, proposedOverlayPatch: shortStr
    })
  },
  estimateUpdates: {
    type: "array", maxItems: 20,
    items: object({ identityId: shortStr, family: shortStr, suggestedP50Minutes: { type: "integer", minimum: 1, maximum: 100_000 }, rationale: shortStr })
  },
  retentionActions: {
    type: "array", maxItems: 40,
    items: object({ action: { type: "string", enum: ["keep", "archive"] }, targetId: shortStr, reason: shortStr })
  },
  blockers: { type: "array", maxItems: 10, items: object({ code: shortStr, message: shortStr }) }
});

/**
 * Fewer than three comparable observations is insufficient evidence by the Skill's own written rule —
 * enforced here rather than trusted, the same way every other quantitative gate in this app is.
 */
export function validateWeeklyInsight(value: unknown, context: WeeklyInsightContext): WeeklyInsightResult {
  const raw = value as WeeklyInsightResult | undefined;
  if (!raw || !Array.isArray(raw.insightProposals) || !Array.isArray(raw.estimateUpdates)
    || !Array.isArray(raw.retentionActions) || !Array.isArray(raw.blockers)) {
    throw new Error("WEEKLY_INSIGHT_SCHEMA_INVALID");
  }
  if (raw.blockers.length) {
    const error = new Error("WEEKLY_INSIGHT_BLOCKED");
    (error as Error & { detail?: string }).detail =
      raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；").slice(0, 400);
    throw error;
  }
  const knownIds = new Set([
    ...context.executions.map((item) => item.id),
    ...context.notificationEvents.map((item) => item.id),
    ...context.planChanges.map((item) => item.id)
  ]);
  for (const proposal of raw.insightProposals) {
    if (proposal.observationCount < 3) throw new Error("WEEKLY_INSIGHT_INSUFFICIENT_EVIDENCE");
    for (const id of [...proposal.supportingEventIds, ...proposal.counterexampleEventIds]) {
      if (!knownIds.has(id)) throw new Error("WEEKLY_INSIGHT_UNKNOWN_EVENT_ID");
    }
  }
  return raw;
}
