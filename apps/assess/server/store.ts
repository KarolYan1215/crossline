import type { TypeAxisId } from "@crossline/core/assess";
import type { Appearance, AvatarStatus } from "../lib/contract";

/**
 * The public test's storage (workstream W2, docs/beta-launch.md §7 P-L1): results, their two tokens, pairs, the avatar state and the
 * 90-day retention, in its own SQLite file under `dataDir()`. Signatures fixed by the contract; W2 owns the bodies.
 */

export type StoredResult = {
  id: string;
  /** Opens the person's own result (their email link); never shown to anyone else. */
  resultToken: string;
  /** Opens the invitation and makes a pair; printed on the poster. */
  inviteToken: string;
  email: string;
  nickname: string;
  scores: Record<TypeAxisId, number>;
  code: string;
  appearance: Appearance;
  sendEmail: boolean;
  avatar: { state: AvatarStatus["state"]; file: string };
  createdAt: string;
  expiresAt: string;
};

export type StoredPair = { id: string; pairToken: string; inviterId: string; inviteeId: string; createdAt: string };

const owned = (): never => { throw new Error("NOT_IMPLEMENTED: server/store.ts belongs to workstream W2"); };

export function getResultByToken(resultToken: string): StoredResult | undefined { void resultToken; return owned(); }
export function getResultByInvite(inviteToken: string): StoredResult | undefined { void inviteToken; return owned(); }
export function getResultById(id: string): StoredResult | undefined { void id; return owned(); }
export function getPairByToken(pairToken: string): StoredPair | undefined { void pairToken; return owned(); }
/** Every recorded score per axis, for the rank once there are enough (`axisRank`). */
export function recordedScores(): Partial<Record<TypeAxisId, number[]>> { return owned(); }
/** The avatar pipeline reports progress here. */
export function setAvatarState(resultId: string, state: AvatarStatus["state"], file?: string): void { void resultId; void state; void file; return owned(); }
/** Figures already drawn (or being drawn) for this address, across all its results. */
export function avatarsDrawnFor(email: string): number { void email; return owned(); }
