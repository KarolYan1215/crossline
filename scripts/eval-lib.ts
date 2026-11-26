/**
 * The deterministic half of the rule evaluation (docs/plans/harness-1125.md §10), shared by `golden-from-corrections.ts` and `ablate.ts`
 * and tested by `eval-lib.test.ts` in CI: reading the person's corrections out of a ledger's events into golden cases, and replaying a
 * registered rule with its verdict used (`enforce`) and not used (`record`) to see how often it changes the answer and which mode agrees
 * with the person. Nothing here calls a model.
 */
import { completionRule, opportunityCategory, ruleLocked, RULE_SPEC, setRuleModes, type OpportunityCategory, type RuleId } from "../packages/core/src/index";

// ── golden cases ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type GoldenKind = "undo" | "gate" | "duration" | "date" | "reject" | "rename" | "completion";
/** One correction: what the system (a model, or a rule) said, and what the person made of it. */
export type GoldenCase = {
  id: string; kind: GoldenKind; source: string; at: string; entityId: string;
  /** What the correction is about, as the ledger names it (a task's title and intent, a gate's subject). */
  context: Record<string, unknown>;
  modelSaid: unknown; personSaid: unknown; note?: string;
  /** For an undo: whether the system did it by itself (only those are a model's or a rule's output). */
  bySystem?: boolean;
};
export type LedgerEvent = { eventId: string; type: string; entityId: string; payload: unknown; createdAt: string };
export type LedgerOrder = { id: string; intent: string; payload?: unknown };

/** Proposals the person turned down: the event types, and what the proposal was. */
export const REJECTION_TYPES = ["approval.declined", "goal.backplan_declined", "insight.rejected", "skill.rejected", "skill.public.rejected",
  "skill.grown.rejected", "skill.grown.revision_rejected", "assess.declined", "permission.rejected"] as const;

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const titleOf = (order: LedgerOrder | undefined) => order ? { title: String(record(order.payload).title ?? order.intent), intent: order.intent } : {};

/**
 * Every correction in a ledger's events, oldest first. `orders` gives a task's words for the cases that point at one. Reads, never writes;
 * the caller passes events from a backup copy, never the live ledger.
 */
export function extractGolden(events: readonly LedgerEvent[], orders: ReadonlyMap<string, LedgerOrder>): GoldenCase[] {
  const out: GoldenCase[] = [];
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const applied = new Map(events.filter((event) => event.type === "op.applied").map((event) => [event.entityId, event]));
  const add = (event: LedgerEvent, kind: GoldenKind, fields: Omit<GoldenCase, "id" | "kind" | "source" | "at" | "entityId">) =>
    out.push({ id: `${kind}:${event.eventId}`, kind, source: event.type, at: event.createdAt, entityId: event.entityId, ...fields });
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === "op.undone") {
      const op = record(applied.get(event.entityId)?.payload);
      add(event, "undo", { context: { label: op.label ?? payload.label ?? "" }, modelSaid: op.inverse ?? null, personSaid: "undone", bySystem: op.bySystem === true });
    } else if (event.type === "gate.overridden") {
      const judged = record(byId.get(String(payload.judgedId))?.payload);
      add(event, "gate", { context: { gate: payload.gate, subject: payload.subject }, modelSaid: { verdict: payload.from, reason: record(judged.output).reason ?? "" },
        personSaid: payload.to, ...(typeof payload.note === "string" && payload.note ? { note: payload.note } : {}) });
    } else if (event.type === "estimate.adjusted") {
      add(event, "duration", { context: { ...titleOf(orders.get(event.entityId)), stepId: payload.stepId ?? null }, modelSaid: payload.before ?? null, personSaid: payload.after });
    } else if (event.type === "work_order.due_changed") {
      add(event, "date", { context: titleOf(orders.get(event.entityId)), modelSaid: payload.before ?? null, personSaid: payload.after });
    } else if ((REJECTION_TYPES as readonly string[]).includes(event.type)) {
      add(event, "reject", { context: { ...titleOf(orders.get(event.entityId)), ...payload }, modelSaid: "proposed", personSaid: "rejected" });
    } else if (event.type === "task.renamed" && payload.by !== "system") {
      add(event, "rename", { context: titleOf(orders.get(event.entityId)), modelSaid: payload.before ?? null, personSaid: payload.title });
    }
  }
  // The person's own completion mode on a task (no event: it is a field on the task), against the model's judgement or, without one, the rule's.
  for (const order of orders.values()) {
    const payload = record(order.payload);
    const mode = payload.completionMode;
    if (mode !== "self_evident" && mode !== "needs_assessment") continue;
    const model = record(payload.completion);
    out.push({ id: `completion:${order.id}`, kind: "completion", source: "payload.completionMode", at: "", entityId: order.id, context: titleOf(order),
      modelSaid: typeof model.mode === "string" ? model.mode : null, personSaid: mode });
  }
  return out;
}

// ── ablation ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One sample an ablation replays: the input the rule reads, and the person's answer when there is one. */
export type AblationSample = { id: string; input: Record<string, unknown>; truth?: string };
export type Ablation = {
  /** Where its samples come from, in words (shown in the table). */
  source: string;
  samples: (data: { golden: readonly GoldenCase[]; fixtures: Record<string, unknown> }) => AblationSample[];
  /** The final answer the code gives for a sample under the current mode. */
  decide: (sample: AblationSample) => string;
};

/** The opportunity fixture's expected type as the category it implies; undefined when it implies none. */
const CATEGORY_OF_TYPE: Record<string, OpportunityCategory> = { competition: "competition", conference: "conference", internship: "internship", social: "local_event", talk: "local_event" };

/** The rules an ablation exists for. A rule without one is listed by `ablate.ts` with its telemetry only. */
export const ABLATIONS: Partial<Record<RuleId, Ablation>> = {
  "completion.legacy-title": {
    source: "golden completion cases without a model judgement (the person set the mode)",
    samples: ({ golden }) => golden.filter((item) => item.kind === "completion" && item.modelSaid === null).map((item) => ({ id: item.id,
      input: { intent: String(item.context.intent ?? ""), title: String(item.context.title ?? "") }, truth: String(item.personSaid) })),
    decide: (sample) => completionRule({ intent: String(sample.input.intent), payload: { title: String(sample.input.title) } }).mode
  },
  "opportunity.far-words": {
    source: "fixtures/opportunity-mail-social-and-lines.json (the reader's answers, category removed; truth from the expected type)",
    samples: ({ fixtures }) => {
      const cases = record(fixtures["opportunity-mail-social-and-lines"]).cases;
      return Object.entries(cases && typeof cases === "object" ? cases : {}).map(([key, value]) => {
        const item = record(value);
        const answer = record(item.answer);
        const truth = CATEGORY_OF_TYPE[String(record(item.expect).type ?? "")];
        return { id: `opportunity:${key}`, input: { kind: String(answer.kind ?? "event"), title: String(answer.title ?? "") }, ...(truth ? { truth } : {}) };
      });
    },
    decide: (sample) => opportunityCategory({ kind: sample.input.kind as "event", title: String(sample.input.title) })
  }
};

export type AblationRow = { id: string; truth?: string; enforce: string; record: string; changed: boolean };
export type AblationReport = {
  rule: RuleId; kind: string; mode: string; source: string; locked: boolean; samples: number; changed: number;
  /** Of the samples with the person's answer: how many each mode agrees with. */
  labelled: number; agreeEnforce: number; agreeRecord: number; rows: AblationRow[];
};

/** Replays `id`'s samples under `enforce` and under `record`. Money and invariant rules are refused (their overrides are ignored by design). */
export function ablate(id: RuleId, data: { golden: readonly GoldenCase[]; fixtures: Record<string, unknown> }): AblationReport | { rule: RuleId; refused: string } {
  if (ruleLocked(id)) return { rule: id, refused: `${RULE_SPEC[id].kind} rules are never ablated (owner's decision; overrides are ignored)` };
  const ablation = ABLATIONS[id];
  if (!ablation) return { rule: id, refused: "no ablation is defined for this rule yet (add one to ABLATIONS in scripts/eval-lib.ts)" };
  const samples = ablation.samples(data);
  const under = (mode: "enforce" | "record") => {
    setRuleModes({ [id]: mode });
    try { return samples.map((sample) => ablation.decide(sample)); } finally { setRuleModes(undefined); }
  };
  const enforced = under("enforce");
  const recorded = under("record");
  const rows = samples.map((sample, index) => ({ id: sample.id, ...(sample.truth !== undefined ? { truth: sample.truth } : {}), enforce: enforced[index]!, record: recorded[index]!,
    changed: enforced[index] !== recorded[index] }));
  const labelled = rows.filter((row) => row.truth !== undefined);
  return { rule: id, kind: RULE_SPEC[id].kind, mode: RULE_SPEC[id].mode, source: ablation.source, locked: false, samples: rows.length,
    changed: rows.filter((row) => row.changed).length, labelled: labelled.length,
    agreeEnforce: labelled.filter((row) => row.enforce === row.truth).length, agreeRecord: labelled.filter((row) => row.record === row.truth).length, rows };
}

/** How often a rule fired, by verdict and by whether it was applied, from `rule-fired.jsonl` lines. */
export function firingsOf(lines: readonly string[], id: RuleId): { total: number; applied: number; byVerdict: Record<string, number>; since?: string } {
  let total = 0, applied = 0, since: string | undefined;
  const byVerdict: Record<string, number> = {};
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (parsed.id !== id) continue;
    total += 1;
    if (parsed.applied === true) applied += 1;
    const verdict = String(parsed.verdict ?? "");
    byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
    if (typeof parsed.at === "string" && (!since || parsed.at < since)) since = parsed.at;
  }
  return { total, applied, byVerdict, ...(since ? { since } : {}) };
}
