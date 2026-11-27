import { ONBOARDING_INSIGHTS, readInsightRatings } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";

/**
 * What a replay is judged by (P5, docs/onboarding-agent-session.md §5): read from the ledger an interview left, after the fact. Nothing
 * here runs during an interview or decides anything in it; the numbers say whether moving a rule from code to the model (D2) brought
 * an old fault back.
 */
export type InterviewMetrics = {
  /** The dialogue's rounds. */
  rounds: number;
  /** Questions put to the person per round, the app's own included. */
  questionsPerRound: number;
  /** Sentences of reply per question: how much the dialogue reflects before it asks (aim: 1–2). */
  reflectionPerQuestion: number;
  /** Questions the dialogue itself marked as asking an earlier one (`repeats`), of all it asked. */
  repeatRate: number;
  /** Observation cards rated 「不准」, of those rated. */
  cardsOff: number;
  /** Replies that open by agreeing with the person (「对」「没错」「你说得对」…), of all replies. */
  agreeOpenings: number;
  /** Items the app's checks sent back and the model never fixed: left out of the round (`onboarding.round_edited`). */
  leftOut: number;
  /** Whether the dialogue's thread had the card tools (`coverage.cardTools`). */
  cardTools: "tools" | "fallback" | null;
  /** Rounds and minutes spent in each stage, in the order reached. */
  stages: Array<{ stage: string; rounds: number; minutes: number }>;
};

const SENTENCE = /[^。！？!?\n]+[。！？!?]?/gu;
// i18n-ignore: openings read from the model's replies in a replay, never shown
const AGREEING = /^(对|是的|没错|确实|你说得对|说得对|完全同意|同意|很好|太好了|嗯，对|right|exactly|absolutely|you're right)/iu;
const ratio = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) / 100 : 0);

export function interviewMetrics(store: CrosslineStore, workspaceId: string, sessionId: string): InterviewMetrics {
  const messages = store.listOnboardingMessages(workspaceId, sessionId);
  const rounds = messages.filter((message) => message.role === "assistant").map((message) => ({ at: message.createdAt,
    content: message.content as { reply?: string; questions?: unknown[]; stage?: string } }));
  const questions = rounds.reduce((sum, round) => sum + (round.content.questions?.length ?? 0), 0);
  const sentences = rounds.reduce((sum, round) => sum + ((round.content.reply ?? "").match(SENTENCE) ?? []).filter((text) => text.trim()).length, 0);
  const asked = store.listQuestions(workspaceId, { kind: "interview", keyPrefix: `iq:${sessionId}:` });
  const ratings = Object.entries(readInsightRatings(store.getSetting(workspaceId, ONBOARDING_INSIGHTS))).filter(([key]) => key.startsWith(`${sessionId}#`));
  const leftOut = store.listEvents(workspaceId, { type: "onboarding.changed", change: "round_edited" }).filter((event) => event.entityId === sessionId)
    .reduce((sum, event) => sum + ((event.payload as { removed?: unknown[] }).removed?.length ?? 0), 0);
  const stages: InterviewMetrics["stages"] = [];
  rounds.forEach((round, index) => {
    const stage = round.content.stage ?? "";
    const next = rounds[index + 1]?.at ?? round.at;
    const minutes = Math.max(0, (Date.parse(next) - Date.parse(round.at)) / 60_000);
    const last = stages.at(-1);
    if (last && last.stage === stage) { last.rounds += 1; last.minutes += minutes; } else stages.push({ stage, rounds: 1, minutes });
  });
  const mode = (store.getOnboardingSession(workspaceId, sessionId)?.coverage as { cardTools?: unknown } | undefined)?.cardTools;
  return {
    rounds: rounds.length,
    questionsPerRound: ratio(questions, rounds.length),
    reflectionPerQuestion: ratio(sentences, questions),
    repeatRate: ratio(asked.filter((question) => (question.repeats ?? 0) > 0).length, asked.length),
    cardsOff: ratio(ratings.filter(([, rating]) => rating.verdict === "off").length, ratings.length),
    agreeOpenings: ratio(rounds.filter((round) => AGREEING.test((round.content.reply ?? "").trim())).length, rounds.length),
    leftOut,
    cardTools: mode === "tools" || mode === "fallback" ? mode : null,
    stages: stages.map((item) => ({ ...item, minutes: Math.round(item.minutes) }))
  };
}
