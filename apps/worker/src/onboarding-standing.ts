// i18n-exempt: the short progress header handed to the interview model each round (model-facing)
import { interviewCompleteness, type CompletenessInput } from "@crossline/core";

/**
 * The progress header (docs/onboarding-agent-session.md 「状态头怎么收」, 2026-11-15): a few lines put first in every round's input, so the
 * dialogue sees where it stands in the whole interview. Facts only, never an instruction: what to do with them is the Skill's 「进度头」.
 * Replay 15 ran to its 45-round limit without once offering the end, spent 31 rounds in one part and put a card in 37 rounds, each
 * round judged on its own with no count of the rounds before it.
 */
export type StandingRound = { stage: string; questions: number; cards: number; verdicts: Array<"fits" | "partial" | "off"> };

export type StandingInput = {
  /** The dialogue's earlier rounds, oldest first. */
  rounds: StandingRound[];
  /** The part the last round marked (`mark_round`); the order the parts go in is the Skill's (2026-11-22), so none is listed here. */
  stage: string;
  /** The round the start standard first stood in, if it does now. */
  startMetRound: number | null;
  /** What the start standard still lacks, while it does not stand. */
  startMissing: string[];
  /** Facts the latest extraction runs wrote, oldest first: how much the latest replies still add (a fact, never a budget). */
  facts?: number[];
  /** The working portrait's dimension notes, hypotheses and career options (`ProfileModel`). */
  profile: Pick<CompletenessInput, "dimensions" | "hypotheses" | "careers">;
};

/** Rounds the latest cards and question counts are reported for. */
export const STANDING_RECENT = 3;
/** Extraction runs in a row with no new fact that the header calls out as such. */
export const SATURATED_RUNS = 3;

/**
 * The round of a part from which every round's note says how long the part has run (replay of 2026-11-23: the story took 9 rounds, the
 * situation 11 and the compass 9 more, so 30 rounds never reached energy). The Skill closes the part at that round.
 */
export const PART_ROUNDS = 6;

const VERDICT = { fits: "准", partial: "部分对", off: "不准" } as const;

/** Rounds in a row in `stage`, this one included, given the earlier rounds' parts oldest first. */
export function roundsInPart(stages: readonly string[], stage: string): number {
  let inStage = 1;
  for (let at = stages.length - 1; at >= 0 && stages[at] === stage; at -= 1) inStage += 1;
  return inStage;
}

/**
 * What the person asked the interviewer in a reply, at most the last two (replay of 2026-11-23: 「到底哪个最适合我？」 got a question
 * about the résumé back, the answer only in `progress.next`). A card's own question 【…？】 is the app's, not the person's.
 */
export function questionsAsked(text: string): string[] {
  const own = text.replace(/【[^】]*】/g, " ");
  return (own.match(/[^。！!？?\n]*[？?]/g) ?? []).map((item) => item.trim()).filter((item) => item.length >= 3).slice(-2);
}

export function standingLines(input: StandingInput): string[] {
  const round = input.rounds.length + 1;
  const stagesSeen = [...input.rounds.map((item) => item.stage), input.stage];
  const inStage = roundsInPart(input.rounds.map((item) => item.stage), input.stage);
  const walked = [...new Set(stagesSeen.filter(Boolean))];
  const completeness = interviewCompleteness({ lowerBound: input.startMetRound !== null, lowerMissing: input.startMissing, stagesSeen, ...input.profile });
  const recent = input.rounds.slice(-STANDING_RECENT);
  const verdicts = recent.flatMap((item) => item.verdicts);
  const count = (verdict: keyof typeof VERDICT) => verdicts.filter((item) => item === verdict).length;
  const cards = recent.reduce((sum, item) => sum + item.cards, 0);
  return [
    `这是第 ${round} 轮；当前部分 ${input.stage} 连这一轮已经 ${inStage} 轮。`,
    `谈过的部分：${walked.join("、") || "无"}。`,
    input.startMetRound !== null ? `开始标准：从第 ${input.startMetRound} 轮起已齐，本人可以按「结束并出报告」；右栏「一周」里有按记下的时间画的一周草稿。`
      : `开始标准：还没齐，缺 ${input.startMissing.join("、") || "几项"}。`,
    ...(input.facts?.length ? [`最近 ${input.facts.length} 次整理记下的事实：${input.facts.join("、")} 条`
      + (input.facts.length >= SATURATED_RUNS && input.facts.every((count) => count === 0) ? "（连续几次没有新事实）。" : "。")] : []),
    ...(input.startMetRound === null ? []
      : completeness.full ? ["ready_for_milestones 的条件全部齐了。"]
      : [`ready_for_milestones 还差：${completeness.missing.join("；")}。`]),
    ...(recent.length ? [`最近 ${recent.length} 轮：每轮题数 ${recent.map((item) => item.questions).join("、")}；出卡 ${cards} 张`
      + (verdicts.length ? `（本人评：准 ${count("fits")}、部分对 ${count("partial")}、不准 ${count("off")}${verdicts.length < cards ? `、未评 ${cards - verdicts.length}` : ""}）` : "")
      + "。"] : [])
  ];
}
