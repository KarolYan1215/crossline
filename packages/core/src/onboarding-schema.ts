import { validateSuccessCriteria, type SuccessCriterion } from "./index";
import { criterion } from "./milestone-gate-schema";

/**
 * What the onboarding skill is allowed to return.
 *
 * Scoped to what this app already has a real, audited write path for: milestone proposals through the
 * same `draft`-then-approve flow `crossline-milestone-architect` already uses. `identities[]`/
 * `projects[]`/`capacityPolicy` are in the Skill's own written contract but are not implemented here —
 * identity packs are a static code-level registry in this app (`packages/identity-packs`), not a
 * user-editable list, and capacity commitments have no write path at all yet (only a seeded seed and a
 * read). Proposing either would be asking the Skill to fill in a form this app cannot yet save.
 */
export type OnboardingContext = {
  version: "crossline.onboarding.v1";
  answers: Array<{ id: string; question: string; answer: string }>;
  identities: Array<{ id: string; label: string }>;
  existingMilestones: Array<{ id: string; identityId: string; title: string; status: string }>;
};

export type OnboardingProposal = {
  milestoneProposals: Array<{
    identityId: string; projectId: string; title: string; successCriteria: SuccessCriterion[];
    rationale: string; confidence: "low" | "medium" | "high"; sourceRefs: string[];
  }>;
  blockers: Array<{ code: string; message: string }>;
};

const str = { type: "string", minLength: 1, maxLength: 2000 } as const;
const shortStr = { type: "string", minLength: 1, maxLength: 500 } as const;
const idArray = { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 200 } } as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const ONBOARDING_OUTPUT_SCHEMA = object({
  milestoneProposals: {
    type: "array", maxItems: 8,
    items: object({
      identityId: shortStr, projectId: shortStr, title: shortStr, successCriteria: { type: "array", minItems: 1, maxItems: 6, items: criterion },
      rationale: str, confidence: { type: "string", enum: ["low", "medium", "high"] }, sourceRefs: idArray
    })
  },
  blockers: { type: "array", maxItems: 10, items: object({ code: shortStr, message: shortStr }) }
});

export function validateOnboardingProposal(value: unknown, context: OnboardingContext): OnboardingProposal {
  const raw = value as OnboardingProposal | undefined;
  if (!raw || !Array.isArray(raw.milestoneProposals) || !Array.isArray(raw.blockers)) {
    throw new Error("ONBOARDING_SCHEMA_INVALID");
  }
  if (raw.blockers.length) {
    const error = new Error("ONBOARDING_BLOCKED");
    (error as Error & { detail?: string }).detail =
      raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；").slice(0, 400);
    throw error;
  }
  const knownIdentities = new Set(context.identities.map((identity) => identity.id));
  const knownAnswerIds = new Set(context.answers.map((answer) => answer.id));
  const titles = new Set(context.existingMilestones.map((milestone) => milestone.title.trim()));
  for (const proposal of raw.milestoneProposals) {
    if (!knownIdentities.has(proposal.identityId)) throw new Error("ONBOARDING_IDENTITY_UNKNOWN");
    if (!proposal.title.trim()) throw new Error("ONBOARDING_TITLE_REQUIRED");
    if (titles.has(proposal.title.trim())) throw new Error("ONBOARDING_DUPLICATE_TITLE");
    if (!proposal.sourceRefs.every((ref) => knownAnswerIds.has(ref))) throw new Error("ONBOARDING_UNKNOWN_SOURCE_REF");
    const checked = validateSuccessCriteria(proposal.successCriteria);
    if (!checked.ok) throw new Error(checked.blocker.code);
  }
  return { milestoneProposals: raw.milestoneProposals, blockers: [] };
}
