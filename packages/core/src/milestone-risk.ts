/**
 * What could keep a milestone from being reached, said once when it is drafted (the person's direction of 2026-10-15: 「里程碑创建时，Agent
 * 就要阅读这些里程碑，批判性地分析风险」). A risk is a level, a kind and one short note; a milestone may have none. The 主线 page draws the
 * level as a glyph and the kind as a short tag, tells the person the risks when they approve one milestone and all of them together when
 * they approve the whole batch. A medium or high risk from the model's review of an approved milestone is then put to the person (the
 * `milestone_risk_review` ask, 2026-10-15); only once they accept that current review (`schedule.riskDecisions`) does the scheduler aim
 * the milestone's work to finish a day or two early (`riskBufferDays`) — never silently. The risk never blocks anything.
 *
 * Two sources, one shape. The model's review (Skill `crossline-milestone-risk-reviewer`, run by the worker after drafts are saved) is
 * stored per milestone under `MILESTONE_RISKS_SETTING`, keyed by a fingerprint of what it read, so an edited milestone's old review is not
 * shown as current. Until there is one, the page shows `ruleMilestoneRisks`: deterministic checks on dates, dependencies, criteria and
 * the forecast, labelled as an estimate. The same rules are handed to the model as `ruleFindings`, to confirm, correct or extend.
 */

export const MILESTONE_RISK_LEVELS = ["low", "medium", "high"] as const;
export const MILESTONE_RISK_KINDS = ["time", "capacity", "dependency", "unrealistic", "unclear"] as const;
export type MilestoneRiskLevel = typeof MILESTONE_RISK_LEVELS[number];
export type MilestoneRiskKind = typeof MILESTONE_RISK_KINDS[number];
export type MilestoneRisk = { level: MilestoneRiskLevel; kind: MilestoneRiskKind; note: string };

/** Short tags, as the page shows them. */
export const MILESTONE_RISK_KIND_LABEL: Record<MilestoneRiskKind, string> = {
  time: "时间紧", capacity: "工时不足", dependency: "前置未就绪", unrealistic: "目标偏高", unclear: "标准不清"
};
export const MILESTONE_RISK_LEVEL_LABEL: Record<MilestoneRiskLevel, string> = { low: "低", medium: "中", high: "高" };
const RANK: Record<MilestoneRiskLevel, number> = { low: 1, medium: 2, high: 3 };

/** `Record<milestoneId, StoredMilestoneRisk>`; written by the worker, read by the 主线 page and the scheduler. */
export const MILESTONE_RISKS_SETTING = "milestones.risks";
/** A review is not retried for a day after a failed run, so a broken run does not repeat every tick. */
export const MILESTONE_RISK_RETRY_MS = 24 * 3_600_000;
export const MILESTONE_RISK_NOTE_MAX = 60;
export const MILESTONE_RISK_MAX = 4;

export type StoredMilestoneRisk =
  | { fingerprint: string; at: string; source: "model"; risks: MilestoneRisk[] }
  | { fingerprint: string; at: string; failed: string };

export function parseMilestoneRisks(raw: string | null | undefined): Record<string, StoredMilestoneRisk> {
  try {
    const value = JSON.parse(raw ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, StoredMilestoneRisk> : {};
  } catch { return {}; }
}

/** The stored model review for this version of the milestone, or undefined (none yet, a failed run, or one made before an edit). */
export function currentRiskReview(stored: StoredMilestoneRisk | undefined, fingerprint: string): MilestoneRisk[] | undefined {
  return stored && "risks" in stored && stored.fingerprint === fingerprint ? stored.risks : undefined;
}

/** What a review read, so an edit to any of it makes the old review stale. Plain FNV-1a: this module also runs in the browser. */
export function milestoneRiskFingerprint(input: { title: string; deadline?: string | null | undefined; criteria: string[]; dependsOn: string[] }): string {
  const text = JSON.stringify([input.title.trim(), input.deadline ?? "", input.criteria, [...input.dependsOn].sort()]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0");
}

/** The criteria as a fingerprint reads them: the statement and what it measures, so changing a score line makes a review stale. */
export const riskCriteriaKeys = (criteria: Array<{ statement: string; measure: unknown }>) =>
  criteria.map((criterion) => `${criterion.statement}|${JSON.stringify(criterion.measure)}`);

/** One risk per kind (the higher level wins), highest first. */
export function mergeRisks(risks: MilestoneRisk[]): MilestoneRisk[] {
  const byKind = new Map<MilestoneRiskKind, MilestoneRisk>();
  for (const risk of risks) {
    const seen = byKind.get(risk.kind);
    if (!seen || RANK[risk.level] > RANK[seen.level]) byKind.set(risk.kind, risk);
  }
  return [...byKind.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || MILESTONE_RISK_KINDS.indexOf(a.kind) - MILESTONE_RISK_KINDS.indexOf(b.kind))
    .slice(0, MILESTONE_RISK_MAX);
}

export function riskLevelOf(risks: MilestoneRisk[]): MilestoneRiskLevel | null {
  return risks.reduce<MilestoneRiskLevel | null>((top, risk) => !top || RANK[risk.level] > RANK[top] ? risk.level : top, null);
}

/**
 * Days the scheduler aims a risky milestone's work to finish early: two for a high risk, one for a medium one. An unclear standard is
 * not a reason to finish early. The planner drops the buffer in its relaxed run, so it never makes a deadline impossible.
 */
export function riskBufferDays(risks: MilestoneRisk[]): number {
  const level = riskLevelOf(risks.filter((risk) => risk.kind !== "unclear"));
  return level === "high" ? 2 : level === "medium" ? 1 : 0;
}

// ── Rules ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type RiskCriterionInput = { statement: string;
  measure: { kind: string; value?: number; bareLine?: number; comparator?: string; unit?: string; failsWhen?: string } };
export type RuleRiskInput = {
  today: string;
  deadline: string | null;
  criteria: RiskCriterionInput[];
  /** The same-line milestones this one waits on. */
  dependsOn: Array<{ title: string; deadline: string | null }>;
  /** Every other live milestone's deadline, any line: several due in the same few days compete for the same hours. */
  otherDeadlines: string[];
  /** The scheduler's forecast for an approved milestone with work: whole days between the cautious finish and the deadline. */
  slackDays?: number | null;
};

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
/** The margin rule the architect is held to (`MARGIN_RATIO`). */
const MARGIN = 0.03;

/**
 * The deterministic part of a review: what the dates, the dependencies, the criteria and the forecast already show. It cannot judge
 * whether a result is realistic for this person — only that a score line leaves no margin — which is what the model review adds.
 */
export function ruleMilestoneRisks(input: RuleRiskInput): MilestoneRisk[] {
  const risks: MilestoneRisk[] = [];
  const left = input.deadline ? days(input.today, input.deadline) : null;
  if (left === null) risks.push({ level: "medium", kind: "unclear", note: "未定截止日，无法排程与判断是否来得及" });
  else if (left < 0) risks.push({ level: "high", kind: "time", note: `截止日已过 ${-left} 天` });
  else if (left <= 3) risks.push({ level: "high", kind: "time", note: `距截止仅 ${left} 天` });
  else if (left <= 10) risks.push({ level: "medium", kind: "time", note: `距截止 ${left} 天` });

  if (!input.criteria.length) risks.push({ level: "medium", kind: "unclear", note: "没有验收标准，达成与否无从判断" });
  else if (input.criteria.every((criterion) => criterion.measure.kind === "judgement" && !(criterion.measure.failsWhen ?? "").trim()))
    risks.push({ level: "low", kind: "unclear", note: "标准只有主观判断，没有未达成的条件" });
  for (const criterion of input.criteria) {
    const { value, bareLine, comparator } = criterion.measure;
    if (criterion.measure.kind !== "threshold" || typeof value !== "number" || typeof bareLine !== "number" || !bareLine) continue;
    const margin = comparator === "lte" ? (bareLine - value) / Math.abs(bareLine) : (value - bareLine) / Math.abs(bareLine);
    if (margin < MARGIN) risks.push({ level: "medium", kind: "unrealistic", note: `分数线 ${value} 与最低够线 ${bareLine} 的余量不足 3%` });
  }

  for (const parent of input.dependsOn) {
    if (!input.deadline || !parent.deadline) continue;
    const gap = days(parent.deadline, input.deadline);
    if (gap <= 0) risks.push({ level: "high", kind: "dependency", note: `前置「${short(parent.title)}」不早于本里程碑` });
    else if (gap < 3) risks.push({ level: "medium", kind: "dependency", note: `前置「${short(parent.title)}」仅早 ${gap} 天` });
  }

  if (input.slackDays !== undefined && input.slackDays !== null) {
    if (input.slackDays < 0) risks.push({ level: "high", kind: "capacity", note: `按现有排程预计晚 ${-input.slackDays} 天` });
    else if (input.slackDays < 2) risks.push({ level: "medium", kind: "capacity", note: `按现有排程只余 ${input.slackDays} 天` });
  }
  if (input.deadline && left !== null && left >= 0) {
    // A cluster counts only when it is dense for this person's board: several lines often end a term in the same fortnight.
    const near = input.otherDeadlines.filter((day) => Math.abs(days(day, input.deadline!)) <= 2).length;
    if (near >= 4) risks.push({ level: "medium", kind: "capacity", note: `前后 2 天内另有 ${near} 个里程碑截止` });
    else if (near === 3) risks.push({ level: "low", kind: "capacity", note: "前后 2 天内另有 3 个里程碑截止" });
  }
  return mergeRisks(risks);
}

const short = (title: string) => title.length > 14 ? `${title.slice(0, 13)}…` : title;

// ── The model's review ──────────────────────────────────────────────────────────────────────────────────────────────

export type MilestoneRiskContext = {
  version: "crossline.milestone-risk.v1";
  today: string;
  /** The hours a week the person has for all lines, when known. */
  weeklyHours: number | null;
  /** The milestones to review: new drafts, and approved ones never reviewed. */
  milestones: Array<{ id: string; status: string; line: string; lineLabel: string; project: string; title: string; deadline: string | null; daysLeft: number | null;
    criteria: string[]; rationale: string; dependsOn: Array<{ title: string; deadline: string | null }>; ruleFindings: MilestoneRisk[] }>;
  /** Every other live milestone, so a review sees what competes for the same weeks. */
  others: Array<{ line: string; title: string; deadline: string | null; status: string }>;
};
export type MilestoneRiskAnswer = { milestones: Array<{ milestoneId: string; risks: MilestoneRisk[] }> };

const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const MILESTONE_RISK_SCHEMA = object({
  milestones: { type: "array", maxItems: 24, items: object({
    milestoneId: { type: "string", minLength: 1, maxLength: 200 },
    risks: { type: "array", maxItems: MILESTONE_RISK_MAX, items: object({
      level: { type: "string", enum: [...MILESTONE_RISK_LEVELS] },
      kind: { type: "string", enum: [...MILESTONE_RISK_KINDS] },
      note: { type: "string", minLength: 2, maxLength: MILESTONE_RISK_NOTE_MAX }
    }) }
  }) }
});

function reject(code: string, detail: string): never {
  const error = new Error(code);
  (error as Error & { detail?: string }).detail = detail.slice(0, 400);
  throw error;
}

const cleanNote = (note: string) => note.replace(/[​-‏⁠﻿]/g, "").replace(/\s+/g, " ").trim().slice(0, MILESTONE_RISK_NOTE_MAX);

/** The usable part of an answer: given milestones only, known levels and kinds, one risk per kind. */
function readAnswer(value: unknown, context: MilestoneRiskContext): Map<string, MilestoneRisk[]> {
  const answer = value as MilestoneRiskAnswer | undefined;
  const known = new Set(context.milestones.map((item) => item.id));
  const kept = new Map<string, MilestoneRisk[]>();
  for (const item of Array.isArray(answer?.milestones) ? answer!.milestones : []) {
    if (!item || !known.has(item.milestoneId) || kept.has(item.milestoneId) || !Array.isArray(item.risks)) continue;
    kept.set(item.milestoneId, mergeRisks(item.risks.filter((risk) => risk && MILESTONE_RISK_LEVELS.includes(risk.level) && MILESTONE_RISK_KINDS.includes(risk.kind))
      .map((risk) => ({ level: risk.level, kind: risk.kind, note: cleanNote(String(risk.note ?? "")) })).filter((risk) => risk.note.length >= 2)));
  }
  return kept;
}

/** Every milestone given comes back once; a missing one is sent back by name. An empty `risks` is a real answer: no risk. */
export function validateMilestoneRisks(value: unknown, context: MilestoneRiskContext): Map<string, MilestoneRisk[]> {
  if (!value || typeof value !== "object" || !Array.isArray((value as MilestoneRiskAnswer).milestones)) reject("MILESTONE_RISK_SCHEMA_INVALID", "输出结构不符合要求。");
  const kept = readAnswer(value, context);
  const missing = context.milestones.filter((item) => !kept.has(item.id));
  if (missing.length) reject("MILESTONE_RISK_MISSING", `缺少这些里程碑的审查：${missing.map((item) => `${item.id}「${item.title}」`).join("、")}；每个里程碑返回一项，没有风险时 risks 为空数组。`);
  return kept;
}

/** Repairs spent: keep what was answered; the rest is retried after `MILESTONE_RISK_RETRY_MS`. */
export function keepMilestoneRisks(value: unknown, context: MilestoneRiskContext): MilestoneRiskAnswer | undefined {
  const kept = readAnswer(value, context);
  return kept.size ? { milestones: [...kept].map(([milestoneId, risks]) => ({ milestoneId, risks })) } : undefined;
}
