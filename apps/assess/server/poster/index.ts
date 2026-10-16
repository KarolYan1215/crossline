import type { PublicType, RelationView } from "../../lib/contract";
import type { Locale } from "../../lib/i18n";
import { cachedPng, fileDigest, posterKey } from "./cache";
import { figureFrom } from "./figure";
import { HEIGHT, longImageTree, pairCardTree, toPng, typePosterTree } from "./render";

/**
 * Server-rendered posters (workstream W3, docs/beta-launch.md §1): PNGs drawn with satori + resvg from fixed fonts, shown to the person
 * as <img> so a long press saves them in WeChat (a download link does nothing there, and canvas screenshots vary by device). 1080×1440
 * (3:4) for the type poster and the pair card; the long image is 1080 wide. Signatures fixed by the contract; W3 owns the bodies.
 * Each is cached on disk by a hash of its input and the figure's bytes (`cache.ts`).
 */

/**
 * `cacheTag` names whose poster this is (the invitation token, or the pair token for a pair card), so deleting the result deletes it.
 * `locale` is the reader's language (Chinese when absent); `type` must already be in it. Each language is its own file on disk.
 */
export type PosterInput = { type: PublicType; nickname: string; avatarPath: string; inviteUrl: string; cacheTag?: string; locale?: Locale };
export type PairCardInput = {
  a: { type: PublicType; nickname: string; avatarPath: string };
  b: { type: PublicType; nickname: string; avatarPath: string };
  primary: RelationView;
  secondary?: RelationView;
  sharedLines: string[];
  /** Printed as the card's QR code: the inviter's invitation, so the card keeps spreading. */
  inviteUrl: string;
  cacheTag?: string;
  locale?: Locale;
};

const keyParts = (input: PosterInput) =>
  ({ type: input.type, nickname: input.nickname, inviteUrl: input.inviteUrl, figure: fileDigest(input.avatarPath), locale: input.locale ?? "zh" });

export async function renderTypePoster(input: PosterInput): Promise<Buffer> {
  return cachedPng(posterKey("type", keyParts(input), input.cacheTag, input.locale), async () =>
    (await toPng(typePosterTree(input.type, input.nickname, figureFrom(input.avatarPath), input.inviteUrl, input.locale), HEIGHT)).png);
}

export async function renderLongImage(input: PosterInput): Promise<Buffer> {
  return cachedPng(posterKey("long", keyParts(input), input.cacheTag, input.locale), async () =>
    (await toPng(longImageTree(input.type, input.nickname, figureFrom(input.avatarPath), input.inviteUrl, input.locale))).png);
}

export async function renderPairCard(input: PairCardInput): Promise<Buffer> {
  const side = (person: PairCardInput["a"]) => ({ type: person.type, nickname: person.nickname, figure: figureFrom(person.avatarPath) });
  const { cacheTag, ...rest } = input;
  const parts = { ...rest, locale: input.locale ?? "zh", a: { ...input.a, avatarPath: fileDigest(input.a.avatarPath) }, b: { ...input.b, avatarPath: fileDigest(input.b.avatarPath) } };
  return cachedPng(posterKey("pair", parts, cacheTag, input.locale), async () =>
    (await toPng(pairCardTree(side(input.a), side(input.b), input.primary, input.secondary, input.sharedLines, input.inviteUrl, input.locale), HEIGHT)).png);
}
