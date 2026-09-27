import { validateSuccessCriteria, type SuccessCriterion } from "./index";
import { criterion } from "./milestone-gate-schema";
import { RELATION_KINDS } from "./flywheel-schema";

/**
 * What the onboarding skill is allowed to return.
 *
 * Scoped to what this app already has a real, audited write path for: milestone proposals through the
 * same `draft`-then-approve flow `crossline-milestone-architect` already uses, plus milestone relations
 * through the same `candidate`-then-batch-approve flow the nightly flywheel scout already uses.
 * `identities[]`/`projects[]`/`capacityPolicy` are in the Skill's own written contract but are not
 * implemented here — identity packs are a static code-level registry in this app
 * (`packages/identity-packs`), not a user-editable list, and capacity commitments have no write path at
 * all yet (only a seeded seed and a read). Proposing either would be asking the Skill to fill in a form
 * this app cannot yet save.
 *
 * This is a real conversation, not a single-shot form: `reply` is what the interviewer actually says this
 * turn (a follow-up question while it is still digging into one identity, or a wrap-up once it has
 * enough), and `focusIdentityId`/`allIdentitiesCovered` are how the app knows whether to keep the thread
 * open for another identity or show the conversation as finished. Nothing here lets the Skill decide
 * sequencing outside the schema — it is only ever allowed to say what it is asking about and whether it
 * is done, never to skip the draft/candidate review step for what it proposes.
 */
export type OnboardingContext = {
  version: "crossline.onboarding.v1";
  answers: Array<{ id: string; question: string; answer: string }>;
  /** Local context the user opted into sharing — today, summarised excerpts from their own Codex CLI
   * session history (see `codex-history-schema.ts`), never full transcripts. Empty unless they consented. */
  sources: Array<{ id: string; label: string; excerpt: string }>;
  identities: Array<{ id: string; label: string }>;
  existingMilestones: Array<{ id: string; identityId: string; title: string; status: string }>;
  /** Which identity this turn should be digging into, carried over from the previous turn's own
   * `focusIdentityId` — `null` only on the very first turn, when the Skill picks where to start. */
  focusIdentityId: string | null;
};

export type OnboardingProposal = {
  reply: string;
  focusIdentityId: string | null;
  allIdentitiesCovered: boolean;
  milestoneProposals: Array<{
    identityId: string; projectId: string; title: string; successCriteria: SuccessCriterion[];
    rationale: string; confidence: "low" | "medium" | "high"; sourceRefs: string[];
  }>;
  /** A flywheel relation between two milestones named by title rather than id — the two ends may be
   * existing milestones, or ones `milestoneProposals` is proposing in this very turn, which do not have
   * a real id yet. `validateOnboardingProposal` resolves both against the union of the two. */
  relationProposals: Array<{
    fromTitle: string; toTitle: string;
    kind: "enables" | "reuses" | "informs" | "constrains" | "recurring_feedback";
    explanation: string; refutedWhen: string; sourceRefs: string[];
  }>;
  blockers: Array<{ code: string; message: string }>;
};

const str = { type: "string", minLength: 1, maxLength: 2000 } as const;
const shortStr = { type: "string", minLength: 1, maxLength: 500 } as const;
const idArray = { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 200 } } as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const ONBOARDING_OUTPUT_SCHEMA = object({
  reply: { type: "string", minLength: 1, maxLength: 2000 },
  focusIdentityId: { anyOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "null" }] },
  allIdentitiesCovered: { type: "boolean" },
  milestoneProposals: {
    type: "array", maxItems: 8,
    items: object({
      identityId: shortStr, projectId: shortStr, title: shortStr, successCriteria: { type: "array", minItems: 1, maxItems: 6, items: criterion },
      rationale: str, confidence: { type: "string", enum: ["low", "medium", "high"] }, sourceRefs: idArray
    })
  },
  relationProposals: {
    type: "array", maxItems: 6,
    items: object({
      fromTitle: shortStr, toTitle: shortStr, kind: { type: "string", enum: [...RELATION_KINDS] },
      explanation: str, refutedWhen: str, sourceRefs: idArray
    })
  },
  blockers: { type: "array", maxItems: 10, items: object({ code: shortStr, message: shortStr }) }
});

export function validateOnboardingProposal(value: unknown, context: OnboardingContext): OnboardingProposal {
  const raw = value as OnboardingProposal | undefined;
  if (!raw || typeof raw.reply !== "string" || typeof raw.allIdentitiesCovered !== "boolean"
    || !Array.isArray(raw.milestoneProposals) || !Array.isArray(raw.blockers)) {
    throw new Error("ONBOARDING_SCHEMA_INVALID");
  }
  if (raw.blockers.length) {
    const error = new Error("ONBOARDING_BLOCKED");
    (error as Error & { detail?: string }).detail =
      raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；").slice(0, 400);
    throw error;
  }
  const knownIdentities = new Set(context.identities.map((identity) => identity.id));
  if (raw.focusIdentityId !== null && !knownIdentities.has(raw.focusIdentityId)) {
    throw new Error("ONBOARDING_IDENTITY_UNKNOWN");
  }
  const knownSourceIds = new Set([...context.answers.map((answer) => answer.id), ...context.sources.map((source) => source.id)]);
  const titles = new Set(context.existingMilestones.map((milestone) => milestone.title.trim()));
  for (const proposal of raw.milestoneProposals) {
    if (!knownIdentities.has(proposal.identityId)) throw new Error("ONBOARDING_IDENTITY_UNKNOWN");
    if (!proposal.title.trim()) throw new Error("ONBOARDING_TITLE_REQUIRED");
    if (titles.has(proposal.title.trim())) throw new Error("ONBOARDING_DUPLICATE_TITLE");
    if (!proposal.sourceRefs.every((ref) => knownSourceIds.has(ref))) throw new Error("ONBOARDING_UNKNOWN_SOURCE_REF");
    const checked = validateSuccessCriteria(proposal.successCriteria);
    if (!checked.ok) throw new Error(checked.blocker.code);
  }
  // Both ends of a relation must resolve to a title this turn actually knows about — an existing
  // milestone, or one it is proposing in the very same turn. A relation to any other title would be an
  // edge pointing at a milestone the person never saw, the same hole `flywheel-schema` closes with
  // `known.has(relation.fromMilestoneId)`.
  const relations = Array.isArray(raw.relationProposals) ? raw.relationProposals : [];
  const titlesThisTurn = new Set([...titles, ...raw.milestoneProposals.map((proposal) => proposal.title.trim())]);
  const seenRelations = new Set<string>();
  for (const relation of relations) {
    if (!titlesThisTurn.has(relation.fromTitle.trim()) || !titlesThisTurn.has(relation.toTitle.trim())) {
      throw new Error("ONBOARDING_RELATION_MILESTONE_UNKNOWN");
    }
    if (relation.fromTitle.trim() === relation.toTitle.trim()) throw new Error("ONBOARDING_RELATION_SELF_LOOP");
    if (!RELATION_KINDS.includes(relation.kind)) throw new Error("ONBOARDING_RELATION_KIND_INVALID");
    const key = `${relation.fromTitle.trim()}->${relation.toTitle.trim()}:${relation.kind}`;
    if (seenRelations.has(key)) throw new Error("ONBOARDING_RELATION_DUPLICATE");
    seenRelations.add(key);
    if (!relation.explanation.trim()) throw new Error("ONBOARDING_RELATION_EXPLANATION_REQUIRED");
    if (!relation.refutedWhen.trim()) throw new Error("ONBOARDING_RELATION_FALSIFIER_REQUIRED");
    if (!relation.sourceRefs.every((ref) => knownSourceIds.has(ref))) throw new Error("ONBOARDING_UNKNOWN_SOURCE_REF");
  }
  return {
    reply: raw.reply, focusIdentityId: raw.focusIdentityId, allIdentitiesCovered: raw.allIdentitiesCovered,
    milestoneProposals: raw.milestoneProposals, relationProposals: relations, blockers: []
  };
}
