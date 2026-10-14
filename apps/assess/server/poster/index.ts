import type { PublicType, RelationView } from "../../lib/contract";

/**
 * Server-rendered posters (workstream W3, docs/beta-launch.md §1): PNGs drawn with satori + resvg from fixed fonts, shown to the person
 * as <img> so a long press saves them in WeChat (a download link does nothing there, and canvas screenshots vary by device). 1080×1440
 * (3:4) for the type poster and the pair card; the long image is 1080 wide. Signatures fixed by the contract; W3 owns the bodies.
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

const owned = (): never => { throw new Error("NOT_IMPLEMENTED: server/poster belongs to workstream W3"); };

export async function renderTypePoster(input: PosterInput): Promise<Buffer> { void input; return owned(); }
export async function renderLongImage(input: PosterInput): Promise<Buffer> { void input; return owned(); }
export async function renderPairCard(input: PairCardInput): Promise<Buffer> { void input; return owned(); }
