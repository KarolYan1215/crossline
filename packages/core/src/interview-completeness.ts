/**
 * How complete the interview is, for the 「结束并出报告」 button (the owner's decision of 2026-11-12). The lower bound is the start standard:
 * below it the button is off. Above it the person may end whenever they like; `score` fills the button, and `full` — a standard well above
 * the lower bound — is when the page reminds them once that they can end. Nothing here ends the interview.
 */
export type InterviewCompleteness = { lowerBound: boolean; score: number; full: boolean; missing: string[];
  /** Fewer than `STORY_POINTS_WANTED` points in the life-story section (2026-11-22): the button says the report's narrative will be short. */
  storyShort?: boolean };

import { tFor, type Locale } from "./i18n";

const DIMENSIONS = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"] as const;
/** The parts of the main interview (flow v2) that the portrait needs walked; the per-project details part is not one of them. */
export const COMPLETENESS_PARTS = ["narrative", "compass", "energy", "situation", "orientation", "lines"] as const;
const PART_NAME: Record<(typeof COMPLETENESS_PARTS)[number], string> = {
  narrative: "经历与转折", compass: "指南针", energy: "能量", situation: "处境", orientation: "主线", lines: "主线细节"
};
/**
 * This many hypotheses settled (supported, refuted, undecided) and the portrait's inferences count as tested. Counted, not a share: the
 * extraction keeps adding hypotheses, and on the 2026-11-12 replay 25 of them with 13 open held the button at 85% for good.
 */
export const HYPOTHESES_WANTED = 5;
/** Points about the life story below which the portrait's narrative has little to tell (docs/plans/portrait-depth-1122.md §五). */
export const STORY_POINTS_WANTED = 3;

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
  /** The points ledger (absent on an older portrait): only its life-story points are counted. */
  points?: Array<{ section?: string; retracted?: boolean }>;
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
  const tested = Math.min(1, settled / HYPOTHESES_WANTED);
  const trials = (input.careers ?? []).filter((career) => Boolean(career.trial?.task)).length;
  const score = input.lowerBound
    ? 0.3 * (1 - partsLeft.length / COMPLETENESS_PARTS.length) + 0.4 * (1 - dimensionsLeft.length / DIMENSIONS.length) + 0.2 * tested + 0.1 * Math.min(1, trials)
    : 0;
  const t = tFor(input.locale);
  const missing = !input.lowerBound ? (input.lowerMissing?.length ? input.lowerMissing : [t("开始使用前还需要的几项")])
    : [
      ...partsLeft.map((part) => t("还没谈到「{{part}}」", { part: t(PART_NAME[part]) })),
      ...(dimensionsLeft.length ? [t("画像还有 {{count}} 个维度缺本人的话或行为作证据", { count: dimensionsLeft.length })] : []),
      ...(settled < HYPOTHESES_WANTED ? [t("验证或推翻的推断还不到 {{count}} 条（现有 {{settled}} 条）", { count: HYPOTHESES_WANTED, settled })] : []),
      ...(trials ? [] : [t("还没有带试做的职业方向")])
    ];
  const full = input.lowerBound && missing.length === 0;
  const story = input.points?.filter((point) => point.section === "narrative" && !point.retracted).length;
  return { lowerBound: input.lowerBound, score: full ? 1 : Math.min(0.99, Math.round(score * 100) / 100), full, missing,
    ...(story !== undefined && story < STORY_POINTS_WANTED ? { storyShort: true } : {}) };
}
