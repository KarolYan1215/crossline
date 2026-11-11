import { INSTRUCTIONS_ENTITY, INSTRUCTIONS_EVENT, PERSONAL_DESIGN_SETTING, currentInstructions, instructionVersions, instructionsProblem, knobValue, readDesign, skillNote, type DesignKnobId, type InstructionsVersion, type PersonalDesign } from "@crossline/core";
import type { CrosslineStore } from "./index";

/** The account's own design (packages/core/src/personal-design.ts). */
export const personalDesignOf = (store: CrosslineStore, workspaceId: string): PersonalDesign =>
  readDesign(store.getSetting(workspaceId, PERSONAL_DESIGN_SETTING));

export const designKnob = (store: CrosslineStore, workspaceId: string, id: DesignKnobId): number =>
  knobValue(personalDesignOf(store, workspaceId), id);

export const designSkillNote = (store: CrosslineStore, workspaceId: string, skill: string): string | undefined =>
  skillNote(personalDesignOf(store, workspaceId), skill);

/** Every version of 「给 Crossline 的话」, oldest first (packages/core/src/instructions.ts). */
export const instructionVersionsOf = (store: CrosslineStore, workspaceId: string): InstructionsVersion[] =>
  instructionVersions(store.listEvents(workspaceId, { type: INSTRUCTIONS_EVENT, entityId: INSTRUCTIONS_ENTITY }));

export const currentInstructionsOf = (store: CrosslineStore, workspaceId: string): { version: number; text: string } =>
  currentInstructions(instructionVersionsOf(store, workspaceId));

/**
 * Writes a new version (also for a revert, which is the old text written again with `revertOf`). Nothing is written when the text is
 * already the one in force. Returns the version in force afterwards.
 */
export function setInstructions(store: CrosslineStore, input: { workspaceId: string; ownerId: string; text: string; by: "person" | "assistant"; revertOf?: number }):
  { version: number; text: string; changed: boolean } {
  const text = input.text.replace(/\r\n/g, "\n").trim();
  const problem = instructionsProblem(text);
  if (problem) throw new Error("INSTRUCTIONS_TOO_LONG");
  const current = currentInstructionsOf(store, input.workspaceId);
  if (current.text === text) return { ...current, changed: false };
  const version = current.version + 1;
  store.appendEvent({ ownerId: input.ownerId, workspaceId: input.workspaceId, idempotencyKey: `${INSTRUCTIONS_EVENT}:${version}`, type: INSTRUCTIONS_EVENT,
    entityId: INSTRUCTIONS_ENTITY, payload: { version, text, by: input.by, ...(input.revertOf !== undefined ? { revertOf: input.revertOf } : {}) } });
  return { version, text, changed: true };
}
