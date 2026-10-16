/**
 * Artifact-first joint planning across lines (docs/flywheel-and-views.md §5).
 *
 * The flywheel used to be drawn after the fact: each line's milestones were designed on their own, then a second small run looked for
 * links between this run's drafts, and redoing one line archived every link that touched an old draft. Nothing was designed to feed
 * anything, and the links that existed were claims nobody could check. Here the order is reversed:
 *
 * 1. one run (`crossline.artifact-plan.v1`) lists what each line will produce this period, what each line needs, and the few cross-line
 *    supply pairs — an artifact of one line that another line uses, with a measurable transfer, a lag and what the downstream line would
 *    lose without it;
 * 2. each line's milestones are designed with the pairs that concern it: the producing milestone declares the artifact in `outputs`, the
 *    using one names it in `inputs` and in its derivation;
 * 3. relations are not proposed at all: they follow from those references, and every relation carries the artifact, the expected
 *    transfer, the day it is checked (the downstream deadline) and the counterfactual.
 *
 * The rules below are the ones code can hold a model to; quality (a vague counterfactual) is a warning for the reviewer, never a stop.
 */
import { tFor, type Locale } from "./i18n";

export const ARTIFACT_PLAN_VERSION = "crossline.artifact-plan.v1" as const;
/** A line feeds at most this many cross-line edges: a task tied to many goals reads as less useful for each, and coordination costs. */
export const MAX_OUTGOING_PER_LINE = 2;
/** A byproduct is a small artifact landed within this many days of the task that made it (`#materializeByproducts`). */
export const BYPRODUCT_LAG_DAYS = 2;
const MAX_LAG_DAYS = 60;
const HORIZON_DAYS = 540;

export type Artifact = { id: string; line: string; kind: string; title: string; readyBy: string };
export type ArtifactNeed = { line: string; input: string; why: string };
export type ArtifactTransfer = { metric: string; expected: number; unit: string };
/**
 * One artifact handed from its line to another. `hoursSaved` is the counterfactual in hours — what the downstream line would spend
 * without it (0 when what it would lack is not time); `counterfactual` says it in words. `toMilestone` names the receiving line's existing
 * milestone that uses it, required when that line is not being redesigned in the same run (redoing one line: the receiving line keeps its
 * milestones, and an approved one cannot be edited to cite the artifact) — without it a one-line redo derived no relation at all and the
 * line's cross-line links vanished (replay on the real ledger, 2026-10-10). "" when the receiving line is designed in this run and will
 * cite it in `inputs`.
 */
export type SupplyPair = { from: string; toLine: string; toMilestone?: string; use: string; transfer: ArtifactTransfer; lagDays: number;
  counterfactual: string; hoursSaved: number };
export type ArtifactPlanAnswer = { artifacts: Artifact[]; needs: ArtifactNeed[]; supplies: SupplyPair[]; assumptions: string[];
  blockers: Array<{ code: string; message: string }> };
/** What is kept in the ledger (setting `ARTIFACT_PLAN_SETTING`) between runs. */
export type StoredArtifactPlan = { version: 1; updatedAt: string; artifacts: Artifact[]; needs: ArtifactNeed[]; supplies: SupplyPair[] };

export type ArtifactPlanContext = {
  version: typeof ARTIFACT_PLAN_VERSION;
  today: string;
  /** The lines this run plans: every line, or the one being redone. Only these lines' artifacts and pairs come back. */
  planLines: string[];
  lines: Array<{ id: string; label: string; goal: string;
    facts: Array<{ id: string; projectId: string; slot: string; value: string; status: "confirmed" | "inferred" }> }>;
  /** Every live milestone, other lines' approved ones included, with what each already produces and uses. */
  milestones: Array<{ id: string; line: string; projectId: string; title: string; status: string; deadline: string; outputs: string[]; inputs: string[] }>;
  /** The interview's own guesses about how the lines feed each other (profile slots starting `flywheel_`). */
  flywheelFacts: Array<{ id: string; line: string; slot: string; value: string; status: "confirmed" | "inferred" }>;
  /** The part of the plan that stays as it is: other lines' artifacts and pairs, and whatever an approved milestone already rests on. */
  kept: { artifacts: Artifact[]; supplies: SupplyPair[] };
  /** Artifact kinds whose promised transfers were mostly not delivered when checked; plan fewer of them, or smaller. */
  lowFulfilment: Array<{ kind: string; checked: number; rate: number }>;
  feedback?: string;
};

const str = (max = 400) => ({ type: "string", minLength: 1, maxLength: max }) as const;
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const list = (items: unknown, maxItems: number) => ({ type: "array", maxItems, items });

export const ARTIFACT_PLAN_SCHEMA = object({
  artifacts: list(object({ id: str(64), line: str(64), kind: str(40), title: str(120), readyBy: str(10) }), 24),
  needs: list(object({ line: str(64), input: str(160), why: str(300) }), 24),
  supplies: list(object({
    from: str(64), toLine: str(64), toMilestone: { type: "string", maxLength: 80 }, use: str(200),
    transfer: object({ metric: str(40), expected: { type: "number" }, unit: str(20) }),
    lagDays: { type: "integer", minimum: 0, maximum: MAX_LAG_DAYS },
    counterfactual: str(300), hoursSaved: { type: "number", minimum: 0 }
  }), 16),
  assumptions: list(str(400), 20),
  blockers: list(object({ code: str(80), message: str(400) }), 10)
});

export type ArtifactWarning = { code: string; detail: string };
/** A validated answer, with the pairs trimmed by the outgoing cap and the quality notes for the reviewer. */
export type CheckedArtifactPlan = ArtifactPlanAnswer & {
  /** Pairs dropped by `MAX_OUTGOING_PER_LINE` or as repeats, each with why. */
  dropped: string[];
  warnings: Array<{ from: string; toLine: string; warnings: ArtifactWarning[] }>;
};

function refuse(code: string, detail: string): never {
  const error = new Error(code);
  (error as Error & { detail?: string }).detail = detail.slice(0, 400);
  throw error;
}
const day = (value: string) => Date.parse(`${value}T00:00:00Z`);
/** A real calendar day written `YYYY-MM-DD`. */
export const validDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(day(value)) && new Date(day(value)).toISOString().slice(0, 10) === value;
const addDays = (value: string, days: number) => new Date(day(value) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Which pairs win a line's outgoing slots, made explicit: pairs already in the kept plan hold theirs first (an approved milestone rests on
 * them); the rest are ranked by the counterfactual hours they save, then by the expected transfer, then by artifact id. Hours come first
 * because they are comparable across pairs; "3 张图表" and "5 位访谈对象" are not.
 */
export function rankSupplies(a: SupplyPair, b: SupplyPair): number {
  return b.hoursSaved - a.hoursSaved || b.transfer.expected - a.transfer.expected || a.from.localeCompare(b.from) || a.toLine.localeCompare(b.toLine);
}

/** The cap applied to a list of pairs: `locked` ones always stay and count; the others fill what is left, best first. */
export function capOutgoing(pairs: SupplyPair[], lineOf: (artifactId: string) => string | undefined, locked: SupplyPair[] = []):
  { kept: SupplyPair[]; dropped: SupplyPair[] } {
  const used = new Map<string, number>();
  for (const pair of locked) { const line = lineOf(pair.from) ?? ""; used.set(line, (used.get(line) ?? 0) + 1); }
  const kept: SupplyPair[] = [];
  const dropped: SupplyPair[] = [];
  for (const pair of [...pairs].sort(rankSupplies)) {
    const line = lineOf(pair.from) ?? "";
    if ((used.get(line) ?? 0) >= MAX_OUTGOING_PER_LINE) { dropped.push(pair); continue; }
    used.set(line, (used.get(line) ?? 0) + 1);
    kept.push(pair);
  }
  return { kept, dropped };
}

/** What the reviewer is asked to look at in a pair; never a reason to refuse it. */
export function supplyWarnings(pair: { use: string; counterfactual: string; hoursSaved: number }): ArtifactWarning[] {
  const warnings: ArtifactWarning[] = [];
  const counterfactual = pair.counterfactual.trim();
  // A counterfactual names hours or a concrete thing that would be missing; 「会更难」 says neither.
  // The same in English: "missing", "without", "cannot", "no …" name what would be lacking.
  if (counterfactual.length < 12 || (!/\d/.test(counterfactual) && !/缺|没有|无法|拿不到|做不了|\b(missing|lack(s|ing)?|without|cannot|can't|could not|couldn't|no|none)\b/i.test(counterfactual))) {
    warnings.push({ code: "SUPPLY_COUNTERFACTUAL_VAGUE", detail: "反事实未写明没有上游时下游要多花多少小时或缺什么。" }); // i18n-ignore: read by the reviewer model
  }
  if (pair.use.trim().length < 8) warnings.push({ code: "SUPPLY_USE_THIN", detail: "未写清下游拿它做什么。" }); // i18n-ignore: read by the reviewer model
  return warnings;
}

/**
 * Checks an artifact plan against the context it was asked in. Throws a coded error whose detail names the artifact or pair at fault
 * (the runner sends it back for repair); pairs beyond a line's outgoing cap and exact repeats are dropped, not refused.
 */
/* i18n-ignore-start: repair messages sent back to the model, and what it dropped (for the reviewer and the logs) */
export function validateArtifactPlan(value: unknown, context: ArtifactPlanContext): CheckedArtifactPlan {
  const raw = value as ArtifactPlanAnswer | undefined;
  if (!raw || !Array.isArray(raw.artifacts) || !Array.isArray(raw.needs) || !Array.isArray(raw.supplies) || !Array.isArray(raw.assumptions)
    || !Array.isArray(raw.blockers)) throw new Error("ARTIFACT_PLAN_SCHEMA_INVALID");
  if (raw.blockers.length && !raw.artifacts.length) {
    refuse("ARTIFACT_PLAN_BLOCKED", raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；") || "没有给出任何产物。");
  }
  const planned = new Set(context.planLines);
  const knownLines = new Set(context.lines.map((line) => line.id));
  const keptIds = new Set(context.kept.artifacts.map((artifact) => artifact.id));
  const horizon = addDays(context.today, HORIZON_DAYS);
  const ids = new Set<string>();
  for (const artifact of raw.artifacts) {
    const label = `产物「${artifact.title}」（${artifact.id}）`;
    if (!planned.has(artifact.line)) {
      refuse("ARTIFACT_LINE_NOT_PLANNED", `${label} 属于「${artifact.line}」；这次只规划 ${context.planLines.join("、")}，其他主线的产物保持原样，不要重复列出。`);
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(artifact.id) || !artifact.id.startsWith(`${artifact.line}-`)) {
      refuse("ARTIFACT_ID_INVALID", `${label} 的 id 要以所属主线开头，如「${artifact.line}-figures」，只用小写字母、数字、- 和 _。`);
    }
    if (ids.has(artifact.id) || keptIds.has(artifact.id)) refuse("ARTIFACT_ID_DUPLICATE", `${label} 的 id 已经存在；保留下来的产物不要重新列出，新的产物换一个 id。`);
    if (artifact.title.trim().length < 4 || !artifact.kind.trim()) refuse("ARTIFACT_TITLE_THIN", `${label} 要写清是什么产物（种类与具体名称）。`);
    if (!validDay(artifact.readyBy) || artifact.readyBy < context.today || artifact.readyBy > horizon) {
      refuse("ARTIFACT_READY_BY_INVALID", `${label} 的 readyBy「${artifact.readyBy}」要是今天（${context.today}）之后 18 个月内的 YYYY-MM-DD。`);
    }
    ids.add(artifact.id);
  }
  const artifacts = new Map([...context.kept.artifacts, ...raw.artifacts].map((artifact) => [artifact.id, artifact]));
  for (const need of raw.needs) {
    if (!planned.has(need.line)) refuse("ARTIFACT_LINE_NOT_PLANNED", `需要「${need.input}」写在「${need.line}」下；这次只规划 ${context.planLines.join("、")}。`);
  }
  const seen = new Set<string>();
  const fresh: SupplyPair[] = [];
  const dropped: string[] = [];
  for (const pair of raw.supplies) {
    const artifact = artifacts.get(pair.from);
    const label = `供给「${pair.from} → ${pair.toLine}」`;
    if (!artifact) refuse("SUPPLY_ARTIFACT_UNKNOWN", `${label} 的 from 不是任何产物的 id；先在 artifacts 里列出它。`);
    if (!knownLines.has(pair.toLine)) refuse("SUPPLY_LINE_UNKNOWN", `${label} 的 toLine 不是这个人的主线；可选：${[...knownLines].join("、")}。`);
    if (pair.toLine === artifact.line) refuse("SUPPLY_SAME_LINE", `${label} 两端在同一条主线；同一主线内的先后用里程碑的 dependsOn 表达。`);
    if (!planned.has(artifact.line) && !planned.has(pair.toLine)) {
      refuse("SUPPLY_OUTSIDE_PLAN", `${label} 与这次规划的主线（${context.planLines.join("、")}）无关，保持原样，不要重复列出。`);
    }
    const target = (pair.toMilestone ?? "").trim();
    const choices = () => context.milestones.filter((milestone) => milestone.line === pair.toLine).map((milestone) => `${milestone.id}（${milestone.title}）`).join("、") || "（无）";
    if (target) {
      const milestone = context.milestones.find((item) => item.id === target);
      if (!milestone || milestone.line !== pair.toLine) refuse("SUPPLY_TARGET_UNKNOWN", `${label} 的 toMilestone「${target}」不是「${pair.toLine}」进行中的里程碑；可选：${choices()}。`);
    } else if (!planned.has(pair.toLine)) {
      refuse("SUPPLY_TARGET_MISSING", `${label}：「${pair.toLine}」这次不重新设计，toMilestone 要写明它的哪个进行中里程碑使用这份产物；可选：${choices()}。`);
    }
    pair.toMilestone = target;
    if (typeof pair.transfer?.expected !== "number" || !Number.isFinite(pair.transfer.expected) || pair.transfer.expected <= 0) {
      refuse("SUPPLY_TRANSFER_NOT_NUMERIC", `${label} 的 transfer.expected 要是大于 0 的数字（如复用 3 张图表就写 3），到核对日按它核对。`);
    }
    if (!pair.transfer.unit?.trim() || !pair.transfer.metric?.trim()) {
      refuse("SUPPLY_TRANSFER_UNIT_MISSING", `${label} 的传递量要有单位和计量对象（如 expected 3、unit「张」、metric「图表」）。`);
    }
    if (!Number.isInteger(pair.lagDays) || pair.lagDays < 0 || pair.lagDays > MAX_LAG_DAYS) refuse("SUPPLY_LAG_INVALID", `${label} 的 lagDays 要是 0–${MAX_LAG_DAYS} 的整数天。`);
    if (typeof pair.hoursSaved !== "number" || !Number.isFinite(pair.hoursSaved) || pair.hoursSaved < 0) refuse("SUPPLY_HOURS_INVALID", `${label} 的 hoursSaved 要是不小于 0 的数字。`);
    if (!pair.counterfactual?.trim()) refuse("SUPPLY_COUNTERFACTUAL_MISSING", `${label} 要写反事实：没有上游时下游要多花多少小时或缺什么。`);
    const key = `${pair.from}>${pair.toLine}`;
    if (seen.has(key) || context.kept.supplies.some((other) => `${other.from}>${other.toLine}` === key)) { dropped.push(`${label} 重复`); continue; }
    seen.add(key);
    fresh.push(pair);
  }
  const capped = capOutgoing(fresh, (id) => artifacts.get(id)?.line, context.kept.supplies);
  for (const pair of capped.dropped) dropped.push(`供给「${pair.from} → ${pair.toLine}」超出每条主线 ${MAX_OUTGOING_PER_LINE} 条出边的上限，按节省工时排在后面`);
  const warnings = capped.kept.flatMap((pair) => { const found = supplyWarnings(pair); return found.length ? [{ from: pair.from, toLine: pair.toLine, warnings: found }] : []; });
  return { artifacts: raw.artifacts, needs: raw.needs, supplies: capped.kept, assumptions: raw.assumptions, blockers: [], dropped, warnings };
}
/* i18n-ignore-end */

/** A stored plan, or an empty one when nothing (or something unreadable) is stored. */
export function readArtifactPlan(raw: string | null | undefined): StoredArtifactPlan {
  const empty: StoredArtifactPlan = { version: 1, updatedAt: "", artifacts: [], needs: [], supplies: [] };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredArtifactPlan>;
    return { version: 1, updatedAt: String(parsed.updatedAt ?? ""), artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      needs: Array.isArray(parsed.needs) ? parsed.needs : [], supplies: Array.isArray(parsed.supplies) ? parsed.supplies : [] };
  } catch { return empty; }
}

type MilestoneRefs = { id: string; line: string; status: string; outputs: string[]; inputs: string[] };

/**
 * What a run over `planLines` leaves alone: every other line's artifacts and needs, and in the planned lines whatever an approved
 * milestone already rests on — an artifact an approved milestone produces, and a pair whose artifact an approved milestone produces or
 * uses. A pair that points at an approved milestone is the person's decision, so redoing a line cannot drop it.
 */
export function keptArtifactPlan(plan: StoredArtifactPlan, milestones: MilestoneRefs[], planLines: string[]): StoredArtifactPlan {
  const planned = new Set(planLines);
  const approved = milestones.filter((milestone) => milestone.status === "approved");
  const approvedIds = new Set(approved.map((milestone) => milestone.id));
  const producedByApproved = new Set(approved.flatMap((milestone) => milestone.outputs));
  const usedByApproved = new Set(approved.flatMap((milestone) => milestone.inputs.map((input) => `${input}>${milestone.line}`)));
  const usedAnywhere = new Set(approved.flatMap((milestone) => milestone.inputs));
  const artifacts = plan.artifacts.filter((artifact) => !planned.has(artifact.line) || producedByApproved.has(artifact.id) || usedAnywhere.has(artifact.id));
  const keptIds = new Set(artifacts.map((artifact) => artifact.id));
  const lineOf = new Map(plan.artifacts.map((artifact) => [artifact.id, artifact.line]));
  const supplies = plan.supplies.filter((pair) => {
    const from = lineOf.get(pair.from);
    if (!from || !keptIds.has(pair.from)) return false;
    if (!planned.has(from) && !planned.has(pair.toLine)) return true;
    // It points at an approved milestone: one that produces its artifact, or one in the receiving line that uses it.
    return producedByApproved.has(pair.from) || usedByApproved.has(`${pair.from}>${pair.toLine}`) || approvedIds.has(pair.toMilestone ?? "");
  });
  return { version: 1, updatedAt: plan.updatedAt, artifacts, needs: plan.needs.filter((need) => !planned.has(need.line)), supplies };
}

/** The kept part plus a run's answer: the plan stored for the next run and for the board. */
export function mergeArtifactPlan(kept: StoredArtifactPlan, answer: Pick<ArtifactPlanAnswer, "artifacts" | "needs" | "supplies">, at: string): StoredArtifactPlan {
  return { version: 1, updatedAt: at, artifacts: [...kept.artifacts, ...answer.artifacts], needs: [...kept.needs, ...answer.needs],
    supplies: [...kept.supplies, ...answer.supplies] };
}

/** Two lines that supply each other form a loop; every edge of a loop is a feedback edge. */
export function isFeedbackPair(plan: Pick<StoredArtifactPlan, "artifacts" | "supplies">, fromLine: string, toLine: string): boolean {
  const lineOf = new Map(plan.artifacts.map((artifact) => [artifact.id, artifact.line]));
  return plan.supplies.some((pair) => lineOf.get(pair.from) === toLine && pair.toLine === fromLine);
}

/**
 * The time order of one edge: the upstream milestone is due no later than the downstream deadline less `lagDays`. A feedback edge (its
 * two lines supply each other) counts at least one day of lag, so the return leg of a loop always lands on a later milestone of the line
 * it returns to — the next period — and two milestones can never feed each other: loops exist between lines, never between milestones.
 * Returns what is wrong, or null; an edge with an undated end cannot be checked and passes.
 */
export function timeOrderProblem(upDeadline: string | undefined, downDeadline: string | undefined, lagDays: number, feedback = false, locale?: Locale): string | null {
  const t = tFor(locale);
  if (!upDeadline || !downDeadline || !validDay(upDeadline) || !validDay(downDeadline)) return null;
  const lag = Math.max(lagDays, feedback ? 1 : 0);
  const latest = addDays(downDeadline, -lag);
  return upDeadline <= latest ? null
    : t("上游 {{up}} 截止，晚于下游截止 {{down}} 减去 {{count}} 天传递时间（最晚 {{latest}}）", { up: upDeadline, down: downDeadline, count: lag, latest })
      + (feedback ? t("；两条主线互相供给，回流要落在下一期的里程碑上") : "");
}

export type RelationTransfer = ArtifactTransfer & { hoursSaved: number; lagDays: number;
  /** What was actually delivered, recorded by the check on `checkOn`; null until then. */ measured: number | null };
export type ArtifactMilestone = MilestoneRefs & { title: string; deadline?: string | undefined };
export type DerivedRelation = {
  id: string; fromMilestoneId: string; toMilestoneId: string; kind: "reuses" | "recurring_feedback";
  artifactId: string; transfer: RelationTransfer; checkOn: string | null; counterfactual: string; explanation: string; refutedWhen: string;
  use: string;
};

export const artifactRelationId = (artifactId: string, from: string, to: string) => `artifact:${artifactId}:${from}->${to}`;

/**
 * The relations an artifact plan and the milestones' references imply. For each supply pair, every live milestone of the receiving line
 * that names the artifact in `inputs` gets one relation, from the producing milestone (one of the artifact's line naming it in `outputs`)
 * that is due latest while still in time — the nearest one that can deliver. A consumer no producer can reach in time gets no relation
 * and is reported in `refused`. Then the outgoing cap: per upstream line at most `MAX_OUTGOING_PER_LINE`, relations in `locked` (already
 * approved) first, the rest by the pair ranking (`rankSupplies`), then the earlier check day.
 */
export function deriveArtifactRelations(milestones: ArtifactMilestone[], plan: Pick<StoredArtifactPlan, "artifacts" | "supplies">,
  options: { labels?: Record<string, string>; locked?: ReadonlySet<string>; locale?: Locale } = {}):
  { relations: DerivedRelation[]; refused: Array<{ artifactId: string; toMilestoneId: string; code: string; detail: string }> } {
  const t = tFor(options.locale);
  const artifacts = new Map(plan.artifacts.map((artifact) => [artifact.id, artifact]));
  const label = (line: string) => options.labels?.[line] ?? line;
  const candidates: Array<DerivedRelation & { rank: SupplyPair }> = [];
  const refused: Array<{ artifactId: string; toMilestoneId: string; code: string; detail: string }> = [];
  for (const pair of plan.supplies) {
    const artifact = artifacts.get(pair.from);
    if (!artifact || artifact.line === pair.toLine) continue;
    const feedback = isFeedbackPair(plan, artifact.line, pair.toLine);
    const producers = milestones.filter((milestone) => milestone.line === artifact.line && milestone.outputs.includes(artifact.id));
    const consumers = milestones.filter((milestone) => milestone.line === pair.toLine && (milestone.inputs.includes(artifact.id) || milestone.id === pair.toMilestone));
    for (const consumer of consumers) {
      const inTime = producers.filter((producer) => producer.line !== consumer.line && !timeOrderProblem(producer.deadline, consumer.deadline, pair.lagDays, feedback, options.locale))
        .sort((a, b) => (b.deadline ?? "").localeCompare(a.deadline ?? ""));
      const producer = inTime[0];
      if (!producer) {
        if (producers.length) refused.push({ artifactId: artifact.id, toMilestoneId: consumer.id, code: "RELATION_TIME_ORDER",
          detail: timeOrderProblem(producers[0]!.deadline, consumer.deadline, pair.lagDays, feedback, options.locale) ?? "" });
        continue;
      }
      const checkOn = consumer.deadline && validDay(consumer.deadline) ? consumer.deadline : null;
      candidates.push({
        id: artifactRelationId(artifact.id, producer.id, consumer.id), fromMilestoneId: producer.id, toMilestoneId: consumer.id,
        kind: feedback ? "recurring_feedback" : "reuses", artifactId: artifact.id,
        transfer: { ...pair.transfer, hoursSaved: pair.hoursSaved, lagDays: pair.lagDays, measured: null }, checkOn,
        counterfactual: pair.counterfactual, use: pair.use,
        explanation: t("{{fromLine}}的「{{artifact}}」供{{toLine}}「{{consumer}}」：{{use}}",
          { fromLine: label(artifact.line), artifact: artifact.title, toLine: label(pair.toLine), consumer: consumer.title, use: pair.use }),
        refutedWhen: t("到 {{day}}，{{toLine}}「{{consumer}}」没有用上「{{artifact}}」（预期 {{expected}} {{unit}}{{metric}}）", { day: checkOn ?? t("下游截止"),
          toLine: label(pair.toLine), consumer: consumer.title, artifact: artifact.title, expected: pair.transfer.expected,
          unit: pair.transfer.unit, metric: options.locale === "en" ? ` ${pair.transfer.metric}` : pair.transfer.metric }),
        rank: pair
      });
    }
  }
  const lineOf = new Map(milestones.map((milestone) => [milestone.id, milestone.line]));
  const locked = options.locked ?? new Set<string>();
  const used = new Map<string, number>();
  for (const relation of candidates.filter((item) => locked.has(item.id))) {
    const line = lineOf.get(relation.fromMilestoneId) ?? "";
    used.set(line, (used.get(line) ?? 0) + 1);
  }
  const relations: DerivedRelation[] = candidates.filter((item) => locked.has(item.id)).map(({ rank: _rank, ...relation }) => relation);
  const rest = candidates.filter((item) => !locked.has(item.id))
    .sort((a, b) => rankSupplies(a.rank, b.rank) || (a.checkOn ?? "9999").localeCompare(b.checkOn ?? "9999") || a.id.localeCompare(b.id));
  for (const { rank: _rank, ...relation } of rest) {
    const line = lineOf.get(relation.fromMilestoneId) ?? "";
    if ((used.get(line) ?? 0) >= MAX_OUTGOING_PER_LINE) {
      refused.push({ artifactId: relation.artifactId, toMilestoneId: relation.toMilestoneId, code: "RELATION_OUTGOING_CAP",
        detail: t("「{{line}}」已有 {{count}} 条出边", { line: label(line), count: MAX_OUTGOING_PER_LINE }) });
      continue;
    }
    used.set(line, (used.get(line) ?? 0) + 1);
    relations.push(relation);
  }
  return { relations, refused };
}

/**
 * What one line's architect run is told about the plan: the artifacts this line is to produce (and to whom each is promised, with the
 * milestones already waiting for it), and the artifacts other lines will supply to it (with the milestones already producing them).
 */
export type LineArtifacts = {
  produce: Array<{ id: string; kind: string; title: string; readyBy: string;
    /** Milestones of this line that already produce it and stay (approved); the answer need not produce it again. */
    producedBy: string[];
    suppliedTo: Array<{ line: string; lineLabel: string; use: string; transfer: ArtifactTransfer; lagDays: number; feedback: boolean;
      consumers: Array<{ milestoneId: string; title: string; deadline: string }> }> }>;
  consume: Array<{ id: string; kind: string; title: string; readyBy: string; fromLine: string; fromLineLabel: string; use: string;
    transfer: ArtifactTransfer; lagDays: number; feedback: boolean; counterfactual: string;
    producers: Array<{ milestoneId: string; title: string; deadline: string }> }>;
};

export function lineArtifacts(plan: Pick<StoredArtifactPlan, "artifacts" | "supplies">, line: string, milestones: ArtifactMilestone[],
  labels: Record<string, string> = {}): LineArtifacts {
  const artifacts = new Map(plan.artifacts.map((artifact) => [artifact.id, artifact]));
  const label = (id: string) => labels[id] ?? id;
  const ends = (pick: (milestone: ArtifactMilestone) => boolean) => milestones.filter(pick)
    .map((milestone) => ({ milestoneId: milestone.id, title: milestone.title, deadline: milestone.deadline ?? "" }));
  const produce = plan.artifacts.filter((artifact) => artifact.line === line).map((artifact) => ({
    id: artifact.id, kind: artifact.kind, title: artifact.title, readyBy: artifact.readyBy,
    producedBy: milestones.filter((milestone) => milestone.line === line && milestone.status === "approved" && milestone.outputs.includes(artifact.id)).map((milestone) => milestone.id),
    suppliedTo: plan.supplies.filter((pair) => pair.from === artifact.id).map((pair) => ({ line: pair.toLine, lineLabel: label(pair.toLine), use: pair.use,
      transfer: pair.transfer, lagDays: pair.lagDays, feedback: isFeedbackPair(plan, line, pair.toLine),
      consumers: ends((milestone) => milestone.line === pair.toLine && (milestone.inputs.includes(artifact.id) || milestone.id === pair.toMilestone)) }))
  }));
  const consume = plan.supplies.filter((pair) => pair.toLine === line && artifacts.get(pair.from) && artifacts.get(pair.from)!.line !== line).map((pair) => {
    const artifact = artifacts.get(pair.from)!;
    return { id: artifact.id, kind: artifact.kind, title: artifact.title, readyBy: artifact.readyBy, fromLine: artifact.line, fromLineLabel: label(artifact.line),
      use: pair.use, transfer: pair.transfer, lagDays: pair.lagDays, feedback: isFeedbackPair(plan, artifact.line, line), counterfactual: pair.counterfactual,
      producers: ends((milestone) => milestone.line === artifact.line && milestone.outputs.includes(artifact.id)) };
  });
  return { produce, consume };
}

type ProposedRefs = { identityId: string; title: string; plan?: { key?: string; deadline?: string; derivation?: string; outputs?: string[]; inputs?: string[] } };
const outputsOf = (item: ProposedRefs) => Array.isArray(item.plan?.outputs) ? item.plan!.outputs! : [];
const inputsOf = (item: ProposedRefs) => Array.isArray(item.plan?.inputs) ? item.plan!.inputs! : [];

/** Whether a derivation actually uses an input: it names the artifact by id or by title. */
const derivationUses = (derivation: string, input: { id: string; title: string }) => derivation.includes(input.id) || derivation.includes(input.title.trim());

/**
 * The artifact references in one line's answer, checked against what the line was told. Every reference must name an artifact it was
 * given; an input must be used in the derivation and be deliverable in time (by a producing milestone that already exists, else by the
 * artifact's `readyBy`); an output must reach every milestone already waiting for it in time; every artifact promised to another line
 * must be produced by some milestone. Throws the first problem, naming the milestone.
 */
/* i18n-ignore-start: repair messages sent back to the model */
export function validateArtifactReferences(milestones: ProposedRefs[], artifacts: LineArtifacts): void {
  const produce = new Map(artifacts.produce.map((item) => [item.id, item]));
  const consume = new Map(artifacts.consume.map((item) => [item.id, item]));
  for (const item of milestones) {
    const label = `「${item.title}」`;
    const deadline = item.plan?.deadline;
    for (const id of outputsOf(item)) {
      const artifact = produce.get(id);
      if (!artifact) refuse("MILESTONE_OUTPUT_UNKNOWN", `${label} 的 outputs 里「${id}」不是这条主线的产物；可选：${[...produce.keys()].join("、") || "（无）"}。`);
      // An approved milestone of this line already produces it in time for those waiting; another producer is extra, not late.
      if (artifact.producedBy.length) continue;
      for (const supply of artifact.suppliedTo) for (const consumer of supply.consumers) {
        const others = milestones.filter((other) => outputsOf(other).includes(id)).map((other) => other.plan?.deadline);
        if (others.every((upDeadline) => timeOrderProblem(upDeadline, consumer.deadline, supply.lagDays, supply.feedback))) {
          refuse("MILESTONE_OUTPUT_TOO_LATE", `${label} 产出「${artifact.title}」，但${supply.lineLabel}的「${consumer.title}」${consumer.deadline} 就要用：${timeOrderProblem(deadline, consumer.deadline, supply.lagDays, supply.feedback)}。把产出它的里程碑提前，或由更早的里程碑产出。`);
        }
      }
    }
    for (const id of inputsOf(item)) {
      const artifact = consume.get(id);
      if (!artifact) refuse("MILESTONE_INPUT_UNKNOWN", `${label} 的 inputs 里「${id}」不是其他主线供给这条主线的产物；可选：${[...consume.keys()].join("、") || "（无）"}。`);
      if (!derivationUses(item.plan?.derivation ?? "", artifact)) {
        refuse("MILESTONE_INPUT_NOT_DERIVED", `${label} 用到「${artifact.title}」（${id}），plan.derivation 要写出它怎样进入倒推：用它省下多少、少了它要多做什么。`);
      }
      const problem = artifact.producers.length
        ? artifact.producers.map((producer) => timeOrderProblem(producer.deadline, deadline, artifact.lagDays, artifact.feedback)).every(Boolean)
          ? timeOrderProblem(artifact.producers.map((producer) => producer.deadline).sort()[0], deadline, artifact.lagDays, artifact.feedback) : null
        : timeOrderProblem(artifact.readyBy, deadline, artifact.lagDays, artifact.feedback);
      if (problem) refuse("MILESTONE_INPUT_TOO_EARLY", `${label} 要用${artifact.fromLineLabel}的「${artifact.title}」，但时间来不及：${problem}。把这个里程碑放到产物到手之后，或不使用它。`);
    }
  }
  for (const artifact of artifacts.produce) {
    if (!artifact.suppliedTo.length || artifact.producedBy.length) continue;
    if (!milestones.some((item) => outputsOf(item).includes(artifact.id))) {
      refuse("MILESTONE_ARTIFACT_UNPRODUCED", `产物「${artifact.title}」（${artifact.id}）已承诺给${artifact.suppliedTo.map((supply) => supply.lineLabel).join("、")}，但没有里程碑在 outputs 里产出它；由按时间最合适的里程碑声明它。`);
    }
  }
}
/* i18n-ignore-end */

/** The artifact problems a kept answer may still carry: soft, because the relations are derived only from references that pass. */
export const ARTIFACT_SOFT_CODES = new Set(["MILESTONE_OUTPUT_UNKNOWN", "MILESTONE_INPUT_UNKNOWN", "MILESTONE_INPUT_NOT_DERIVED",
  "MILESTONE_INPUT_TOO_EARLY", "MILESTONE_OUTPUT_TOO_LATE", "MILESTONE_ARTIFACT_UNPRODUCED"]);

/**
 * A kept answer with every reference that would not pass removed — an unknown id, an input not in the derivation or not deliverable in
 * time, an output too late for a milestone already waiting for it — so what is stored can only ever derive valid relations.
 */
export function sanitizeArtifactReferences<T extends ProposedRefs>(milestones: T[], artifacts: LineArtifacts): T[] {
  const produce = new Map(artifacts.produce.map((item) => [item.id, item]));
  const consume = new Map(artifacts.consume.map((item) => [item.id, item]));
  return milestones.map((item) => {
    if (!item.plan) return item;
    const deadline = item.plan.deadline;
    const outputs = outputsOf(item).filter((id) => {
      const artifact = produce.get(id);
      return Boolean(artifact) && artifact!.suppliedTo.every((supply) => supply.consumers.every((consumer) =>
        !timeOrderProblem(deadline, consumer.deadline, supply.lagDays, supply.feedback)));
    });
    const inputs = inputsOf(item).filter((id) => {
      const artifact = consume.get(id);
      if (!artifact || !derivationUses(item.plan?.derivation ?? "", artifact)) return false;
      return artifact.producers.length
        ? artifact.producers.some((producer) => !timeOrderProblem(producer.deadline, deadline, artifact.lagDays, artifact.feedback))
        : !timeOrderProblem(artifact.readyBy, deadline, artifact.lagDays, artifact.feedback);
    });
    return { ...item, plan: { ...item.plan, outputs, inputs } };
  });
}

/** The person's answer to a relation's check on its check day. */
export type RelationCheckOutcome = "fulfilled" | "partial" | "none";
export const RELATION_CHECK_SCORE: Record<RelationCheckOutcome, number> = { fulfilled: 1, partial: 0.5, none: 0 };

/**
 * 跨线关系兑现率: of the cross-line relations checked, how much was delivered — a full delivery counts 1, a partial one half, none 0 —
 * overall and per artifact kind. `low` lists the kinds (with at least two checks) delivered under half the time, which the next artifact
 * plan is told about.
 */
export function relationFulfilment(checks: Array<{ outcome: RelationCheckOutcome; kind: string }>): {
  checked: number; rate: number | null; byKind: Array<{ kind: string; checked: number; rate: number }>; low: Array<{ kind: string; checked: number; rate: number }> } {
  const round = (value: number) => Math.round(value * 100) / 100;
  const byKind = new Map<string, { checked: number; score: number }>();
  for (const check of checks) {
    const entry = byKind.get(check.kind) ?? { checked: 0, score: 0 };
    entry.checked += 1; entry.score += RELATION_CHECK_SCORE[check.outcome];
    byKind.set(check.kind, entry);
  }
  const kinds = [...byKind].map(([kind, entry]) => ({ kind, checked: entry.checked, rate: round(entry.score / entry.checked) }));
  const total = checks.reduce((sum, check) => sum + RELATION_CHECK_SCORE[check.outcome], 0);
  return { checked: checks.length, rate: checks.length ? round(total / checks.length) : null, byKind: kinds,
    low: kinds.filter((kind) => kind.checked >= 2 && kind.rate < 0.5) };
}

/** The artifact a byproduct is: made by its main task, landed by the other line's small task within `BYPRODUCT_LAG_DAYS`. */
export const byproductArtifactId = (orderId: string, lineId: string) => `byproduct:${orderId}:${lineId}`;

/** Every artifact a task produces: its own (`payload.produces`) and one per byproduct it carries. */
export function producedArtifacts(order: { id: string; payload: unknown }): string[] {
  const payload = (order.payload ?? {}) as { produces?: unknown; byproducts?: Array<{ lineId?: unknown }> };
  return [...(typeof payload.produces === "string" && payload.produces ? [payload.produces] : []),
    ...(Array.isArray(payload.byproducts) ? payload.byproducts.flatMap((item) => typeof item?.lineId === "string" ? [byproductArtifactId(order.id, item.lineId)] : []) : [])];
}
/** The artifacts a task uses: another line's output it waits for and is handed on delivery. */
export function usedArtifacts(order: { payload: unknown }): string[] {
  const uses = ((order.payload ?? {}) as { uses?: unknown }).uses;
  return Array.isArray(uses) ? uses.filter((id): id is string => typeof id === "string" && Boolean(id)) : [];
}
