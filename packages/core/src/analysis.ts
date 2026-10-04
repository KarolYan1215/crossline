import type { WorkOrder } from "./index";
import { trimLeakedTail } from "./text-hygiene";

export type AnalysisContext = {
  version: string;
  capture: { title: string; context: string };
  /** `hasSuccessCriteria: false` is a milestone that cannot record progress yet (a starter, a bare draft that was approved). */
  approvedMilestones: Array<{ id: string; projectId: string; identityId: string; title: string; version: number; hasSuccessCriteria: boolean }>;
  availableInputs: Array<{ id: string; text: string }>;
  identityPacks: Array<{ id: string; version: number; summary: string }>;
  // How this workspace's own past captures actually turned out, per (identityId, family) — not a
  // suggestion to copy, evidence the model can weigh against its own read of the current capture.
  // `medianActualMinutes: 0` means no real completions exist yet for that pair, same convention
  // `Estimate.observationCount` already uses for "no observations".
  historicalStats: Array<{ identityId: string; family: "preparation" | "review" | "deep_work"; chosenCount: number; medianActualMinutes: number }>;
  /**
   * How this person actually works, measured (see `WorkRhythm`). 0 in any field means "not enough data to say", never a default. The ratio is
   * applied to the estimate in code afterwards, so the Skill is told not to apply it itself.
   */
  rhythm?: { focusRunMinutes: number; productiveMinutesPerDay: number; planActualRatio: number; observedDays: number; completed: number };
  policy: { tools: never[]; externalSideEffects: boolean; humanApprovalRequired: boolean };
};
type SplitEvidence = { quote: string; rationale: string };
export type AnalysisProposal = Omit<WorkOrder, "id" | "ownerId" | "workspaceId" | "state" | "automationParts" | "humanCore"> & {
  automationParts: Array<WorkOrder["automationParts"][number] & SplitEvidence>;
  humanCore: Array<WorkOrder["humanCore"][number] & SplitEvidence>;
  blockers: Array<{ code: string; message: string }>;
  /** Focused minutes by step, whose sum is the estimate's median: the number is auditable, and a padded one shows as padding. */
  estimateBreakdown: Array<{ step: string; minutes: number }>;
};

type Schema = { type: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: false;
  items?: Schema; enum?: Array<string | boolean>; minimum?: number; minLength?: number; maxLength?: number; maxItems?: number; minItems?: number };
const str: Schema = { type: "string", minLength: 1, maxLength: 4000 };
const bool: Schema = { type: "boolean" };
const number: Schema = { type: "number", minimum: 0 };
const choice = (...values: string[]): Schema => ({ type: "string", enum: values });
const object = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const array = (items: Schema, minItems = 0, maxItems = 32): Schema => ({ type: "array", items, minItems, maxItems });
const kind = choice("file", "link", "record", "telemetry");
/**
 * A contract item: the short label of what must be handed over or produced, plus the reason.
 *
 * `description` alone used to be the entire item, and every run padded it — restated policy, its own
 * self-checks, once its raw scratch text — until it hit whatever cap was in place and arrived cut off.
 * Four caps were tried, 4000 → 300 → 200 → 80, and each was treated as a target. Tightening was the
 * wrong instinct twice over. The direct cause was that every split in this schema carries a
 * `rationale` and a contract item carried none, so the model had something real to say and one field
 * to say it in; that is what `why` fixes. And tightening actively made it worse: constrained decoding
 * concentrates repetition at field terminals, so a narrower field exhausts its valid continuations
 * sooner and degenerates earlier. Three hundred, with a repair turn behind it, not eighty.
 */
const CONTRACT_LINE_LIMIT = 300;
const line: Schema = { type: "string", minLength: 1, maxLength: CONTRACT_LINE_LIMIT };
const why: Schema = { type: "string", minLength: 1, maxLength: 300 };
const family = choice("preparation", "review", "deep_work");
// Empty means "not bound to any of the offered milestones" — the same sentinel the store layer already
// treats as legitimate (`acceptWorkOrderEvidence` skips the milestone gate on a falsy `milestoneId`).
// Day-to-day work that GTD calls a "next action with no project" used to have no way to say so here:
// the model had to force-fit it onto an approved milestone or the whole capture stopped with a blocker.
const optionalMilestoneId: Schema = { type: "string", minLength: 0, maxLength: 4000 };
export const ANALYSIS_OUTPUT_SCHEMA = object({
  identityId: str, projectId: str, milestoneId: optionalMilestoneId, intent: str, family,
  automationParts: array(object({ id: str, intent: str, reversibility: choice("local"), quote: str, rationale: str })),
  humanCore: array(object({ id: str, intent: str, energy: choice("low", "medium", "high"), interruptible: bool, quote: str, rationale: str }), 1),
  // Eight, not thirty-two: no real contract has thirty-two lines, and a large allowance is room the
  // model fills — the padded third item in a real run was where its own scratch text leaked out.
  materialContract: array(object({ kind, description: line, why, required: bool }), 0, 8),
  evidenceContract: array(object({ kind, description: line, why, required: bool }), 1, 8),
  estimate: object({ p25Minutes: number, p50Minutes: number, p85Minutes: number, source: choice("llm_prior"),
    observationCount: { type: "integer", minimum: 0 }, confidence: choice("low") }),
  riskTier: choice("routine", "milestone", "high_risk"), blockers: array(object({ code: str, message: str })),
  estimateBreakdown: array(object({ step: line, minutes: number }), 1, 8)
});

// Only the JSON Schema subset used above is accepted; unknown keys fail closed.
function matches(value: unknown, schema: Schema): boolean {
  if (schema.enum && !schema.enum.includes(value as string)) return false;
  switch (schema.type) {
    case "string": return typeof value === "string" && value.trim().length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity);
    case "number": case "integer": return typeof value === "number" && Number.isFinite(value) && value >= (schema.minimum ?? -Infinity) && (schema.type !== "integer" || Number.isInteger(value));
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && value.every((item) => matches(item, schema.items!));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const entries = value as Record<string, unknown>;
      return Object.keys(entries).length === schema.required!.length && schema.required!.every((key) => Object.hasOwn(entries, key) && matches(entries[key], schema.properties![key]!));
    }
    default: return false;
  }
}

export function validateAnalysisContext(value: unknown): AnalysisContext {
  const schema = object({ version: choice("crossline.analysis.v1"), capture: object({ title: str, context: { type: "string", maxLength: 4000 } }),
    approvedMilestones: array(object({ id: str, projectId: str, identityId: str, title: str, version: { type: "integer", minimum: 1 }, hasSuccessCriteria: bool }), 1),
    availableInputs: array(object({ id: str, text: str })), identityPacks: array(object({ id: str, version: { type: "integer", minimum: 1 }, summary: str }), 1),
    historicalStats: array(object({ identityId: str, family, chosenCount: { type: "integer", minimum: 0 }, medianActualMinutes: number }), 0, 32),
    rhythm: object({ focusRunMinutes: number, productiveMinutesPerDay: number, planActualRatio: number, observedDays: number, completed: number }),
    policy: object({ tools: { type: "array", items: str, maxItems: 0 }, externalSideEffects: { type: "boolean", enum: [false] }, humanApprovalRequired: { type: "boolean", enum: [true] } }) });
  // A context stored before the rhythm existed has none; it reads as "nothing measured".
  const full = value && typeof value === "object" && !("rhythm" in value)
    ? { ...(value as object), rhythm: { focusRunMinutes: 0, productiveMinutesPerDay: 0, planActualRatio: 0, observedDays: 0, completed: 0 } } : value;
  if (!matches(full, schema)) throw new Error("ANALYSIS_CONTEXT_INVALID");
  const context = full as AnalysisContext;
  // Every milestone offered must be backed by a pack; the Skill picks the identity, the app never guesses it.
  if (context.approvedMilestones.some((milestone) => !context.identityPacks.some((pack) => pack.id === milestone.identityId))) throw new Error("ANALYSIS_CONTEXT_INVALID");
  return context;
}

export function validateAnalysisProposal(value: unknown, input: AnalysisContext): AnalysisProposal {
  const context = validateAnalysisContext(input);
  // An answer written before the breakdown existed (a recorded one) has none; the runtime's schema makes every live answer carry it.
  const candidate = value && typeof value === "object" && !("estimateBreakdown" in value) ? { ...(value as object), estimateBreakdown: [{ step: "legacy", minutes: (value as { estimate?: { p50Minutes?: number } }).estimate?.p50Minutes ?? 1 }] } : value;
  if (!matches(candidate, ANALYSIS_OUTPUT_SCHEMA)) throw new Error("ANALYSIS_SCHEMA_INVALID");
  const injected = candidate !== value;
  const proposal = candidate as AnalysisProposal;
  // The identity is a free string in the schema (the set of lines is not known until the context is built), so the check that it
  // names a real one has to live here. Without it a task that fit no line came back with the identity `\`, was accepted, and sat
  // on the real board under a line called 「\」 that no page can open.
  if (!context.identityPacks.some((pack) => pack.id === proposal.identityId)) {
    const error = new Error("ANALYSIS_IDENTITY_UNKNOWN");
    (error as Error & { detail?: string }).detail =
      `identityId 「${proposal.identityId.slice(0, 40)}」不是已有的主线。可选：${context.identityPacks.map((pack) => pack.id).join("、")}；挑最贴近的一条（关于 Crossline 本身的事归创业线）。`;
    throw error;
  }
  if (proposal.milestoneId && !context.approvedMilestones.some((m) => m.id === proposal.milestoneId && m.projectId === proposal.projectId && m.identityId === proposal.identityId)) throw new Error("ANALYSIS_MILESTONE_MISMATCH");
  const e = proposal.estimate;
  if (e.p25Minutes < 1 || e.p25Minutes > e.p50Minutes || e.p50Minutes > e.p85Minutes || e.p85Minutes > 10080 || e.observationCount !== 0) throw new Error("ANALYSIS_ESTIMATE_INVALID");
  // The safety margin is stated, in p85, not hidden in the steps: p85 is "something goes wrong once", and an estimate with no room above its
  // typical value is one overrun from a missed deadline. It is also bounded above, because a margin of three times is a guess wearing a margin's name.
  if (e.p85Minutes < Math.ceil(e.p50Minutes * 1.2) || e.p85Minutes > Math.max(e.p50Minutes * 3, e.p50Minutes + 30)) {
    const error = new Error("ANALYSIS_ESTIMATE_MARGIN_INVALID");
    (error as Error & { detail?: string }).detail = `p85Minutes 是 ${e.p85Minutes}，p50Minutes 是 ${e.p50Minutes}：p85 是留的余量，要在 p50 的 1.2 倍到 3 倍之间（至少 ${Math.ceil(e.p50Minutes * 1.2)}），按最可能超时的那一步来定，不要把每一步都加长。`;
    throw error;
  }
  // The estimate is the sum of its steps, within a quarter: a number that cannot be reconciled with its own parts is padding or a guess.
  const stepTotal = proposal.estimateBreakdown.reduce((sum, item) => sum + item.minutes, 0);
  if (!(proposal.estimateBreakdown.length === 1 && proposal.estimateBreakdown[0]!.step === "legacy") && Math.abs(stepTotal - e.p50Minutes) > Math.max(10, e.p50Minutes * 0.25)) {
    const error = new Error("ANALYSIS_ESTIMATE_BREAKDOWN_MISMATCH");
    (error as Error & { detail?: string }).detail = `estimateBreakdown 各步分钟数加起来是 ${Math.round(stepTotal)}，但 p50Minutes 是 ${e.p50Minutes}：两者要对得上（p50 就是各步之和，误差不超过四分之一）。`;
    throw error;
  }
  // Only text the user actually supplied counts. Identity-pack summaries and milestone titles are
  // app-authored constants, so quoting them proves nothing about the captured intent.
  const fragments = [context.capture.title, context.capture.context, ...context.availableInputs.map((i) => i.text)].map((text) => text.trim()).filter(Boolean);
  // Relative, not a fixed character count: four characters is meaningless against a long note but
  // impossible for a three-character capture, which would leave such captures permanently unanalysable.
  const evidenced = (quote: string) => fragments.some((text) => text.includes(quote) && quote.length >= Math.min(4, text.length));
  // Strip a run of repeated characters off the end of every contract string before judging it.
  //
  // Whatever string field has a cap, the model fills to it — the reason moved out of `description` and
  // straight into `why`, which came back with a real sentence followed by forty repetitions of one
  // combining mark. This cannot remove content: no requirement and no reason ends in eight identical
  // characters. Trimming beats rejecting here, because the sentence in front of the padding is whole,
  // and it beats storing it, because the person would be reading the padding.
  const REPEATED_TAIL = new RegExp("(.)\\1{7,}$", "u");
  const trimFiller = (text: string): string => trimLeakedTail(text.replace(REPEATED_TAIL, "").trimEnd()) || text;

  /**
   * Drops a sentence that just re-says the end of one already written.
   *
   * The padding came back in a second shape: not one character forty times, but the previous sentence's
   * tail echoed as decaying fragments — 「…不因缺少原文而停止。续推进，不因缺少原文而停止。里原文而停止。」.
   * These are not substrings of each other, so an exact-containment test misses them; what they share is
   * the ending. A sentence whose whole second half has already been said adds nothing a reader does not
   * already have, so dropping it removes no information, and the first complete sentence survives.
   */
  const dropEchoes = (text: string): string => {
    const parts = text.split(/(?<=[。！？!?.])/u).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) return text;
    const kept: string[] = [];
    for (const part of parts) {
      const bare = part.replace(/[。！？!?.]+$/u, "");
      const tail = bare.slice(-Math.max(4, Math.ceil(bare.length / 2)));
      if (tail.length >= 3 && kept.some((seen) => seen.includes(tail))) continue;
      kept.push(part);
    }
    return kept.join("") || text;
  };

  for (const item of [...proposal.materialContract, ...proposal.evidenceContract]) {
    item.description = trimFiller(item.description);
    item.why = dropEchoes(trimFiller(item.why));
  }
  const contracts = [...proposal.materialContract, ...proposal.evidenceContract];
  // The core deliverable has to be required. `pass` is measured against the required evidence only, so an
  // all-optional contract is one nothing can fail: the acceptance bar would be whatever the person
  // chose to hand in. The Skill was never told what `required` means and marked every item false.
  if (!proposal.evidenceContract.some((item) => item.required)) {
    const error = new Error("ANALYSIS_EVIDENCE_REQUIRED_MISSING");
    (error as Error & { detail?: string }).detail =
      "分析被拒绝：证据要求里没有一条标为必需。至少要把“交付了这件事”的那条核心交付物设为 required=true（次要的佐证才设为 false）。可重新分析。";
    throw error;
  }
  // Brackets in the **label** mean the JSON leaked into it — one real run left `'}],` there followed by
  // the model's own scratch reasoning, short enough to pass the length bound and shown to the person as
  // the thing to produce. The label is a checklist line; it has no structure in it.
  //
  // Only the label. This check first covered `why` too and immediately refused a perfectly good
  // proposal whose reason quoted the person's own feedback — a reason is a sentence, and sentences
  // contain quotation marks. A guard that blocks correct work is worse than the junk it was written
  // for, so quotation marks are gone from the set as well: `'}],` is caught by the brackets alone.
  const leaked = contracts.filter((item) => /[{}[\]]/.test(item.description));
  if (leaked.length) {
    const error = new Error("ANALYSIS_CONTRACT_NOT_PROSE");
    (error as Error & { detail?: string }).detail =
      `分析被拒绝：材料/证据契约的名称里混进了不是给人读的文字 —— ${leaked.map((item) => `「${item.description.slice(0, 40)}」`).join("、")}。可重新分析。`.slice(0, 400);
    throw error;
  }
  // Exactly at the limit means the sentence was cut off, not that it happened to fit. Truncated text
  // is not a requirement anybody can act on, so it is refused rather than displayed.
  const cut = contracts.filter((item) => item.description.length >= CONTRACT_LINE_LIMIT);
  if (cut.length) {
    const error = new Error("ANALYSIS_CONTRACT_TRUNCATED");
    (error as Error & { detail?: string }).detail =
      `分析被拒绝：契约条目被截断，读不完整 —— ${cut.map((item) => `「${item.description.slice(0, 40)}…」`).join("、")}。可重新分析。`.slice(0, 400);
    throw error;
  }

  const splits = [...proposal.automationParts, ...proposal.humanCore];
  if (new Set(splits.map((s) => s.id)).size !== splits.length) throw new Error("ANALYSIS_EVIDENCE_INVALID");
  const fabricated = splits.filter((s) => !evidenced(s.quote));
  if (fabricated.length) {
    // The rejection itself is correct — a quote that is not in the capture is fabricated and must not
    // become a work order. But "运行未完成" told the person nothing, so the same capture failed the same
    // way with nothing to act on. Naming the offending quote is what turns it into a retry they can win.
    const error = new Error("ANALYSIS_EVIDENCE_INVALID");
    (error as Error & { detail?: string }).detail =
      `分析被拒绝：以下引用不是原文逐字内容，无法核对 —— ${fabricated.map((s) => `「${s.quote}」`).join("、")}。可重新分析。`.slice(0, 400);
    throw error;
  }
  if (proposal.blockers.length) {
    // The Skill said why it stopped — usually a required input it was not given. Dropping that and
    // showing only a code leaves the person with nothing to act on, which is the dead end this
    // codebase keeps removing elsewhere. `detail` is the Skill's own words, carried as text and never
    // parsed into a decision.
    const error = new Error("ANALYSIS_POLICY_BLOCKED");
    (error as Error & { detail?: string }).detail =
      proposal.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；").slice(0, 400);
    throw error;
  }
  // What was never in the answer is not stored as if it had been.
  if (injected) delete (proposal as Partial<AnalysisProposal>).estimateBreakdown;
  return proposal;
}
