import type { CardSet } from "./profile-instruments";

/**
 * How thorough the interview is (2026-10-31, the owner's decision): the person picks a tier on the opening card and can change it at any
 * time. `quick` is the interview as cut down on 2026-10-19 and 2026-10-31 for time; `standard` and `thorough` bring back, step by step,
 * what those cuts took out (docs/onboarding-v3.md 「时间挡位」, walkthrough W-82): more questions a round (the model's five plus up to three
 * of the app's), two full rating cards, more rounds per part, every project's goal and evidence asked in the interview instead of later,
 * the portrait held until it rests on the person's own words, more options per question, the long situation questions and, in
 * `thorough`, the details part per project (grading, class times, collaborators, tools, every deadline). `open` (2026-11-01, the owner:
 * 「我自己或者深度用户用的时候希望能选不限时不限轮数的详细对话」) is `thorough` with no time and no round budget: no part is ever told to move on,
 * and the interview ends when the person says it is enough or every topic rests on their own examples.
 */
export const ONBOARDING_DEPTHS = ["quick", "standard", "thorough", "open"] as const;
export type OnboardingDepth = (typeof ONBOARDING_DEPTHS)[number];
export const ONBOARDING_DEPTH_SETTING = "onboarding.depth";

export const ONBOARDING_DEPTH_LABEL: Record<OnboardingDepth, { label: string; detail: string }> = {
  quick: { label: "快速", detail: "约 50 分钟，只问排日程必需的，项目细节到拆任务时再补" },
  standard: { label: "标准", detail: "约 80 分钟，画像多问几层，每个项目的目标和进展当场问清" },
  thorough: { label: "事无巨细", detail: "约 2 小时，每个项目的评分、上课时间、协作者、工具和所有截止都问到" },
  open: { label: "不限时", detail: "不限时长和轮数，每个话题问到你自己的例子为止，什么时候结束由你决定" }
};

/** An account that never chose (every interview before the tiers) runs the quick interview it always ran. */
export function readDepth(value: string | null | undefined): OnboardingDepth {
  return (ONBOARDING_DEPTHS as readonly string[]).includes(value ?? "") ? value as OnboardingDepth : "quick";
}

export type DepthPace = {
  /** The whole interview, in minutes, as the opening card and the right column say it (for `unlimited`, only the scale of the estimates). */
  minutes: number;
  /** No time and no round budget: no part is told to move on, and no time is shown for the rest of the interview. */
  unlimited: boolean;
  /** The model's own questions kept in one round. */
  roundQuestions: number;
  /** The app's own questions that do not block join only while a round has fewer than this many in all. */
  roundMax: number;
  /** Rating-card items in one round. */
  cardItems: number;
  /** Which rating cards the profile module asks before the start (`cardBank`): the quick tier a short set of whole dimensions (W-186). */
  cards: CardSet;
  /** From this many rounds in one part, the model is told to move on. */
  moveOnAfter: number;
  /**
   * A project's checklist item: `deferred` (asked when its task is planned), `core` (its goal, deadline and progress evidence are asked in
   * the interview; a course's grading and class times wait), `all` (both).
   */
  projects: "deferred" | "core" | "all";
  /** Whether the portrait's grounding (each part resting on the person's own words) still holds the end once the start standard stands. */
  portraitHolds: boolean;
  /** Whether the main interview ends with the details part, project by project. */
  detailsPart: boolean;
};

export const DEPTH_PACE: Record<OnboardingDepth, DepthPace> = {
  quick: { minutes: 50, unlimited: false, roundQuestions: 3, roundMax: 4, cardItems: 3, cards: "short", moveOnAfter: 2, projects: "deferred", portraitHolds: false, detailsPart: false },
  standard: { minutes: 80, unlimited: false, roundQuestions: 4, roundMax: 6, cardItems: 6, cards: "all", moveOnAfter: 3, projects: "core", portraitHolds: true, detailsPart: false },
  thorough: { minutes: 120, unlimited: false, roundQuestions: 5, roundMax: 8, cardItems: 6, cards: "all", moveOnAfter: 4, projects: "all", portraitHolds: true, detailsPart: true },
  open: { minutes: 120, unlimited: true, roundQuestions: 5, roundMax: 8, cardItems: 6, cards: "all", moveOnAfter: Number.POSITIVE_INFINITY, projects: "all", portraitHolds: true, detailsPart: true }
};

export const depthPace = (depth: OnboardingDepth | undefined): DepthPace => DEPTH_PACE[depth ?? "quick"];
