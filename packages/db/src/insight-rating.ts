import { EMPTY_PROFILE_MODEL, ONBOARDING_INSIGHTS, pointSectionFor, rateHypothesis, readInsightRatings, readPoints, unrateHypothesis,
  type DimensionId, type InsightRatings, type ProfileModel } from "@crossline/core";
import type { CrosslineStore } from "./index";

/** Where a card's rating is kept: `<session>#<seq>` for a round's first card, `<session>#<seq>.<n>` for the others. */
export const insightKey = (sessionId: string, seq: number, index = 0) => `${sessionId}#${seq}${index ? `.${index}` : ""}`;

type Card = { hypothesisId?: string; dimension?: DimensionId; text?: string; refs?: Array<{ replyId: string; quote: string }>; external?: Array<{ text: string; url: string }> };

/**
 * The person's answer to an observation card, kept per round (`<session>#<seq>`): `fits` 准, `off` 不准, `partial` 部分对 with their
 * correction, `clear` to take it back. Under the points rules (2026-11-12) the card is one hypothesis of the log: 准 makes it a point the
 * person confirmed, 不准 refutes it, 部分对 keeps it open and records the correction as a point; a changed or cleared rating first undoes
 * what the one before did. Shared by the card's route and the persona replay, so a replay rates as the app does.
 */
export function rateInsight(store: CrosslineStore, workspaceId: string, input: { sessionId: string; seq: number; verdict: "fits" | "off" | "partial" | "clear";
  correction?: string; at?: string;
  /** Which of the round's cards (2026-11-14: cards ready together come in one round): 0 the first (`insight`), n the n-th of `moreInsights`. */
  index?: number }): { ok: true; hypothesisId?: string } | { ok: false; code: "INSIGHT_NOT_FOUND" | "INSIGHT_CORRECTION_REQUIRED" } {
  const correction = (input.correction ?? "").trim().slice(0, 300);
  if (input.verdict === "partial" && !correction) return { ok: false, code: "INSIGHT_CORRECTION_REQUIRED" };
  const round = store.listOnboardingMessages(workspaceId, input.sessionId).find((message) => message.seq === input.seq && message.role === "assistant");
  const content = round?.content as { insight?: Card; moreInsights?: Card[]; stage?: string } | undefined;
  const index = input.index ?? 0;
  const card = index ? content?.moreInsights?.[index - 1] : content?.insight;
  if (!card?.text) return { ok: false, code: "INSIGHT_NOT_FOUND" };
  const key = insightKey(input.sessionId, input.seq, index);
  const at = input.at ?? new Date().toISOString();
  store.atomically(() => {
    const ratings: InsightRatings = readInsightRatings(store.getSetting(workspaceId, ONBOARDING_INSIGHTS));
    const previous = ratings[key];
    let meta: { hypothesisId?: string; pointId?: string; prior?: NonNullable<NonNullable<typeof previous>["prior"]> } = {};
    if (card.hypothesisId) {
      let profile: ProfileModel = EMPTY_PROFILE_MODEL;
      try { profile = { ...EMPTY_PROFILE_MODEL, ...(JSON.parse(store.getSetting(workspaceId, "profile.model") ?? "{}") as Partial<ProfileModel>) }; } catch { /* none yet */ }
      let log = { hypotheses: profile.hypotheses ?? [], points: readPoints(profile.points) };
      if (previous?.hypothesisId) log = unrateHypothesis(log, { hypothesisId: previous.hypothesisId, ...(previous.pointId ? { pointId: previous.pointId } : {}),
        ...(previous.prior ? { prior: previous.prior } : {}) });
      if (input.verdict !== "clear") {
        const rated = rateHypothesis(log, { hypothesisId: card.hypothesisId, cardKey: key, verdict: input.verdict, correction, at,
          card: { text: card.text!, refs: card.refs ?? [], ...(card.external ? { external: card.external } : {}) },
          section: pointSectionFor(content?.stage, card.dimension) });
        log = { hypotheses: rated.hypotheses, points: rated.points };
        meta = { hypothesisId: card.hypothesisId, ...(rated.pointId ? { pointId: rated.pointId } : {}), ...(rated.prior ? { prior: rated.prior } : {}) };
      }
      store.setSetting(workspaceId, "profile.model", JSON.stringify({ ...profile, ...log }));
    }
    if (input.verdict === "clear") delete ratings[key];
    else ratings[key] = { verdict: input.verdict, stage: content?.stage ?? "", at, text: card.text!.slice(0, 300),
      ...(correction && input.verdict === "partial" ? { correction } : {}), ...meta };
    store.setSetting(workspaceId, ONBOARDING_INSIGHTS, JSON.stringify(ratings));
  });
  return { ok: true, ...(card.hypothesisId ? { hypothesisId: card.hypothesisId } : {}) };
}
