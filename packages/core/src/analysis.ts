import type { WorkOrder } from "./index";
import { trimLeakedTail } from "./text-hygiene";
import { quoteSupportsDate } from "./date-schema";
import { cleanTaskTitle, withCourse } from "./task-title";
import { infoRequestTraits } from "./info-request";
import { COMPLETION_FIELD, readModelCompletion, type ModelCompletion } from "./completion";
import { tFor, type Locale } from "./i18n";
import { textWidth } from "./text-width";

export type AnalysisContext = {
  version: string;
  capture: { title: string; context: string };
  /** `hasSuccessCriteria: false` is a milestone that cannot record progress yet (a starter, a bare draft that was approved). */
  approvedMilestones: Array<{ id: string; projectId: string; identityId: string; title: string; version: number; hasSuccessCriteria: boolean; deadline?: string }>;
  availableInputs: Array<{ id: string; text: string }>;
  identityPacks: Array<{ id: string; version: number; summary: string }>;
  /** What the person has said or shown about how they work (v2; `preference_entries`). Absent on contexts stored before it. */
  personalPreferences?: string[];
  // How this workspace's own past captures actually turned out, per (identityId, family) — not a
  // suggestion to copy, evidence the model can weigh against its own read of the current capture.
  // `medianActualMinutes: 0` means no real completions exist yet for that pair, same convention
  // `Estimate.observationCount` already uses for "no observations".
  /** v1 only (dropped in v2: a correction handed to the model and then applied again afterwards). */
  historicalStats?: Array<{ identityId: string; family: "preparation" | "review" | "deep_work"; chosenCount: number; medianActualMinutes: number }>;
  /**
   * How this person actually works, measured (see `WorkRhythm`). 0 in any field means "not enough data to say", never a default. The ratio is
   * applied to the estimate in code afterwards, so the Skill is told not to apply it itself.
   */
  rhythm?: { focusRunMinutes: number; productiveMinutesPerDay: number; planActualRatio: number; observedDays: number; completed: number };
  /** v2: the person's local date, so 「周末前」「10月8号左右」 can be grounded to a day. */
  today?: string;
  /**
   * v2: the outside view — up to five finished tasks of the same line and kind, closest in size, with what the
   * analysis estimated and what they really took. Raw numbers only: no correction factor, which would anchor
   * the estimate and then be applied a second time by the calibration that runs afterwards.
   */
  referenceClass?: Array<{ identityId: string; family: "preparation" | "review" | "deep_work"; title: string; llmP50Minutes: number; actualMinutes: number }>;
  /** v2: approved links between lines, so a byproduct can name where it helps. */
  relations?: Array<{ fromMilestoneId: string; toMilestoneId: string; kind: string; explanation: string }>;
  /**
   * v2: the open tasks already on the board (the task library included), so the analysis does not write one that exists again and can
   * say which one a capture only adds to (`extendsTaskId`). Absent on contexts stored before it.
   */
  existingTasks?: ExistingTask[];
  policy: { tools: never[]; externalSideEffects: boolean; humanApprovalRequired: boolean };
};

/** An open task as a task-writing Skill sees it, so it does not write the same work twice (the owner's direction of 2026-10-15). */
export type ExistingTask = { id: string; title: string; intent: string; lineId: string; projectId: string; dueDate: string; state: string };
/** At most this many existing tasks go into a context: the nearest due first. */
export const EXISTING_TASKS_LIMIT = 60;

/** A dated fact read from the capture itself: when work can start (`release`) or must be done (`due`). */
export type AnalysisDate = { kind: "release" | "due"; date: string; quote: string; approximate: boolean };
/** Who the work is waiting for. All empty strings mean it waits for nobody. */
export type AnalysisWaitingOn = { who: string; what: string; expectedDate: string; quote: string };
/**
 * A byproduct for another line: something the same work can also produce. `captureSteps` are done during the
 * main task (noting ideas while simulating); `landing` is the short follow-up that turns them into the artifact,
 * scheduled after the main task is done. `milestoneId` is empty when it serves the line but no approved milestone.
 */
export type AnalysisByproduct = {
  lineId: string; milestoneId: string; artifact: string;
  captureSteps: Array<{ step: string; minutes: number }>;
  landing: { minutes: number; description: string };
  why: string;
};
type SplitEvidence = { quote: string; rationale: string };
export type AnalysisProposal = Omit<WorkOrder, "id" | "ownerId" | "workspaceId" | "state" | "automationParts" | "humanCore"> & {
  /** The task's name: a short action starting with its verb (`cleanTaskTitle`); `intent` is the description. */
  title: string;
  automationParts: Array<WorkOrder["automationParts"][number] & SplitEvidence>;
  humanCore: Array<WorkOrder["humanCore"][number] & SplitEvidence>;
  blockers: Array<{ code: string; message: string }>;
  /** Focused minutes by step, whose sum is the estimate's median: the number is auditable, and a padded one shows as padding. */
  estimateBreakdown: Array<{ step: string; minutes: number }>;
  dates: AnalysisDate[];
  waitingOn: AnalysisWaitingOn;
  byproducts: AnalysisByproduct[];
  /** How finishing it is taken (`completion.ts`): judged from what the task is, not its wording. Absent on answers recorded before it. */
  completion?: ModelCompletion;
  /** The open task this capture only adds to (its id from `existingTasks`), "" when it is new work. */
  extendsTaskId?: string;
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
/** Empty string means "none" — the same sentinel convention as `milestoneId`; `matches()` has no null. */
const optionalText: Schema = { type: "string", minLength: 0, maxLength: 300 };
export const ANALYSIS_OUTPUT_SCHEMA = object({
  identityId: str, projectId: str, milestoneId: optionalMilestoneId, title: str, intent: str, family,
  automationParts: array(object({ id: str, intent: str, reversibility: choice("local"), quote: str, rationale: str })),
  humanCore: array(object({ id: str, intent: str, energy: choice("low", "medium", "high"), interruptible: bool, quote: str, rationale: str }), 1),
  // Eight, not thirty-two: no real contract has thirty-two lines, and a large allowance is room the
  // model fills — the padded third item in a real run was where its own scratch text leaked out.
  materialContract: array(object({ kind, description: line, why, required: bool }), 0, 8),
  evidenceContract: array(object({ kind, description: line, why, required: bool }), 1, 8),
  estimate: object({ p25Minutes: number, p50Minutes: number, p85Minutes: number, source: choice("llm_prior"),
    observationCount: { type: "integer", minimum: 0 }, confidence: choice("low") }),
  riskTier: choice("routine", "milestone", "high_risk"), blockers: array(object({ code: str, message: str })),
  estimateBreakdown: array(object({ step: line, minutes: number }), 1, 8),
  dates: array(object({ kind: choice("release", "due"), date: str, quote: str, approximate: bool }), 0, 4),
  waitingOn: object({ who: optionalText, what: optionalText, expectedDate: optionalText, quote: optionalText }),
  byproducts: array(object({ lineId: str, milestoneId: optionalMilestoneId, artifact: line,
    captureSteps: array(object({ step: line, minutes: number }), 0, 4), landing: object({ minutes: number, description: line }), why }), 0, 3),
  completion: COMPLETION_FIELD as unknown as Schema,
  // An open task (from `existingTasks`) that already covers this capture's work, which this capture only adds to; "" for new work.
  extendsTaskId: optionalText
});

// Only the JSON Schema subset used above is accepted; unknown keys fail closed.
function matches(value: unknown, schema: Schema): boolean {
  if (schema.enum && !schema.enum.includes(value as string)) return false;
  switch (schema.type) {
    case "string": return typeof value === "string" && value.trim().length >= (schema.minLength ?? 0) && textWidth(value) <= (schema.maxLength ?? Infinity);
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

const sharedContext = {
  capture: object({ title: str, context: { type: "string", maxLength: 4000 } }),
  availableInputs: array(object({ id: str, text: str })), identityPacks: array(object({ id: str, version: { type: "integer", minimum: 1 }, summary: str }), 1),
  policy: object({ tools: { type: "array", items: str, maxItems: 0 }, externalSideEffects: { type: "boolean", enum: [false] }, humanApprovalRequired: { type: "boolean", enum: [true] } })
};
const V1_CONTEXT = object({ version: choice("crossline.analysis.v1"), ...sharedContext,
  approvedMilestones: array(object({ id: str, projectId: str, identityId: str, title: str, version: { type: "integer", minimum: 1 }, hasSuccessCriteria: bool }), 1),
  historicalStats: array(object({ identityId: str, family, chosenCount: { type: "integer", minimum: 0 }, medianActualMinutes: number }), 0, 32),
  rhythm: object({ focusRunMinutes: number, productiveMinutesPerDay: number, planActualRatio: number, observedDays: number, completed: number }) });
/**
 * v2 drops `historicalStats` and `rhythm` — both were corrections handed to the model (a median and a ratio)
 * while a calibration applied afterwards corrected the same bias again — and adds the outside view as raw
 * examples, today's date, each milestone's deadline, and the approved links between lines.
 */
const V2_CONTEXT = object({ version: choice("crossline.analysis.v2"), ...sharedContext,
  today: str,
  approvedMilestones: array(object({ id: str, projectId: str, identityId: str, title: str, version: { type: "integer", minimum: 1 }, hasSuccessCriteria: bool,
    deadline: { type: "string", minLength: 0, maxLength: 20 } }), 0),
  referenceClass: array(object({ identityId: str, family, title: str, llmP50Minutes: number, actualMinutes: number }), 0, 5),
  relations: array(object({ fromMilestoneId: str, toMilestoneId: str, kind: str, explanation: { type: "string", minLength: 0, maxLength: 4000 } }), 0, 40),
  personalPreferences: array(str, 0, 30),
  existingTasks: array(object({ id: str, title: str, intent: str, lineId: str, projectId: { type: "string", minLength: 0, maxLength: 4000 },
    dueDate: { type: "string", minLength: 0, maxLength: 20 }, state: str }), 0, EXISTING_TASKS_LIMIT) });
export const ANALYSIS_CONTEXT_VERSION = "crossline.analysis.v2";

export function validateAnalysisContext(value: unknown): AnalysisContext {
  const version = (value as { version?: unknown } | undefined)?.version;
  // A v1 context stored before the rhythm existed has none; it reads as "nothing measured".
  const full = version === "crossline.analysis.v1" && value && typeof value === "object" && !("rhythm" in value)
    ? { ...(value as object), rhythm: { focusRunMinutes: 0, productiveMinutesPerDay: 0, planActualRatio: 0, observedDays: 0, completed: 0 } }
    // A v2 context stored before personal preferences (or the existing tasks) existed reads as "nothing learned yet" ("no tasks shown").
    : version === "crossline.analysis.v2" && value && typeof value === "object" && (!("personalPreferences" in value) || !("existingTasks" in value))
      ? { personalPreferences: [], existingTasks: [], ...(value as object) } : value;
  if (!matches(full, version === "crossline.analysis.v2" ? V2_CONTEXT : V1_CONTEXT)) throw new Error("ANALYSIS_CONTEXT_INVALID");
  const context = full as AnalysisContext;
  // Every milestone offered must be backed by a pack; the Skill picks the identity, the app never guesses it.
  if (context.approvedMilestones.some((milestone) => !context.identityPacks.some((pack) => pack.id === milestone.identityId))) throw new Error("ANALYSIS_CONTEXT_INVALID");
  return context;
}

/** Items named in a refusal: 「a」、「b」 in Chinese, "a", "b" in English. */
const quotedIn = (locale: Locale | undefined) => (items: string[]) => locale === "en" ? items.map((item) => `"${item}"`).join(", ") : items.map((item) => `「${item}」`).join("、");

/**
 * `locale` is the language of the refusals the person reads on the capture (「分析被拒绝…可重新分析。」); the ones that only steer a
 * repair turn stay in the model's language.
 */
export function validateAnalysisProposal(value: unknown, input: AnalysisContext, locale?: Locale): AnalysisProposal {
  const t = tFor(locale);
  const quoted = quotedIn(locale);
  const context = validateAnalysisContext(input);
  // An answer written before the breakdown existed (a recorded one) has none; the runtime's schema makes every live answer carry it.
  const withBreakdown = value && typeof value === "object" && !("estimateBreakdown" in value) ? { ...(value as object), estimateBreakdown: [{ step: "legacy", minutes: (value as { estimate?: { p50Minutes?: number } }).estimate?.p50Minutes ?? 1 }] } : value;
  // Answers recorded before dates, waiting and byproducts existed carry none of them; a live answer always has all three.
  const legacyExtras: Record<string, unknown> = withBreakdown && typeof withBreakdown === "object" ? {
    ...(!("dates" in withBreakdown) ? { dates: [] } : {}),
    ...(!("waitingOn" in withBreakdown) ? { waitingOn: { who: "", what: "", expectedDate: "", quote: "" } } : {}),
    ...(!("byproducts" in withBreakdown) ? { byproducts: [] } : {}),
    ...(!("completion" in withBreakdown) ? { completion: { mode: "self_evident", reason: "", why: "legacy", question: "", askAfterHours: 0 } } : {}),
    ...(!("extendsTaskId" in withBreakdown) ? { extendsTaskId: "" } : {}),
    ...(!("title" in withBreakdown) ? { title: cleanTaskTitle(String((withBreakdown as { intent?: unknown }).intent ?? "")) || t("未命名任务") } : {})
  } : {};
  const candidate = Object.keys(legacyExtras).length ? { ...(withBreakdown as object), ...legacyExtras } : withBreakdown;
  if (!matches(candidate, ANALYSIS_OUTPUT_SCHEMA)) throw new Error("ANALYSIS_SCHEMA_INVALID");
  const injected = withBreakdown !== value;
  const proposal = candidate as AnalysisProposal;
  proposal.title = withCourse(cleanTaskTitle(proposal.title) || cleanTaskTitle(proposal.intent), proposal.projectId);
  // The identity is a free string in the schema (the set of lines is not known until the context is built), so the check that it
  // names a real one has to live here. Without it a task that fit no line came back with the identity `\`, was accepted, and sat
  // on the real board under a line called 「\」 that no page can open.
  if (!context.identityPacks.some((pack) => pack.id === proposal.identityId)) {
    const error = new Error("ANALYSIS_IDENTITY_UNKNOWN");
    (error as Error & { detail?: string }).detail =
      // i18n-ignore: a repair message to the model
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
    // i18n-ignore: a repair message to the model
    (error as Error & { detail?: string }).detail = `p85Minutes 是 ${e.p85Minutes}，p50Minutes 是 ${e.p50Minutes}：p85 是留的余量，要在 p50 的 1.2 倍到 3 倍之间（至少 ${Math.ceil(e.p50Minutes * 1.2)}），按最可能超时的那一步来定，不要把每一步都加长。`;
    throw error;
  }
  // The estimate is the sum of its steps, within a quarter: a number that cannot be reconciled with its own parts is padding or a guess.
  const stepTotal = proposal.estimateBreakdown.reduce((sum, item) => sum + item.minutes, 0);
  if (!(proposal.estimateBreakdown.length === 1 && proposal.estimateBreakdown[0]!.step === "legacy") && Math.abs(stepTotal - e.p50Minutes) > Math.max(10, e.p50Minutes * 0.25)) {
    const error = new Error("ANALYSIS_ESTIMATE_BREAKDOWN_MISMATCH");
    // i18n-ignore: a repair message to the model
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
      t("分析被拒绝：证据要求里没有一条标为必需。至少要把“交付了这件事”的那条核心交付物设为 required=true（次要的佐证才设为 false）。可重新分析。");
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
      t("分析被拒绝：材料/证据契约的名称里混进了不是给人读的文字 —— {{items}}。可重新分析。", { items: quoted(leaked.map((item) => item.description.slice(0, 40))) }).slice(0, 400);
    throw error;
  }
  // Exactly at the limit means the sentence was cut off, not that it happened to fit. Truncated text
  // is not a requirement anybody can act on, so it is refused rather than displayed.
  const cut = contracts.filter((item) => item.description.length >= CONTRACT_LINE_LIMIT);
  if (cut.length) {
    const error = new Error("ANALYSIS_CONTRACT_TRUNCATED");
    (error as Error & { detail?: string }).detail =
      t("分析被拒绝：契约条目被截断，读不完整 —— {{items}}。可重新分析。", { items: quoted(cut.map((item) => `${item.description.slice(0, 40)}…`)) }).slice(0, 400);
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
      t("分析被拒绝：以下引用不是原文逐字内容，无法核对 —— {{items}}。可重新分析。", { items: quoted(fabricated.map((s) => s.quote)) }).slice(0, 400);
    throw error;
  }
  // Getting a fact from someone (info-request.ts): the assistant may draft the message, but sending it is the person's, an external act.
  const request = infoRequestTraits({ title: proposal.title, intent: proposal.intent, p50Minutes: proposal.estimate.p50Minutes }).request;
  const sends = request?.kind === "ask_person" ? proposal.automationParts.filter((part) => /(发送|发出|寄出|send)/i.test(part.intent) && !/(草稿|起草|draft)/i.test(part.intent)) : [];
  if (sends.length) {
    const error = new Error("ANALYSIS_INFO_REQUEST_SENT_BY_SYSTEM");
    (error as Error & { detail?: string }).detail =
      t("分析被拒绝：向别人询问时，系统只起草邮件（收件人、主题、正文），发送由本人完成 —— {{items}} 应改为起草，发送放进 humanCore。", { items: quoted(sends.map((part) => part.intent.slice(0, 40))) }).slice(0, 400);
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
  // Dates and waiting are kept only when they can be checked against the person's own words: the quote must be
  // in the capture and must name the day. An unverifiable one is dropped, not fatal — the rest of the analysis is
  // good, and a guessed date on a schedule is worse than none (the same rule the file-date reader follows).
  const isDay = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  proposal.dates = proposal.dates.filter((item) => isDay(item.date) && evidenced(item.quote) && quoteSupportsDate(item.date, item.quote));
  const waiting = proposal.waitingOn;
  if (waiting.who.trim() || waiting.what.trim()) {
    if (!isDay(waiting.expectedDate) || !evidenced(waiting.quote) || !quoteSupportsDate(waiting.expectedDate, waiting.quote)) {
      proposal.waitingOn = { who: "", what: "", expectedDate: "", quote: "" };
    }
  }
  // At most one byproduct per other line; a line the person has not got, or the task's own line, is refused so the turn is repaired.
  const lines = new Set(context.identityPacks.map((pack) => pack.id));
  const seenLines = new Set<string>();
  for (const byproduct of proposal.byproducts) {
    /* i18n-ignore-start: repair messages to the model */
    const problem = byproduct.lineId === proposal.identityId ? `顺带产出的主线「${byproduct.lineId}」就是这项任务自己的主线；顺带产出必须服务另一条主线。`
      : !lines.has(byproduct.lineId) ? `顺带产出的主线「${byproduct.lineId.slice(0, 40)}」不存在。可选：${[...lines].join("、")}。`
      : seenLines.has(byproduct.lineId) ? `主线「${byproduct.lineId}」有两个顺带产出；每条其他主线最多一个。`
      : byproduct.milestoneId && !context.approvedMilestones.some((m) => m.id === byproduct.milestoneId && m.identityId === byproduct.lineId)
        ? `顺带产出指向的里程碑「${byproduct.milestoneId.slice(0, 60)}」不是「${byproduct.lineId}」的已批准里程碑；没有合适的就留空。`
      : !concreteArtifact(byproduct.artifact) ? `顺带产出「${byproduct.artifact.slice(0, 40)}」不是一个具体产物（要能交出来的东西，如一篇笔记、一条帖子草稿、一张图）。`
      : byproduct.landing.minutes <= 0 || byproduct.landing.minutes > 240 ? `顺带产出的落地用时 ${byproduct.landing.minutes} 分钟不合理（应在 1–240 分钟之间）。`
      : "";
    /* i18n-ignore-end */
    if (problem) {
      const error = new Error("ANALYSIS_BYPRODUCT_INVALID");
      (error as Error & { detail?: string }).detail = problem;
      throw error;
    }
    seenLines.add(byproduct.lineId);
  }
  if (!("completion" in legacyExtras)) proposal.completion = readModelCompletion(proposal.completion)!;
  // Only an id the context offered: anything else is new work, and the code-level duplicate check still runs on it.
  if (proposal.extendsTaskId && !(context.existingTasks ?? []).some((task) => task.id === proposal.extendsTaskId)) proposal.extendsTaskId = "";
  // What was never in the answer is not stored as if it had been; readers treat the absent fields as empty.
  if (injected) delete (proposal as Partial<AnalysisProposal>).estimateBreakdown;
  for (const key of Object.keys(legacyExtras)) delete (proposal as Partial<AnalysisProposal> & Record<string, unknown>)[key];
  return proposal;
}

/**
 * An artifact is something that can be handed over, not a state of mind. The same distinction milestone titles
 * are held to: 「保持」「推进」「做好准备」 describe effort, not a thing that exists afterwards.
 */
export function concreteArtifact(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  return !/^(保持|持续|稳定|推进|做好|准备好|提升|加强|关注)/.test(trimmed) && !/(状态|意识|习惯|感觉)$/.test(trimmed);
}

/** The analysis refusals that are about quality, each with the smallest fix that makes the answer usable (decided 2026-10-07). */
const ANALYSIS_SOFT_FIXES: Record<string, (proposal: AnalysisProposal) => void> = {
  ANALYSIS_ESTIMATE_MARGIN_INVALID: (proposal) => {
    const e = proposal.estimate;
    e.p85Minutes = Math.min(Math.max(e.p85Minutes, Math.ceil(e.p50Minutes * 1.2)), Math.max(e.p50Minutes * 3, e.p50Minutes + 30), 10080);
  },
  ANALYSIS_ESTIMATE_BREAKDOWN_MISMATCH: (proposal) => {
    const e = proposal.estimate;
    const total = Math.max(1, Math.round(proposal.estimateBreakdown.reduce((sum, item) => sum + item.minutes, 0)));
    const ratio = total / Math.max(1, e.p50Minutes);
    e.p50Minutes = total;
    e.p25Minutes = Math.max(1, Math.min(total, Math.round(e.p25Minutes * ratio)));
    e.p85Minutes = Math.min(Math.max(Math.round(e.p85Minutes * ratio), Math.ceil(total * 1.2)), Math.max(total * 3, total + 30), 10080);
  },
  ANALYSIS_CONTRACT_NOT_PROSE: (proposal) => {
    for (const item of [...proposal.materialContract, ...proposal.evidenceContract]) item.description = item.description.replace(/[{}[\]]/g, "").trim();
  },
  ANALYSIS_CONTRACT_TRUNCATED: (proposal) => {
    for (const item of [...proposal.materialContract, ...proposal.evidenceContract]) {
      if (item.description.length >= CONTRACT_LINE_LIMIT) item.description = `${item.description.slice(0, CONTRACT_LINE_LIMIT - 2)}…`;
    }
  },
  ANALYSIS_EVIDENCE_REQUIRED_MISSING: (proposal) => { if (proposal.evidenceContract[0]) proposal.evidenceContract[0].required = true; },
  ANALYSIS_BYPRODUCT_INVALID: (proposal) => { proposal.byproducts = []; }
};

/**
 * An analysis answer kept after its repairs ran out on a quality refusal: each soft refusal is fixed in the smallest way that makes
 * the answer usable (clamp the margin, take the steps' sum, strip brackets, mark the first evidence item required, drop byproducts)
 * and validated again, so everything the store relies on is still checked. Undefined when a hard refusal remains.
 */
export function keepAnalysisProposal(value: unknown, input: AnalysisContext, code: string, locale?: Locale): AnalysisProposal | undefined {
  if (!ANALYSIS_SOFT_FIXES[code]) return undefined;
  const candidate = structuredClone(value) as AnalysisProposal;
  let current = code;
  for (let round = 0; round < Object.keys(ANALYSIS_SOFT_FIXES).length + 1; round += 1) {
    const fix = ANALYSIS_SOFT_FIXES[current];
    if (!fix) return undefined;
    try { fix(candidate); } catch { return undefined; }
    try { return validateAnalysisProposal(candidate, input, locale); }
    catch (error) { current = error instanceof Error ? error.message : ""; }
  }
  return undefined;
}
