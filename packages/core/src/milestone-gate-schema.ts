import { validateSuccessCriteria, type SuccessCriterion } from "./index";

/**
 * The wire contract for the milestone gate Skill.
 *
 * The judgement itself belongs to the Skill; `validateMilestoneGateResult` (in `index.ts`) is the
 * deterministic receiving layer that refuses a verdict inconsistent with its own criteria verdicts or
 * built on quotes that are not in the submitted evidence. This module only describes the shape, so the
 * two halves stay in one place each rather than drifting apart.
 */
export type MilestoneGateContext = {
  version: "crossline.milestone-gate.v1";
  milestone: {
    id: string;
    title: string;
    version: number;
    successCriteria: SuccessCriterion[];
  };
  evidencePolicy: "tiered" | "telemetry";
  /** Exactly the text the gate may quote. A quote from anywhere else is rejected by the receiving layer. */
  evidenceClaims: Array<{ id: string; kind: string; text: string }>;
  evidenceContract: Array<{ requirement: string }>;
  execution: {
    startedAt: string | null;
    endedAt: string | null;
    pauseMinutes: number;
    interruptions: Array<{ reason: string }>;
  };
  outgoingRelations: Array<{
    id: string; targetMilestoneId: string; targetIdentityId: string; kind: string; status: string;
  }>;
};

const str = { type: "string", minLength: 1, maxLength: 4000 } as const;
const nullableStr = { type: ["string", "null"], maxLength: 4000 } as const;
const emptyableStr = { type: "string", maxLength: 4000 } as const;
const strList = { type: "array", maxItems: 20, items: str } as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const list = (items: unknown, maxItems = 40) => ({ type: "array", maxItems, items });

export const MILESTONE_GATE_OUTPUT_SCHEMA = object({
  verdict: { type: "string", enum: ["pass", "insufficient", "refuted"] },
  criteriaVerdict: list(object({
    criterionId: str,
    met: { type: "string", enum: ["met", "partial", "unmet", "unverifiable"] },
    // `observed` is always required — say what you saw. The quote may be empty, and must be, when the
    // reading is `unmet` or `unverifiable`: there is no verbatim text for something the evidence does
    // not contain, and requiring one only teaches the model to quote something irrelevant.
    observed: str, evidenceQuote: emptyableStr, shortfall: nullableStr
  })),
  contractCoverage: list(object({
    requirement: str, satisfiedBy: nullableStr, reasoning: str, quote: { type: "string", maxLength: 4000 }
  })),
  unplannedGains: list(object({ finding: str, evidenceQuote: str, mayEnable: strList })),
  improvements: list(object({
    area: { type: "string", enum: ["evidence", "method", "scope", "pace"] },
    observation: str, suggestion: str
  })),
  incomplete: list(object({ what: str, blocksWhich: strList, isBlockingPass: { type: "boolean" } })),
  flywheelAssessment: list(object({
    relationId: str, targetMilestoneId: str, targetIdentityId: str,
    supports: { type: "string", enum: ["advances", "neutral", "contradicts"] },
    whatIsNowPossible: str, whatIsStillMissing: str, evidenceQuote: str
  })),
  gaps: list(object({ code: str, whatWouldSatisfyIt: str })),
  // A concrete shape, not a bare object: strict mode rejects an object with no declared properties,
  // and "a proposal with a title and a reason" is what this was always meant to carry.
  proposedNextMilestones: list(object({ title: str, why: str }), 10),
  blockers: list(object({ code: str, message: str }), 10)
});

/**
 * What a criteria proposal is allowed to return.
 *
 * Criteria are the user's to own, so this Skill only ever proposes: nothing here is written to a
 * milestone without an explicit acceptance step.
 */
export type CriteriaProposal = {
  milestones: Array<{ milestoneId: string; successCriteria: SuccessCriterion[]; rationale: string }>;
  assumptions: string[];
  blockers: Array<{ code: string; message: string }>;
};

// Structured output runs in strict mode: every object needs additionalProperties:false and must
// list all of its properties as required. That rules out one object with optional fields, so the four
// measure shapes are a real union instead — which is also closer to what they are.
export const measure = {
  anyOf: [
    object({ kind: { type: "string", enum: ["count"] }, unit: str, atLeast: { type: "number" } }),
    object({ kind: { type: "string", enum: ["threshold"] }, unit: str,
      comparator: { type: "string", enum: ["gte", "lte"] }, value: { type: "number" } }),
    object({ kind: { type: "string", enum: ["artifact"] }, mustExist: str }),
    object({ kind: { type: "string", enum: ["judgement"] }, rubric: str, failsWhen: str })
  ]
};

// `evidenceOf` is required of the model even though the stored type allows it to be absent: criteria
// written before the field existed are legitimately unlabelled, but a model proposing a new one always
// knows which side it is on, and letting it skip the question is how every criterion becomes an output.
export const criterion = object({
  id: str, statement: str, required: { type: "boolean" },
  evidenceOf: { type: "string", enum: ["output", "outcome"] },
  measure
});

export const CRITERIA_OUTPUT_SCHEMA = object({
  milestones: list(object({
    milestoneId: str,
    successCriteria: list(criterion, 10),
    rationale: str
  }), 20),
  assumptions: strList,
  blockers: list(object({ code: str, message: str }), 10)
});

/**
 * A proposed milestone. It lands as a `draft` and stays there until the user approves it: a system
 * that could add its own goals would be choosing what the person is working towards.
 */
export type MilestoneProposal = {
  milestones: Array<{
    identityId: string; projectId: string; title: string;
    successCriteria: SuccessCriterion[]; rationale: string;
  }>;
  assumptions: string[];
  blockers: Array<{ code: string; message: string }>;
};

export const MILESTONE_PROPOSAL_SCHEMA = object({
  milestones: list(object({
    identityId: str, projectId: str, title: str,
    successCriteria: list(criterion, 10),
    rationale: str
  }), 10),
  assumptions: strList,
  blockers: list(object({ code: str, message: str }), 10)
});

export type MilestoneProposalContext = {
  version: "crossline.milestone-proposal.v1";
  identities: Array<{ id: string; label: string; summary: string }>;
  existingMilestones: Array<{ id: string; identityId: string; title: string; status: string }>;
  recentWork: Array<{ milestoneId: string; intent: string; state: string }>;
  /** What the user asked for, in their own words. Empty means "look at the whole picture". */
  request: string;
};

export function validateMilestoneProposal(value: unknown, context: MilestoneProposalContext): MilestoneProposal {
  const raw = value as MilestoneProposal | undefined;
  if (!raw || !Array.isArray(raw.milestones) || !Array.isArray(raw.blockers) || !Array.isArray(raw.assumptions)) {
    throw new Error("PROPOSAL_SCHEMA_INVALID");
  }
  if (raw.blockers.length) {
    const error = new Error("PROPOSAL_BLOCKED");
    (error as Error & { detail?: string }).detail =
      raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；").slice(0, 400);
    throw error;
  }
  const known = new Set(context.identities.map((identity) => identity.id));
  const titles = new Set(context.existingMilestones.map((milestone) => milestone.title.trim()));
  for (const proposal of raw.milestones) {
    // A milestone on an identity the user does not have is not a proposal, it is a new life.
    if (!known.has(proposal.identityId)) throw new Error("PROPOSAL_IDENTITY_UNKNOWN");
    if (!proposal.title.trim()) throw new Error("PROPOSAL_TITLE_REQUIRED");
    if (titles.has(proposal.title.trim())) throw new Error("PROPOSAL_DUPLICATE_TITLE");
    // The same check `saveMilestone` will run, surfaced here as a proposal problem rather than as an
    // opaque write failure later.
    const checked = validateSuccessCriteria(proposal.successCriteria);
    if (!checked.ok) throw new Error(checked.blocker.code);
  }
  return { milestones: raw.milestones, assumptions: raw.assumptions, blockers: [] };
}

export type CriteriaContext = {
  version: "crossline.milestone-criteria.v1";
  milestones: Array<{ id: string; identityId: string; title: string; evidencePolicy: string }>;
  recentWork: Array<{ milestoneId: string; intent: string; state: string }>;
};

/**
 * Structural check only. Whether the criteria are *good* is the user's call, which is exactly why this
 * returns proposals rather than writing them.
 */
export function validateCriteriaProposal(value: unknown, context: CriteriaContext): CriteriaProposal {
  const raw = value as CriteriaProposal | undefined;
  if (!raw || !Array.isArray(raw.milestones) || !Array.isArray(raw.blockers) || !Array.isArray(raw.assumptions)) {
    throw new Error("CRITERIA_SCHEMA_INVALID");
  }
  if (raw.blockers.length) {
    const error = new Error("CRITERIA_BLOCKED");
    (error as Error & { detail?: string }).detail =
      raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；").slice(0, 400);
    throw error;
  }
  const known = new Set(context.milestones.map((milestone) => milestone.id));
  for (const proposal of raw.milestones) {
    // Criteria for a milestone that does not exist cannot be reviewed, let alone accepted.
    if (!known.has(proposal.milestoneId)) throw new Error("CRITERIA_MILESTONE_UNKNOWN");
    if (!proposal.successCriteria.length) throw new Error("CRITERIA_EMPTY");
    const ids = proposal.successCriteria.map((criterion) => criterion.id);
    if (new Set(ids).size !== ids.length) throw new Error("CRITERIA_DUPLICATE_ID");
  }
  return { milestones: raw.milestones, assumptions: raw.assumptions, blockers: [] };
}
