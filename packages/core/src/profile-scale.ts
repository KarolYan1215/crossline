/**
 * The scale page before the interview (docs/plans/2026-11-22-interview-and-import-redesign.md §二.2): IPIP-NEO-120 and TwIVI on pages
 * of their own, paused and taken up again at will, a free box at the end that adds to the taps (never stands in for them), and the
 * results of tests the person took elsewhere (a 16-type test, say), kept as they said them — the system makes no type label of its own
 * (D12). The answers are `PROFILE_INSTRUMENTS_SETTING`; the rest of the page's state is `PROFILE_SCALE_SETTING`.
 *
 * Once the scale is done the extraction's Skill reads the scores, the box and the materials and writes an analysis for the person, with
 * hypotheses for the interview to test (`PROFILE_SCALE_ANALYSIS_SETTING`, apps/worker/src/scale-analysis.ts). The dialogue reads it with
 * `read_ledger` (section `scale`).
 */
import {
  facetScores, instrumentScores, NORM_NOTE, PROFILE_ITEMS, type FacetScore, type DimensionScore, type InstrumentAnswers, type ScaleItem
} from "./profile-instruments";

export const PROFILE_SCALE_SETTING = "profile.scale";
export const PROFILE_SCALE_ANALYSIS_SETTING = "profile.scale.analysis";

/** Items per page: six pages of the IPIP-NEO, one of TwIVI. */
export const SCALE_PAGE_SIZE = 20;
export const SCALE_PAGES: readonly (readonly ScaleItem[])[] = Array.from({ length: Math.ceil(PROFILE_ITEMS.length / SCALE_PAGE_SIZE) },
  (_, index) => PROFILE_ITEMS.slice(index * SCALE_PAGE_SIZE, (index + 1) * SCALE_PAGE_SIZE));

/** The longest free box and self-reported result kept. */
export const SCALE_SUPPLEMENT_MAX = 4000;
export const SELF_REPORTS_MAX = 8;

export type SelfReport = { test: string; result: string; note?: string };
export type ScaleSession = {
  /** The page the person was on: where the scale opens again. */
  page: number;
  /** The free box at the end: anything the person wants to add to the taps. */
  supplement: string;
  /** Results of tests taken elsewhere, as the person stated them. */
  selfReports: SelfReport[];
  startedAt?: string;
  /** Set when the person pressed 「做完了」. */
  completedAt?: string;
  /** Set when the person chose to begin the interview first; the scale waits in the right column. */
  deferredAt?: string;
};

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export function readScaleSession(raw: string | null | undefined): ScaleSession {
  let value: Record<string, unknown> = {};
  try { const parsed = JSON.parse(raw ?? "{}") as unknown; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>; } catch { /* none */ }
  const page = Number(value.page);
  const reports = Array.isArray(value.selfReports) ? value.selfReports : [];
  return {
    page: Number.isInteger(page) && page >= 0 && page < SCALE_PAGES.length ? page : 0,
    supplement: text(value.supplement, SCALE_SUPPLEMENT_MAX),
    selfReports: normalizeSelfReports(reports),
    ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
    ...(typeof value.deferredAt === "string" ? { deferredAt: value.deferredAt } : {})
  };
}

/** Self-reported results as kept: a test and a result each, at most `SELF_REPORTS_MAX`. */
export function normalizeSelfReports(raw: unknown): SelfReport[] {
  return (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const test = text(item.test, 80), result = text(item.result, 200), note = text(item.note, 400);
    return test && result ? [{ test, result, ...(note ? { note } : {}) }] : [];
  }).slice(0, SELF_REPORTS_MAX);
}

/** Where the scale stands: not begun, under way (or paused), done; `deferred` when the person put it off to start the interview. */
export function scaleStatus(session: ScaleSession, answers: InstrumentAnswers): { state: "todo" | "in_progress" | "done"; answered: number; total: number; deferred: boolean } {
  const answered = PROFILE_ITEMS.filter((item) => answers[item.id]).length;
  return { state: session.completedAt ? "done" : answered || session.startedAt ? "in_progress" : "todo", answered, total: PROFILE_ITEMS.length,
    deferred: Boolean(session.deferredAt && !session.completedAt) };
}

/** Whether the scale page comes before the first round: not done, and not put off by the person. */
export const scaleBeforeInterview = (session: ScaleSession): boolean => !session.completedAt && !session.deferredAt;

/** The scores in one place, for the page, the analysis and the right column. */
export type ScaleReport = {
  domains: DimensionScore[];
  facets: FacetScore[];
  /** The ten values, highest first; unscored ones last. */
  values: DimensionScore[];
  answered: number;
  total: number;
  norms: string;
};
export function scaleReport(answers: InstrumentAnswers): ScaleReport {
  const values = instrumentScores(answers, "twivi");
  return {
    domains: instrumentScores(answers, "ipip_neo_120"), facets: facetScores(answers),
    values: [...values].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)),
    answered: PROFILE_ITEMS.filter((item) => answers[item.id]).length, total: PROFILE_ITEMS.length, norms: NORM_NOTE
  };
}

/**
 * What the analysis run reads of the scale: the numbers with what they are measured against, the free box and the self-reported
 * results. Items are not sent one by one; a facet's sum and percentile say what its four items said.
 */
export function scaleAnalysisInput(answers: InstrumentAnswers, session: ScaleSession) {
  const report = scaleReport(answers);
  return {
    answered: report.answered, total: report.total, norms: report.norms,
    domains: report.domains.map((score) => ({ domain: score.dimension, label: score.label, percentile: score.percentile ?? null, meanFacetSum: score.raw ?? null,
      skipped: score.skipped })),
    facets: report.facets.map((facet) => ({ facet: facet.facet, label: facet.label, sum: facet.sum, percentile: facet.percentile })),
    values: report.values.map((score) => ({ value: score.label, mean: score.raw ?? null, centered: score.centered ?? null, rank: score.rank ?? null })),
    supplement: session.supplement,
    selfReports: session.selfReports
  };
}

/** One hypothesis the analysis puts to the interview: what the scale suggests, and what in the person's life would show it or not. */
export type ScaleHypothesis = { id: string; statement: string; check: string };
export type ScaleAnalysis = {
  at: string;
  /** The `completedAt` of the scale it read: a scale done again is analysed again. */
  basedOn: string;
  /** For the person: plain paragraphs, no confidence figures. */
  text: string;
  hypotheses: ScaleHypothesis[];
};
export function readScaleAnalysis(raw: string | null | undefined): ScaleAnalysis | undefined {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<ScaleAnalysis> | null;
    if (!value || typeof value.text !== "string" || typeof value.basedOn !== "string") return undefined;
    return { at: String(value.at ?? ""), basedOn: value.basedOn, text: value.text,
      hypotheses: (Array.isArray(value.hypotheses) ? value.hypotheses : []).filter((item): item is ScaleHypothesis =>
        Boolean(item) && typeof item.statement === "string" && typeof item.check === "string").map((item, index) => ({ id: item.id || `s${index + 1}`, statement: item.statement, check: item.check })) };
  } catch { return undefined; }
}
/** Whether the analysis is owed: the scale is done and nothing was written for this completion yet. */
export const scaleAnalysisDue = (session: ScaleSession, analysis: ScaleAnalysis | undefined): boolean =>
  Boolean(session.completedAt) && analysis?.basedOn !== session.completedAt;

const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
/** The analysis run's answer: the text for the person and the hypotheses for the interview. */
export const SCALE_ANALYSIS_SCHEMA = object({
  text: { type: "string", minLength: 40, maxLength: 6000 },
  hypotheses: { type: "array", maxItems: 8, items: object({ statement: { type: "string", minLength: 4, maxLength: 400 }, check: { type: "string", minLength: 4, maxLength: 400 } }) }
});

/** The lines the dialogue reads with `read_ledger` (section `scale`). */
export function scaleLedgerLines(answers: InstrumentAnswers, session: ScaleSession, analysis: ScaleAnalysis | undefined): string[] {
  const report = scaleReport(answers);
  const status = scaleStatus(session, answers);
  /* i18n-ignore-start: lines for the model */
  const lines = [`量表：${status.state === "done" ? "已做完" : status.deferred ? "本人选择先访谈，量表暂停" : status.state === "in_progress" ? "做了一部分" : "还没做"}（${status.answered}/${status.total} 题）`];
  for (const domain of report.domains) if (domain.percentile !== undefined) lines.push(`${domain.label}：第 ${domain.percentile} 百分位`);
  for (const facet of report.facets) if (facet.percentile !== null) lines.push(`  ${facet.facet} ${facet.label}：第 ${facet.percentile} 百分位`);
  const ranked = report.values.filter((value) => value.rank);
  if (ranked.length) lines.push(`价值观排序（高到低，中心化后）：${ranked.map((value) => `${value.label}${value.centered !== undefined ? `(${value.centered > 0 ? "+" : ""}${value.centered})` : ""}`).join("、")}`);
  if (session.supplement) lines.push(`本人补充：${session.supplement}`);
  for (const report of session.selfReports) lines.push(`本人自述的其他测试结果：${report.test} = ${report.result}${report.note ? `（${report.note}）` : ""}`);
  if (analysis) { lines.push(`量表分析：${analysis.text}`); for (const item of analysis.hypotheses) lines.push(`待访谈验证 ${item.id}：${item.statement}；看什么：${item.check}`); }
  lines.push(`常模说明：${NORM_NOTE}`);
  /* i18n-ignore-end */
  return lines;
}
