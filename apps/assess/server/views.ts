import { TYPE_TABLE } from "@crossline/core/assess";
import { wantsPlan, type WantLines } from "@crossline/core/assess-wants";
import type { AvatarStatus, InviteView, PairView, ResultView } from "../lib/contract";
import { tFor, type Locale } from "../lib/i18n";
import { pairRelation, publicType } from "../lib/public-type";
import { avatarStatus } from "./avatar";
import { appUrl, baseUrl } from "./config";
import { mailConfigured } from "./mail";
import { WANTS_UPDATES_MAX, betaRequested, getResultById, listPairs, recordedScores, type StoredPair, type StoredResult } from "./store";

/**
 * What each route answers, built from stored rows. Anything another person can reach is addressed by the invitation token; the result
 * token appears only in the person's own view and mails. No view carries the email, the answers or the appearance.
 */

/**
 * A short tag that changes whenever what a poster shows as the figure changes (waiting, drawn — and which drawing — or the fallback). It
 * goes on every poster address, so a browser that cached a poster drawn while the figure was still being made asks again instead of
 * keeping it for its five minutes: a reload after the figure arrived used to show the old poster. The poster routes ignore it; the
 * poster cache on disk is keyed by the figure's bytes anyway.
 */
export function figureTag(avatar: AvatarStatus): string {
  if (avatar.state === "ready") return `d${/[?&]v=(\d+)/.exec(avatar.url)?.[1] ?? "0"}`;
  return avatar.state === "template" ? "t" : "w";
}

/** The poster tag of one result: its figure, and — once set — how many times its lines were set (the poster prints them too). */
const posterTag = (result: StoredResult, avatar: AvatarStatus) => `${figureTag(avatar)}${result.wantsUpdates ? `l${result.wantsUpdates}` : ""}`;

/**
 * The reader's language on a poster address (`&l=en`; none for Chinese): the same poster in two languages is two addresses, so a
 * browser that cached one never shows it after the reader switches. The poster routes read it before the cookie.
 */
const lang = (locale?: Locale) => locale === "en" ? "&l=en" : "";

export const posterUrl = (result: StoredResult, avatar = avatarOf(result), locale?: Locale) =>
  `/api/poster/${result.inviteToken}/type.png?f=${posterTag(result, avatar)}${lang(locale)}`;
export const longUrl = (result: StoredResult, avatar = avatarOf(result), locale?: Locale) =>
  `/api/poster/${result.inviteToken}/long.png?f=${posterTag(result, avatar)}${lang(locale)}`;
export const pairCardUrl = (pair: StoredPair, a: { result: StoredResult; avatar: AvatarStatus }, b: { result: StoredResult; avatar: AvatarStatus }, locale?: Locale) =>
  `/api/poster/pair/${pair.pairToken}.png?f=${posterTag(a.result, a.avatar)}.${posterTag(b.result, b.avatar)}${lang(locale)}`;
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

/**
 * The lines a result's person said they want, for a reader in `locale`. The rules' lines and a written combination are remade in the
 * reader's language from what the person picked (the same choice, so the same lines); a model's lines stay as the model wrote them.
 */
export function wantLinesFor(result: StoredResult, locale?: Locale): WantLines | undefined {
  const wants = result.wants;
  if (!wants) return undefined;
  if (wants.lines.source === "model" || (wants.lines.locale ?? "zh") === (locale ?? "zh")) return wants.lines;
  return wantsPlan(result.code, wants.input, locale).lines;
}

/** The public type of a result in the reader's language, with the lines the person said they want once they have. */
export const typeOf = (result: StoredResult, recorded = recordedScores(), locale?: Locale) =>
  publicType(result.scores, recorded, result.id, wantLinesFor(result, locale), locale);

export function resultView(result: StoredResult, locale?: Locale): ResultView {
  const pairs = listPairs(result.id).flatMap((pair) => {
    const other = getResultById(pair.inviterId === result.id ? pair.inviteeId : pair.inviterId);
    if (!other) return [];
    const name = TYPE_TABLE[other.code]?.name;
    return [{ pairToken: pair.pairToken, nickname: other.nickname, code: other.code, name: name ? tFor(locale)(name) : other.code,
      relation: pairRelation(result.code, other.code, undefined, undefined, locale).primary.name }];
  });
  const avatar = avatarOf(result);
  return {
    nickname: result.nickname, type: typeOf(result, undefined, locale), avatar, posterUrl: posterUrl(result, avatar, locale), longUrl: longUrl(result, avatar, locale),
    inviteUrl: inviteUrl(result), sendEmail: result.sendEmail, mailOn: mailConfigured(),
    betaRequested: betaRequested(result.id), appUrl: appUrl(), pairs,
    wants: result.wants ? { picks: [...result.wants.input.picks], text: result.wants.input.text } : null,
    wantsLeft: Math.max(0, WANTS_UPDATES_MAX - (result.wantsUpdates ?? 0)), expiresAt: result.expiresAt
  };
}

export const inviteView = (result: StoredResult, locale?: Locale): InviteView =>
  ({ nickname: result.nickname, type: typeOf(result, undefined, locale), avatar: avatarOf(result) });

/** The pair card: `a` is the inviter, `b` the person who answered the invitation. */
export function pairView(pair: StoredPair, a: StoredResult, b: StoredResult, locale?: Locale): PairView {
  const relation = pairRelation(a.code, b.code, wantLinesFor(a, locale)?.lines, wantLinesFor(b, locale)?.lines, locale);
  const figures = { a: avatarOf(a), b: avatarOf(b) };
  return {
    a: { nickname: a.nickname, type: typeOf(a, undefined, locale), avatar: figures.a },
    b: { nickname: b.nickname, type: typeOf(b, undefined, locale), avatar: figures.b },
    primary: relation.primary,
    ...(relation.secondary ? { secondary: relation.secondary } : {}),
    sharedLines: relation.sharedLines,
    cardUrl: pairCardUrl(pair, { result: a, avatar: figures.a }, { result: b, avatar: figures.b }, locale)
  };
}
