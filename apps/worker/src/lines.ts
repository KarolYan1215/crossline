import { checkGoalParts, composeGoal, type Locale } from "@crossline/core";
import { identityPacksFor, LINE_SETTING, readLineSpecs, type IdentityPack } from "@crossline/identity-packs";
import type { CrosslineStore } from "@crossline/db";

/** The packs a workspace works with: its own lines (or the built-in four for an older account) and the capacity pack. */
export function linePacks(store: CrosslineStore, workspaceId: string, options: { includeArchived?: boolean } = {}): IdentityPack[] {
  return identityPacksFor((key) => store.getSetting(workspaceId, key), options);
}
export const identityLines = (store: CrosslineStore, workspaceId: string) => linePacks(store, workspaceId).filter((pack) => pack.kind === "identity");

/**
 * A line's long-term goal chosen in the interview's own round (the `LINE_GOAL` question): written as the left column's 「采用」 writes it
 * (`updateLine` in apps/web/lib/lines.ts) — the parts kept, `goals[0]` the sentence composed from them. Never over a goal the line already
 * has, and only for a line on record; parts the goal check refuses are left for the left column.
 */
export function adoptLineGoal(store: CrosslineStore, workspaceId: string, ownerId: string, lineId: string, parts: string[], locale?: Locale): boolean {
  const specs = readLineSpecs((key) => store.getSetting(workspaceId, key));
  const line = specs?.find((item) => item.id === lineId);
  if (!specs || !line || (line.goals ?? []).length || line.goal) return false;
  const checked = checkGoalParts(parts, locale);
  if (!checked.ok) return false;
  const goal = composeGoal(checked.parts, line.label, locale);
  if (!goal) return false;
  store.setSetting(workspaceId, LINE_SETTING, JSON.stringify(specs.map((item) => item.id === lineId ? { ...item, goal, goals: [goal], goalParts: checked.parts } : item)));
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `line.updated:${lineId}:goal:${Date.now()}`, type: "line.updated", entityId: lineId,
    payload: { goalParts: checked.parts, via: "interview" } });
  return true;
}
