/**
 * What the nightly expansion is allowed to return.
 *
 * Every item must point at a milestone that already exists and cite a source it actually read, with a
 * date and the condition that would make it stale. An "insight" with no URL and no expiry is a claim
 * nobody can check later, which is the kind of thing this system deletes rather than stores.
 */
export type FlywheelFinding = {
  milestoneId: string;
  summary: string;
  sourceUrl: string;
  sourceTitle: string;
  retrievedAt: string;
  /** What would make this stop being true — the finding's own falsifier. */
  staleWhen: string;
  helpsHow: string;
};

/**
 * A proposed connection between two milestones that already exist.
 *
 * Held to the same standard as a finding, for the same reason: a relation nobody can check is an
 * opinion with an arrow drawn around it. `refutedWhen` is the relation's own falsifier — without it
 * the relation could never be shown wrong, and `refuted` would never be reachable.
 */
export type FlywheelRelation = {
  fromMilestoneId: string;
  toMilestoneId: string;
  kind: "enables" | "reuses" | "informs" | "constrains" | "recurring_feedback";
  explanation: string;
  refutedWhen: string;
  sourceUrl: string;
  sourceTitle: string;
  retrievedAt: string;
};

export type FlywheelExpansion = {
  findings: FlywheelFinding[];
  relations: FlywheelRelation[];
  blockers: Array<{ code: string; message: string }>;
};

export const RELATION_KINDS = ["enables", "reuses", "informs", "constrains", "recurring_feedback"] as const;

const str = { type: "string", minLength: 1, maxLength: 4000 } as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const FLYWHEEL_OUTPUT_SCHEMA = object({
  findings: {
    type: "array", minItems: 0, maxItems: 20,
    items: object({
      milestoneId: str, summary: str, sourceUrl: str, sourceTitle: str,
      retrievedAt: str, staleWhen: str, helpsHow: str
    })
  },
  relations: {
    type: "array", minItems: 0, maxItems: 10,
    items: object({
      fromMilestoneId: str, toMilestoneId: str,
      kind: { type: "string", enum: [...RELATION_KINDS] },
      explanation: str, refutedWhen: str, sourceUrl: str, sourceTitle: str, retrievedAt: str
    })
  },
  blockers: { type: "array", maxItems: 10, items: object({ code: str, message: str }) }
});

export type FlywheelContext = {
  version: "crossline.flywheel.v1";
  openMilestones: Array<{ id: string; identityId: string; title: string; successCriteria: unknown[] }>;
  recentOutputs: Array<{ milestoneId: string; intent: string; acceptedAt: string }>;
};

export function validateFlywheelExpansion(value: unknown, context: FlywheelContext): FlywheelExpansion {
  const raw = value as FlywheelExpansion | undefined;
  if (!raw || !Array.isArray(raw.findings) || !Array.isArray(raw.blockers)) throw new Error("FLYWHEEL_SCHEMA_INVALID");
  // Tolerated as absent so an older Skill answer is not rejected for lacking a field it never had;
  // anything present is held to the full standard below.
  const relations = Array.isArray(raw.relations) ? raw.relations : [];
  const known = new Set(context.openMilestones.map((milestone) => milestone.id));
  for (const finding of raw.findings) {
    // A finding that hangs off nothing is the RSS feed this was explicitly not supposed to become.
    if (!known.has(finding.milestoneId)) throw new Error("FLYWHEEL_MILESTONE_UNKNOWN");
    // No source, no date, no expiry condition — no way to check it later.
    if (!/^https?:\/\/\S+$/.test(finding.sourceUrl ?? "")) throw new Error("FLYWHEEL_SOURCE_REQUIRED");
    if (Number.isNaN(Date.parse(finding.retrievedAt ?? ""))) throw new Error("FLYWHEEL_SOURCE_REQUIRED");
    if (!finding.staleWhen?.trim()) throw new Error("FLYWHEEL_STALENESS_REQUIRED");
  }

  const seen = new Set<string>();
  for (const relation of relations) {
    // Both ends must already exist. Proposing a relation to a milestone the user has not approved is
    // how a research note quietly becomes a new commitment.
    if (!known.has(relation.fromMilestoneId) || !known.has(relation.toMilestoneId)) {
      throw new Error("FLYWHEEL_MILESTONE_UNKNOWN");
    }
    // A self-loop carries no information: `recurring_feedback` is a cycle between different milestones,
    // which the graph allows, not a milestone pointing at itself.
    if (relation.fromMilestoneId === relation.toMilestoneId) throw new Error("FLYWHEEL_RELATION_SELF_LOOP");
    if (!RELATION_KINDS.includes(relation.kind)) throw new Error("FLYWHEEL_RELATION_KIND_INVALID");
    const key = `${relation.fromMilestoneId}->${relation.toMilestoneId}:${relation.kind}`;
    if (seen.has(key)) throw new Error("FLYWHEEL_RELATION_DUPLICATE");
    seen.add(key);
    if (!/^https?:\/\/\S+$/.test(relation.sourceUrl ?? "")) throw new Error("FLYWHEEL_SOURCE_REQUIRED");
    if (Number.isNaN(Date.parse(relation.retrievedAt ?? ""))) throw new Error("FLYWHEEL_SOURCE_REQUIRED");
    if (!relation.explanation?.trim()) throw new Error("FLYWHEEL_RELATION_EXPLANATION_REQUIRED");
    // Without a falsifier the relation could never be shown wrong, so `refuted` would be unreachable
    // and the graph could only ever grow.
    if (!relation.refutedWhen?.trim()) throw new Error("FLYWHEEL_RELATION_FALSIFIER_REQUIRED");
  }
  return { findings: raw.findings, relations, blockers: raw.blockers };
}
