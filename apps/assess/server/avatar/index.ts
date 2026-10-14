import type { AvatarStatus } from "../../lib/contract";
import type { StoredResult } from "../store";

/**
 * The figure pipeline (workstream W5, docs/beta-launch.md §4): the type's template plus the person's appearance, drawn by an image
 * model, with a queue, a per-address limit, a daily budget and the template as the fallback. Signatures fixed by the contract; W5 owns
 * the bodies.
 */

const owned = (): never => { throw new Error("NOT_IMPLEMENTED: server/avatar belongs to workstream W5"); };

/** Starts drawing this result's figure, or settles it on the template at once (over budget, over the address's limit, no provider). */
export function enqueueAvatar(result: StoredResult): void { void result; return owned(); }
/** What the pages show: the drawn figure's URL when ready, else the template's. */
export function avatarStatus(result: StoredResult): AvatarStatus { void result; return owned(); }
/** A PNG file on disk for the poster renderer: the drawn figure when ready, else the template. */
export function avatarImagePath(result: StoredResult): string { void result; return owned(); }
/** The type's template PNG on disk. */
export function templateImagePath(code: string): string { void code; return owned(); }
