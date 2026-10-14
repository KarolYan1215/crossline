import type { PublicType, RelationView } from "../../lib/contract";
import { cachedPng, fileDigest, posterKey } from "./cache";
import { figureFrom } from "./figure";
import { HEIGHT, longImageTree, pairCardTree, toPng, typePosterTree } from "./render";

/**
 * Server-rendered posters (workstream W3, docs/beta-launch.md §1): PNGs drawn with satori + resvg from fixed fonts, shown to the person
 * as <img> so a long press saves them in WeChat (a download link does nothing there, and canvas screenshots vary by device). 1080×1440
 * (3:4) for the type poster and the pair card; the long image is 1080 wide. Signatures fixed by the contract; W3 owns the bodies.
 * Each is cached on disk by a hash of its input and the figure's bytes (`cache.ts`).
 */

export type PosterInput = { type: PublicType; nickname: string; avatarPath: string; inviteUrl: string };
export type PairCardInput = {
  a: { type: PublicType; nickname: string; avatarPath: string };
  b: { type: PublicType; nickname: string; avatarPath: string };
  primary: RelationView;
  secondary?: RelationView;
  sharedLines: string[];
  /** Printed as the card's QR code: the inviter's invitation, so the card keeps spreading. */
  inviteUrl: string;
};

const keyParts = (input: PosterInput) => ({ type: input.type, nickname: input.nickname, inviteUrl: input.inviteUrl, figure: fileDigest(input.avatarPath) });

export async function renderTypePoster(input: PosterInput): Promise<Buffer> {
  return cachedPng(posterKey("type", keyParts(input)), async () =>
    (await toPng(typePosterTree(input.type, input.nickname, figureFrom(input.avatarPath, input.type.code), input.inviteUrl), HEIGHT)).png);
}

export async function renderLongImage(input: PosterInput): Promise<Buffer> {
  return cachedPng(posterKey("long", keyParts(input)), async () =>
    (await toPng(longImageTree(input.type, input.nickname, figureFrom(input.avatarPath, input.type.code), input.inviteUrl))).png);
}

export async function renderPairCard(input: PairCardInput): Promise<Buffer> {
  const side = (person: PairCardInput["a"]) => ({ type: person.type, nickname: person.nickname, figure: figureFrom(person.avatarPath, person.type.code) });
  const parts = { ...input, a: { ...input.a, avatarPath: fileDigest(input.a.avatarPath) }, b: { ...input.b, avatarPath: fileDigest(input.b.avatarPath) } };
  return cachedPng(posterKey("pair", parts), async () =>
    (await toPng(pairCardTree(side(input.a), side(input.b), input.primary, input.secondary, input.sharedLines, input.inviteUrl), HEIGHT)).png);
}
