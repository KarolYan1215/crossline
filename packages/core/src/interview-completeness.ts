/**
 * How complete the interview is, for the 「结束并出报告」 button (the owner's decision of 2026-11-12). The lower bound is the start standard:
 * below it the button is off. Above it the person may end whenever they like; `score` fills the button, and `full` — a standard well above
 * the lower bound — is when the page reminds them once that they can end. Nothing here ends the interview.
 */
export type InterviewCompleteness = { lowerBound: boolean; score: number; full: boolean; missing: string[] };

import { tFor, type Locale } from "./i18n";

const DIMENSIONS = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"] as const;
/** The parts of the main interview (flow v2) that the portrait needs walked; the per-project details part is not one of them. */
export const COMPLETENESS_PARTS = ["narrative", "compass", "energy", "situation", "orientation", "lines"] as const;
const PART_NAME: Record<(typeof COMPLETENESS_PARTS)[number], string> = {
  narrative: "经历与转折", compass: "指南针", energy: "能量", situation: "处境", orientation: "主线", lines: "主线细节"
};
/** At least this many hypotheses before the portrait's inferences count as tested. */
export const HYPOTHESES_WANTED = 5;

export type CompletenessInput = {
  /** The start standard stands (`readyToStart`). */
  lowerBound: boolean;
  /** What the start standard still lacks, in the person's words (the checklist's labels), when it does not stand. */
  lowerMissing?: string[];
  /** The stages the dialogue's rounds were in, in order. */
  stagesSeen: string[];
  /** The working portrait's dimension notes, hypotheses and career options (ProfileModel; any may be missing on an older portrait). */
  dimensions?: Array<{ id: string; evidenced: boolean }>;
  hypotheses?: Array<{ status: string }>;
  careers?: Array<{ trial?: { task?: string } | null }>;
  /** The language `missing` is written in (the page's). */
  locale?: Locale;
};

export function interviewCompleteness(input: CompletenessInput): InterviewCompleteness {
  const seen = new Set(input.stagesSeen);
  const partsLeft = COMPLETENESS_PARTS.filter((part) => !seen.has(part));
  const evidenced = new Set((input.dimensions ?? []).filter((note) => note.evidenced).map((note) => note.id));
  const dimensionsLeft = DIMENSIONS.filter((id) => !evidenced.has(id));
  const hypotheses = input.hypotheses ?? [];
  const settled = hypotheses.filter((item) => item.status !== "open").length;
  const tested = Math.min(1, hypotheses.length / HYPOTHESES_WANTED) * (hypotheses.length ? settled / hypotheses.length : 0);
  const trials = (input.careers ?? []).filter((career) => Boolean(career.trial?.task)).length;
  const score = input.lowerBound
    ? 0.3 * (1 - partsLeft.length / COMPLETENESS_PARTS.length) + 0.4 * (1 - dimensionsLeft.length / DIMENSIONS.length) + 0.2 * tested + 0.1 * Math.min(1, trials)
    : 0;
  const t = tFor(input.locale);
  const missing = !input.lowerBound ? (input.lowerMissing?.length ? input.lowerMissing : [t("开始使用前还需要的几项")])
    : [
      ...partsLeft.map((part) => t("还没谈到「{{part}}」", { part: t(PART_NAME[part]) })),
      ...(dimensionsLeft.length ? [t("画像还有 {{count}} 个维度缺本人的话或行为作证据", { count: dimensionsLeft.length })] : []),
      ...(hypotheses.length < HYPOTHESES_WANTED ? [t("推断还不到 {{count}} 条", { count: HYPOTHESES_WANTED })] : []),
      ...(hypotheses.length - settled > 0 ? [t("还有 {{count}} 条推断没有验证或推翻", { count: hypotheses.length - settled })] : []),
      ...(trials ? [] : [t("还没有带试做的职业方向")])
    ];
  const full = input.lowerBound && missing.length === 0;
  return { lowerBound: input.lowerBound, score: full ? 1 : Math.min(0.99, Math.round(score * 100) / 100), full, missing };
}
