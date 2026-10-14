import { TYPE_TABLE } from "@crossline/core/assess";
import type { AvatarStatus, InviteView, PairView, ResultView } from "../lib/contract";
import { pairRelation, publicType } from "../lib/public-type";
import { avatarStatus } from "./avatar";
import { baseUrl } from "./config";
import { getResultById, listPairs, recordedScores, type StoredPair, type StoredResult } from "./store";

/**
 * What each route answers, built from stored rows. Anything another person can reach is addressed by the invitation token; the result
 * token appears only in the person's own view and mails. No view carries the email, the answers or the appearance.
 */

export const posterUrl = (result: StoredResult) => `/api/poster/${result.inviteToken}/type.png`;
export const longUrl = (result: StoredResult) => `/api/poster/${result.inviteToken}/long.png`;
export const pairCardUrl = (pair: StoredPair) => `/api/poster/pair/${pair.pairToken}.png`;
export const inviteUrl = (result: StoredResult) => `${baseUrl()}/t/${result.inviteToken}`;

/** The figure as the avatar pipeline reports it, or the type's template when the pipeline cannot answer. */
export function avatarOf(result: StoredResult): AvatarStatus {
  try {
    return avatarStatus(result);
  } catch (error) {
    console.warn(JSON.stringify({ event: "assess.avatar_status_failed", resultId: result.id, error: error instanceof Error ? error.message : String(error) }));
    return { state: "template", url: `/api/avatar/${result.inviteToken}.png` };
  }
}

const typeOf = (result: StoredResult) => publicType(result.scores, recordedScores());

export function resultView(result: StoredResult): ResultView {
  const pairs = listPairs(result.id).flatMap((pair) => {
    const other = getResultById(pair.inviterId === result.id ? pair.inviteeId : pair.inviterId);
    if (!other) return [];
    return [{ pairToken: pair.pairToken, nickname: other.nickname, code: other.code, name: TYPE_TABLE[other.code]?.name ?? other.code,
      relation: pairRelation(result.code, other.code).primary.name }];
  });
  return {
    nickname: result.nickname, type: typeOf(result), avatar: avatarOf(result), posterUrl: posterUrl(result), longUrl: longUrl(result),
    inviteUrl: inviteUrl(result), sendEmail: result.sendEmail, pairs, expiresAt: result.expiresAt
  };
}

export const inviteView = (result: StoredResult): InviteView => ({ nickname: result.nickname, type: typeOf(result), avatar: avatarOf(result) });

/** The pair card: `a` is the inviter, `b` the person who answered the invitation. */
export function pairView(pair: StoredPair, a: StoredResult, b: StoredResult): PairView {
  const relation = pairRelation(a.code, b.code);
  return {
    a: { nickname: a.nickname, type: typeOf(a), avatar: avatarOf(a) },
    b: { nickname: b.nickname, type: typeOf(b), avatar: avatarOf(b) },
    primary: relation.primary,
    ...(relation.secondary ? { secondary: relation.secondary } : {}),
    sharedLines: relation.sharedLines,
    cardUrl: pairCardUrl(pair)
  };
}
