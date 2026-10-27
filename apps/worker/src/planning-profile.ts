import type { CrosslineStore } from "@crossline/db";
import { planningProfile, type ProfileModelLike } from "@crossline/core";

/** The interview's planning profile of this workspace (`planningProfile` in core), from its confirmed facts and stored profile. */
export function personProfileFor(store: CrosslineStore, workspaceId: string): string[] {
  let model: ProfileModelLike | undefined;
  try { model = JSON.parse(store.getSetting(workspaceId, "profile.model") ?? "null") as ProfileModelLike | undefined ?? undefined; } catch { model = undefined; }
  return planningProfile(store.listProfileFacts(workspaceId), model);
}
