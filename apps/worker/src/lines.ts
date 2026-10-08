import { identityPacksFor, type IdentityPack } from "@crossline/identity-packs";
import type { CrosslineStore } from "@crossline/db";

/** The packs a workspace works with: its own lines (or the built-in four for an older account) and the capacity pack. */
export function linePacks(store: CrosslineStore, workspaceId: string, options: { includeArchived?: boolean } = {}): IdentityPack[] {
  return identityPacksFor((key) => store.getSetting(workspaceId, key), options);
}
export const identityLines = (store: CrosslineStore, workspaceId: string) => linePacks(store, workspaceId).filter((pack) => pack.kind === "identity");
