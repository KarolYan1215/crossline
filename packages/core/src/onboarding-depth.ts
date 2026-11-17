import type { CardSet } from "./profile-instruments";

/**
 * The interview's pace. There are no tiers (the owner, 2026-11-12: 「删除所有档位」): every interview has no round, time or word budget and
 * ends only by the person's 「结束并出报告」 once the start standard stands. The four tiers of 2026-10-31 (quick, standard, thorough, open),
 * the stored `onboarding.depth` choice, the round budget (`roundsSpent`) and the move-on count were removed from the code on 2026-11-14
 * (docs/onboarding-agent-session.md, P0); a stored choice in an older ledger is simply never read.
 */
export type InterviewPace = {
  /** The model's own questions kept in one round. */
  roundQuestions: number;
  /** The app's own questions that do not block join only while a round has fewer than this many in all. */
  roundMax: number;
  /** Rating-card items in one round. */
  cardItems: number;
  /**
   * Which rating cards the profile module asks before the start (`cardBank`): the short set. The full one's 43 items and interest cards
   * were what a beta tester rejected (asked not to be questioned about interests again), and a long questionnaire is what loses people
   * (docs/claude/profile-first-loop.md); the portrait's inferences come from the conversation.
   */
  cards: CardSet;
};

export const INTERVIEW_PACE: InterviewPace = { roundQuestions: 3, roundMax: 4, cardItems: 3, cards: "short" };
