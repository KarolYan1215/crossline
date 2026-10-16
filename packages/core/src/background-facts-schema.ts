/**
 * What the background-facts compaction Skill is allowed to return — structured facts (current
 * experiment/paper title, key file paths, the kind of thing onboarding digs up) extracted from one
 * capture's own title/context. A fresh capture carries no identity — `addCapturedTaskWithId` writes only
 * a `captures` row, deliberately zero classification — so this schema has the Skill pick which identity
 * each fact belongs to itself, from the identities the workspace actually has. That is a *different*
 * inference than WorkOrder identity classification (a separate, additive step feeding a background-facts
 * bucket, not the capture row or a WorkOrder), so it does not reopen the "capture does no classification"
 * invariant `addCapturedTaskWithId` exists to keep. Deliberately single-shot (no multi-turn conversation
 * — this runs silently after every capture, not as a dialogue), and every fact must quote the text it
 * came from, the same `evidenced` defence `analysis.ts` already uses against a model inventing a fact
 * nobody actually said.
 */
export type BackgroundFactsContext = {
  version: "crossline.background-facts.v1";
  identities: Array<{ id: string; label: string }>;
  existingFacts: Array<{ identityId: string; key: string; value: string; updatedAt: string }>;
  captureTitle: string;
  captureContext: string;
};

export type BackgroundFactsProposal = {
  facts: Array<{ identityId: string; key: string; value: string; why: string; sourceQuote: string }>;
  blockers: Array<{ code: string; message: string }>;
};

const str = { type: "string", minLength: 1, maxLength: 2000 } as const;
const shortStr = { type: "string", minLength: 1, maxLength: 200 } as const;
const why = { type: "string", minLength: 1, maxLength: 300 } as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const BACKGROUND_FACTS_OUTPUT_SCHEMA = object({
  // Ten is generous for one capture — a capture that surfaces more than ten new/changed facts in one
  // message, across all identities combined, is not the normal case this step is written for.
  facts: {
    type: "array", maxItems: 10,
    items: object({ identityId: shortStr, key: shortStr, value: str, why, sourceQuote: str })
  },
  blockers: { type: "array", maxItems: 5, items: object({ code: shortStr, message: shortStr }) }
});

export function validateBackgroundFactsProposal(value: unknown, context: BackgroundFactsContext): BackgroundFactsProposal {
  const raw = value as BackgroundFactsProposal | undefined;
  if (!raw || !Array.isArray(raw.facts) || !Array.isArray(raw.blockers)) {
    throw new Error("BACKGROUND_FACTS_SCHEMA_INVALID");
  }
  if (raw.blockers.length) {
    const error = new Error("BACKGROUND_FACTS_BLOCKED");
    (error as Error & { detail?: string }).detail =
      raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；").slice(0, 400);
    throw error;
  }
  const knownIdentities = new Set(context.identities.map((identity) => identity.id));
  if (raw.facts.some((fact) => !knownIdentities.has(fact.identityId))) {
    throw new Error("BACKGROUND_FACTS_IDENTITY_UNKNOWN");
  }
  // Only the capture's own text counts as evidence — same reasoning `analysis.ts`'s `evidenced` already
  // applies: quoting something the app itself authored (an existing fact's own value, an identity label)
  // proves nothing about what this capture actually said.
  const fragments = [context.captureTitle, context.captureContext].map((text) => text.trim()).filter(Boolean);
  const evidenced = (quote: string) => fragments.some((text) => text.includes(quote) && quote.length >= Math.min(4, text.length));
  const fabricated = raw.facts.filter((fact) => !evidenced(fact.sourceQuote));
  if (fabricated.length) {
    const error = new Error("BACKGROUND_FACTS_EVIDENCE_INVALID");
    (error as Error & { detail?: string }).detail =
      // i18n-ignore: a repair message sent back to the model
      `以下引用不是原文逐字内容，无法核对 —— ${fabricated.map((fact) => `「${fact.sourceQuote}」`).join("、")}`.slice(0, 400);
    throw error;
  }
  const seenKeys = new Set<string>();
  for (const fact of raw.facts) {
    const key = `${fact.identityId}:${fact.key}`;
    if (seenKeys.has(key)) throw new Error("BACKGROUND_FACTS_DUPLICATE_KEY");
    seenKeys.add(key);
  }
  return { facts: raw.facts, blockers: [] };
}
