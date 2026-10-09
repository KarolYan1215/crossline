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

/**
 * What each kind is called on screen, and what it claims, in one place (decided 2026-10-08: 「使能」「使之可能」 read as jargon). The
 * meaning is "from" → "to": what the source line does for the line the arrow points at.
 */
export const RELATION_KIND_LABEL: Record<string, string> = {
  enables: "促成", reuses: "复用", informs: "提供输入", constrains: "约束", recurring_feedback: "反馈回路"
};
export const RELATION_KIND_MEANING: Record<string, string> = {
  enables: "前者的产出是后者推进的前提",
  reuses: "前者的产出被后者直接再用",
  informs: "前者得到的信息帮后者做判断",
  constrains: "前者占用或限制后者的时间、精力或方向",
  recurring_feedback: "后者的结果持续回流、强化前者"
};

/**
 * The loops in a directed graph of lines — each a flywheel: A feeds B feeds … feeds A. A constraint is not a feed, so it never closes a
 * loop. Each loop is listed once, starting from its smallest node; small graphs only (the person has a handful of lines).
 */
export function flywheelLoops(edges: Array<{ from: string; to: string; kind: string }>): string[][] {
  const next = new Map<string, Set<string>>();
  for (const edge of edges) if (edge.kind !== "constrains" && edge.from !== edge.to) {
    if (!next.has(edge.from)) next.set(edge.from, new Set());
    next.get(edge.from)!.add(edge.to);
  }
  const nodes = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort();
  const loops: string[][] = [];
  for (const start of nodes) {
    const walk = (node: string, path: string[]) => {
      for (const to of next.get(node) ?? []) {
        if (to === start && path.length > 1) loops.push([...path]);
        else if (to > start && !path.includes(to)) walk(to, [...path, to]);
      }
    };
    walk(start, [start]);
  }
  return loops.sort((a, b) => b.length - a.length);
}

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

/**
 * A flywheel answer kept after its repairs ran out: the relations that pass every check on their own are kept, the rest dropped, so
 * one relation with no falsifier no longer costs the night's findings (decided 2026-10-07). Undefined when even the findings fail.
 */
export function keepFlywheelExpansion(value: unknown, context: FlywheelContext, code: string): FlywheelExpansion | undefined {
  if (!code.startsWith("FLYWHEEL_RELATION_") && code !== "FLYWHEEL_SOURCE_REQUIRED" && code !== "FLYWHEEL_MILESTONE_UNKNOWN") return undefined;
  const raw = value as FlywheelExpansion;
  if (!raw || !Array.isArray(raw.relations)) return undefined;
  const kept: FlywheelExpansion["relations"] = [];
  for (const relation of raw.relations) {
    try { validateFlywheelExpansion({ ...raw, relations: [...kept, relation] }, context); kept.push(relation); } catch { /* dropped */ }
  }
  try { return validateFlywheelExpansion({ ...raw, relations: kept }, context); } catch { return undefined; }
}
