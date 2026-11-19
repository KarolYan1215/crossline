import type { CrosslineStore } from "@crossline/db";
import { METHOD_RESEARCH_SETTING, methodGuidanceLines, planningProfile, readMethodResearch, type ProfileModelLike } from "@crossline/core";

/**
 * The interview's planning profile of this workspace (`planningProfile` in core), from its confirmed facts and stored profile, followed by
 * the post-interview method research (`method-research.ts`, 2026-11-18): the person's habits, then the researched way to do each kind of
 * work, marked as research. For one line, only that line's methods and the general ones.
 */
export function personProfileFor(store: CrosslineStore, workspaceId: string, lineId?: string): string[] {
  let model: ProfileModelLike | undefined;
  try { model = JSON.parse(store.getSetting(workspaceId, "profile.model") ?? "null") as ProfileModelLike | undefined ?? undefined; } catch { model = undefined; }
  return [...planningProfile(store.listProfileFacts(workspaceId), model),
    ...methodGuidanceLines(readMethodResearch(store.getSetting(workspaceId, METHOD_RESEARCH_SETTING)), lineId)];
}
