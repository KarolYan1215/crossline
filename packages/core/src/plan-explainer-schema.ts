/**
 * What the plan explainer is allowed to return.
 *
 * The Skill explains a schedule this app already computed deterministically (`packages/planner`'s
 * lexicographic ordering) — it never re-ranks or re-scores anything. `nextActionReason` and each
 * alternative's `reason` are the only new content; everything else in the context is a fact the app
 * already has, handed over so the explanation can cite it instead of inventing one.
 */
export type PlanExplainerContext = {
  version: "crossline.plan-explainer.v1";
  today: string;
  nextActionId: string | null;
  alternativeIds: string[];
  activeWorkOrders: Array<{
    /** The short name the person sees on cards and the plan page (`taskTitleOf`); the explanation names tasks by it, never by `intent`. */
    id: string; title?: string; intent: string; identityId: string;
    estimateP50Minutes: number; energy: "low" | "medium" | "high" | null;
    important: boolean; confirmedDeadline: string | null;
    /** From the scheduler's own result when the web app supplied it: urgency tier (1 most urgent), importance 0–100, first block. */
    tier?: number; weight?: number; firstBlock?: string | null; unplacedReason?: string | null;
  }>;
  currentEnergy: "low" | "medium" | "high" | "uncalibrated";
  approvedMilestones: Array<{ id: string; identityId: string; title: string }>;
};

/** The scheduler's real ordering, as the plan page shows it, handed to the explainer so it narrates that and nothing else. */
export type PlanRankingInput = Array<{ id: string; tier: number; weight: number; deadline: string | null; firstDay: string | null;
  firstStart: string | null; blocker: string | null }>;

export type PlanExplanation = {
  summary: string;
  nextActionReason: string;
  alternatives: Array<{ id: string; reason: string }>;
  blockers: Array<{ code: string; message: string }>;
};

const shortStr = { type: "string", minLength: 1, maxLength: 500 } as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const PLAN_EXPLAINER_OUTPUT_SCHEMA = object({
  summary: shortStr,
  nextActionReason: shortStr,
  alternatives: { type: "array", maxItems: 10, items: object({ id: shortStr, reason: shortStr }) },
  blockers: { type: "array", maxItems: 10, items: object({ code: shortStr, message: shortStr }) }
});

/**
 * Every id the explanation cites must be one this app actually handed it — an explanation that names a
 * work order the context never mentioned would look checkable and would not be.
 */
export function validatePlanExplanation(value: unknown, context: PlanExplainerContext): PlanExplanation {
  const raw = value as PlanExplanation | undefined;
  if (!raw || typeof raw.summary !== "string" || typeof raw.nextActionReason !== "string"
    || !Array.isArray(raw.alternatives) || !Array.isArray(raw.blockers)) {
    throw new Error("PLAN_EXPLAINER_SCHEMA_INVALID");
  }
  if (raw.blockers.length) {
    const error = new Error("PLAN_EXPLAINER_BLOCKED");
    (error as Error & { detail?: string }).detail =
      raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；").slice(0, 400);
    throw error;
  }
  const knownIds = new Set([...context.activeWorkOrders.map((order) => order.id)]);
  for (const alternative of raw.alternatives) {
    if (!knownIds.has(alternative.id)) throw new Error("PLAN_EXPLAINER_UNKNOWN_ID");
  }
  return { summary: raw.summary, nextActionReason: raw.nextActionReason, alternatives: raw.alternatives, blockers: [] };
}
