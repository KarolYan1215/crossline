import "server-only";
import { recordPersonNote, type PersonNoteSource } from "@crossline/db";
import type { AccessContext } from "@crossline/core";
import { getStore } from "./crossline";

/**
 * Hands words the person wrote somewhere that records nothing of them to the interview's extraction, which reads them for facts and times
 * on the worker's next tick (`NOTES_SESSION` in packages/db/src/onboarding-extract.ts). Too short or already kept: nothing is written.
 */
export function keepNote(ctx: AccessContext, text: string, source: PersonNoteSource, about: string, now = new Date()): boolean {
  return recordPersonNote(getStore(), ctx.workspaceId, ctx.principalId, { text, source, about }, now.toISOString());
}
