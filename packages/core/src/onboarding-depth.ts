import type { CardSet } from "./profile-instruments";

/**
 * The interview's pace. There are no tiers (the owner, 2026-11-12: 「删除所有档位」): every interview has no round, time or word budget and
 * ends only by the person's 「结束并出报告」. The four tiers of 2026-10-31, the stored `onboarding.depth` choice, the round budget and the
 * move-on count were removed from the code on 2026-11-14 (docs/onboarding-agent-session.md, P0).
 */
export type InterviewPace = {
  /** The model's own questions kept in one round. */
  roundQuestions: number;
  /** The app's own questions that do not block join only while a round has fewer than this many in all. */
  roundMax: number;
  /** Rating-card items in one round (no cards since 2026-11-22: kept for the dialogue's card code until it goes). */
  cardItems: number;
  /**
   * Which rating cards the interview asks (`cardBank`): `"short"`, which since 2026-11-22 holds none. The scale (IPIP-NEO-120 and TwIVI)
   * is one page of its own before the first round (profile-scale.ts, D1); the 14-item short set asked a few items a round for about six
   * rounds is gone.
   */
  cards: CardSet;
};

export const INTERVIEW_PACE: InterviewPace = { roundQuestions: 3, roundMax: 4, cardItems: 0, cards: "short" };
