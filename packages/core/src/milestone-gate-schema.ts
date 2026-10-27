import { validateSuccessCriteria, type SuccessCriterion } from "./index";
import { ARTIFACT_SOFT_CODES, sanitizeArtifactReferences, validateArtifactReferences, type LineArtifacts } from "./artifact-plan";
import { MILESTONE_PLAN_SCHEMA, validateMilestonePlans, type MilestonePlan, type ProfileForMilestones, type TargetProposal } from "./milestone-plan";
import { EVIDENCE_QUESTION_SCHEMA, validateEvidenceQuestionBank, type EvidenceQuestionTemplate } from "./milestone-templates";

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
  /** `required: false` items are judged and reported but cannot hold back `pass`. */
  evidenceContract: Array<{ requirement: string; required: boolean }>;
  execution: {
    startedAt: string | null;
    endedAt: string | null;
    pauseMinutes: number;
    interruptions: Array<{ reason: string }>;
  };
  outgoingRelations: Array<{
    id: string; targetMilestoneId: string; targetIdentityId: string; kind: string; status: string;
  }>;
  /**
   * The person's own skill for this order's line (`crossline-mine:<line>`, docs/skills-library.md §4): their plays, preferences and red
   * lines, in full. Null when the line has none yet; then nothing can be violated and `fit.fits` is true.
   */
  mineSkill: { lineId: string; text: string } | null;
};

const str = { type: "string", minLength: 1, maxLength: 4000 } as const;
const nullableStr = { type: ["string", "null"], maxLength: 4000 } as const;
const emptyableStr = { type: "string", maxLength: 4000 } as const;
const strList = { type: "array", maxItems: 20, items: str } as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const list = (items: unknown, maxItems = 40) => ({ type: "array", maxItems, items });

export const MILESTONE_GATE_OUTPUT_SCHEMA = object({
  verdict: { type: "string", enum: ["pass", "partial", "insufficient", "refuted"] },
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
  blockers: list(object({ code: str, message: str }), 10),
  // Whether the delivery follows the person's own line skill. `violated` names each broken rule; a delivery that covers its contract
  // but breaks one is `partial`, not `pass`.
  fit: object({ fits: { type: "boolean" }, violated: strList, why: emptyableStr })
});

// Structured output runs in strict mode: every object needs additionalProperties:false and must
// list all of its properties as required. That rules out one object with optional fields, so the four
// measure shapes are a real union instead — which is also closer to what they are.
export const measure = {
  anyOf: [
    object({ kind: { type: "string", enum: ["count"] }, unit: str, atLeast: { type: "number" } }),
    object({ kind: { type: "string", enum: ["threshold"] }, unit: str,
      comparator: { type: "string", enum: ["gte", "lte"] }, value: { type: "number" }, bareLine: { type: "number" } }),
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

/**
 * A proposed milestone. It lands as a `draft` and stays there until the user approves it: a system
 * that could add its own goals would be choosing what the person is working towards.
 */
export type MilestoneProposal = {
  milestones: Array<{
    identityId: string; projectId: string; title: string;
    successCriteria: SuccessCriterion[]; rationale: string;
    /** Which supplied template this proposal was built from, or null for a free-form one. The
     * receiving layer (`computeMilestoneConfidence`) uses this — not a model self-rating — to decide
     * how much confidence a template-backed proposal earns. */
    templateId: string | null;
    /** Pre-generated evidence questions for this milestone, Codex-`ask` style — see 工作块 E. Always
     * present in the model's own output, but `persistProposals` (`apps/worker/src/milestone-
     * proposer.ts`) only actually uses it when `templateId` is null: a template-backed milestone takes
     * its bank from the template itself (deterministic), the same way its confidence does, rather than
     * trusting the model to reproduce it. */
    evidenceQuestionBank: EvidenceQuestionTemplate[];
    /** The person-specific anchors. Required whenever the context carries a profile; see `validateMilestonePlans`. */
    plan?: MilestonePlan;
  }>;
  /**
   * A target for each course that has none on record, proposed from the person's long-term goals with the reason. Written as an
   * unconfirmed fact the person can change in one click; the milestones' score lines are worked back from it.
   */
  targetProposals?: TargetProposal[];
  assumptions: string[];
  blockers: Array<{ code: string; message: string }>;
};
export const MILESTONE_PROPOSAL_SCHEMA = object({
  milestones: list(object({
    identityId: str, projectId: str, title: str,
    successCriteria: list(criterion, 10),
    rationale: str,
    templateId: { anyOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "null" }] },
    // Three, not six: with one chain per project a profile like this one asks for fifteen milestones, and the answer grew until the
    // model ran out of room and reported it as a blocker.
    evidenceQuestionBank: list(EVIDENCE_QUESTION_SCHEMA, 3),
    plan: MILESTONE_PLAN_SCHEMA
  }), 20),
  targetProposals: list(object({ projectId: str, value: str, why: str }), 8),
  assumptions: strList,
  // `fit` (the gate's judgement of the person's line skill) was copied in here by mistake with the gate's own field: in strict mode the
  // architect had to answer a question about a delivery that does not exist. It belongs to `MILESTONE_GATE_OUTPUT_SCHEMA` only.
  blockers: list(object({ code: str, message: str }), 10)
});

export type MilestoneProposalContext = {
  version: "crossline.milestone-proposal.v1";
  /** The interview's conclusions for planning (`planningProfile`): how the person works, what drains them, direction, line allocation. */
  personProfile?: string[];
  identities: Array<{ id: string; label: string; summary: string }>;
  existingMilestones: Array<{ id: string; identityId: string; title: string; status: string }>;
  recentWork: Array<{ milestoneId: string; intent: string; state: string }>;
  /** The template library available for this identity, offered so the model can build a proposal on
   * top of one instead of free-forming — see 工作块 D. A template chosen and followed verbatim is what
   * `computeMilestoneConfidence` reads as `"high"`. */
  templates: Array<{ id: string; identityId: string; kind: string; titleHint: string }>;
  /** What the user asked for, in their own words. Empty means "look at the whole picture". */
  request: string;
  /** What the person has corrected or shown about how they work (`preference_entries`), for the lines in this run. */
  personalPreferences?: string[];
  /** The person's profile. When present the answer must be anchored to it, dated and chained. */
  profile?: ProfileForMilestones;
  /** Web research the person has accepted: what was found, with where, so a milestone can build on it instead of guessing. */
  diligence?: Array<{ identityId: string; title: string; why: string; kind: string; dueDate: string; claims: string[]; sources: string[] }>;
  /**
   * The artifact plan's part for this line (one line per run): what it is to produce for other lines and what other lines supply to it.
   * The milestones declare them in `plan.outputs` / `plan.inputs`; the cross-line relations are derived from those references.
   */
  artifacts?: LineArtifacts;
  /**
   * Excerpts of the person's files that match this line (one line per run; docs/context-selection.md): its projects' files first. A
   * deadline or a graded part a file states is read here; a milestone still rests on facts (`sourceFactIds`), never on an excerpt alone.
   */
  materials?: Array<{ id: string; file: string; text: string }>;
};

export function validateMilestoneProposal(value: unknown, context: MilestoneProposalContext): MilestoneProposal {
  const raw = value as MilestoneProposal | undefined;
  if (!raw || !Array.isArray(raw.milestones) || !Array.isArray(raw.blockers) || !Array.isArray(raw.assumptions)) {
    throw new Error("PROPOSAL_SCHEMA_INVALID");
  }
  // A blocker next to real milestones is the model hedging about a thin line, not the whole answer being unusable: refusing it
  // threw away the lines it had done well (a real run, blocked on 「自媒体线缺少已确认的受众」 with milestones in hand). It travels
  // as an assumption instead, so the person sees what to correct. Only an answer with nothing in it is a stop.
  if (raw.blockers.length && !raw.milestones.length) {
    const error = new Error("PROPOSAL_BLOCKED");
    (error as Error & { detail?: string }).detail =
      raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；").slice(0, 400);
    throw error;
  }
  const known = new Set(context.identities.map((identity) => identity.id));
  const titles = new Set(context.existingMilestones.map((milestone) => milestone.title.trim()));
  const templateIds = new Set(context.templates.map((template) => template.id));
  for (const proposal of raw.milestones) {
    // A milestone on an identity the user does not have is not a proposal, it is a new life.
    if (!known.has(proposal.identityId)) throw new Error("PROPOSAL_IDENTITY_UNKNOWN");
    if (!proposal.title.trim()) throw new Error("PROPOSAL_TITLE_REQUIRED");
    if (titles.has(proposal.title.trim())) throw new Error("PROPOSAL_DUPLICATE_TITLE");
    // A templateId has to name a template that was actually offered — the model copying a plausible-
    // looking id that was never in its own context is the same fabrication risk `evidenceQuote` guards
    // against elsewhere, just for an id instead of a quote.
    if (proposal.templateId !== null && !templateIds.has(proposal.templateId)) throw new Error("PROPOSAL_TEMPLATE_UNKNOWN");
    // The same check `saveMilestone` will run, surfaced here as a proposal problem rather than as an
    // opaque write failure later.
    const checked = validateSuccessCriteria(proposal.successCriteria);
    if (!checked.ok) throw new Error(checked.blocker.code);
    if (!validateEvidenceQuestionBank(proposal.evidenceQuestionBank)) throw new Error("PROPOSAL_EVIDENCE_QUESTION_BANK_INVALID");
  }
  if (context.profile) {
    const proposals = raw.targetProposals ?? [];
    for (const proposal of proposals) {
      if (!context.profile.projects.some((project) => project.id === proposal.projectId)) {
        const error = new Error("PROPOSAL_TARGET_PROJECT_UNKNOWN");
        // i18n-ignore: a repair message to the model
        (error as Error & { detail?: string }).detail = `targetProposals 里的 projectId「${proposal.projectId}」不是这个人的项目。`;
        throw error;
      }
      if (proposal.value.trim().length < 2 || proposal.why.trim().length < 10) {
        const error = new Error("PROPOSAL_TARGET_UNREASONED");
        // i18n-ignore: a repair message to the model
        (error as Error & { detail?: string }).detail = `「${proposal.projectId}」的目标要写清楚是什么，并用一两句话说明为什么按这个人的长期目标它合适。`;
        throw error;
      }
    }
    validateMilestonePlans(raw.milestones, context.profile, new Set(context.existingMilestones.map((milestone) => milestone.id)), proposals);
    if (context.artifacts) validateArtifactReferences(raw.milestones, context.artifacts);
  }
  const hedges = raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean);
  return { milestones: raw.milestones, targetProposals: raw.targetProposals ?? [], assumptions: [...raw.assumptions, ...hedges], blockers: [] };
}

/**
 * The milestone architect's refusals that are about quality — a vague title, a score line without margin or derivation, a missing
 * outcome, a chain shorter or longer than usual, a course part or project left out, an uncited target — as opposed to what the store
 * or the timeline cannot take (an unknown id, no plan, no deadline, criteria `saveMilestone` would refuse). After the repairs these
 * are kept with a warning for the reviewer instead of costing the whole line (decided 2026-10-07).
 */
export const MILESTONE_SOFT_CODES = new Set(["MILESTONE_TITLE_GENERIC", "MILESTONE_NOT_CONCRETE", "MILESTONE_NO_MARGIN", "MILESTONE_DERIVATION_MISSING",
  "MILESTONE_OUTCOME_UNSTATED", "MILESTONE_OUTCOME_REQUIRED", "MILESTONE_TARGET_UNPROPOSED", "MILESTONE_TARGET_NOT_CITED", "MILESTONE_TARGET_REQUIRED",
  "MILESTONE_COURSE_PARTS_MISSING", "MILESTONE_PROJECT_MISSING", "MILESTONE_CHAIN_TOO_SHORT", "MILESTONE_CHAIN_TOO_LONG", "MILESTONE_SOURCE_UNCONFIRMED",
  "MILESTONE_SOURCE_REQUIRED", "MILESTONE_BASELINE_REQUIRED", "MILESTONE_ORDER_INCONSISTENT", "MILESTONE_NOT_CHAINED", "MILESTONE_DEPENDENCY_ORDER",
  "MILESTONE_PREP_ONLY",
  "PROPOSAL_TARGET_UNREASONED", ...ARTIFACT_SOFT_CODES]);

/**
 * What is left of a milestone answer once a soft refusal is set aside: everything `validateMilestoneProposal` checks without the
 * person-specific plan rules, plus what storing the plans needs (a plan with a key and a real date, dependencies on keys that exist,
 * projects that exist). Undefined means the answer cannot be stored and the refusal stands.
 */
export function keepMilestoneProposal(value: unknown, context: MilestoneProposalContext, code: string): MilestoneProposal | undefined {
  if (!MILESTONE_SOFT_CODES.has(code)) return undefined;
  const { profile, ...general } = context;
  const raw = value as MilestoneProposal;
  let kept: MilestoneProposal;
  try { kept = validateMilestoneProposal({ ...raw, targetProposals: [] }, general); } catch { return undefined; }
  if (!profile) return kept;
  const projects = new Set(profile.projects.map((project) => project.id));
  const keys = new Set(kept.milestones.map((milestone) => milestone.plan?.key));
  for (const milestone of kept.milestones) {
    const plan = milestone.plan;
    if (!plan || typeof plan.key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(plan.deadline ?? "") || !Array.isArray(plan.dependsOn)
      || !Array.isArray(plan.sourceFactIds) || plan.dependsOn.some((key) => !keys.has(key))) return undefined;
    if (milestone.projectId && !projects.has(milestone.projectId)) return undefined;
  }
  // Artifact references that would not pass are dropped, so what is stored can only derive valid relations.
  const milestones = context.artifacts ? sanitizeArtifactReferences(kept.milestones, context.artifacts) : kept.milestones;
  return { ...kept, milestones, targetProposals: (raw.targetProposals ?? []).filter((proposal) => projects.has(proposal.projectId)
    && proposal.value.trim().length >= 2) };
}
