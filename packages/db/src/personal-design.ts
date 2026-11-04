import { PERSONAL_DESIGN_SETTING, knobValue, readDesign, skillNote, type DesignKnobId, type PersonalDesign } from "@crossline/core";
import type { CrosslineStore } from "./index";

/** The account's own design (packages/core/src/personal-design.ts). */
export const personalDesignOf = (store: CrosslineStore, workspaceId: string): PersonalDesign =>
  readDesign(store.getSetting(workspaceId, PERSONAL_DESIGN_SETTING));

export const designKnob = (store: CrosslineStore, workspaceId: string, id: DesignKnobId): number =>
  knobValue(personalDesignOf(store, workspaceId), id);

export const designSkillNote = (store: CrosslineStore, workspaceId: string, skill: string): string | undefined =>
  skillNote(personalDesignOf(store, workspaceId), skill);
