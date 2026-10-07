import type { CrosslineStore } from "@crossline/db";

/**
 * Who a background job's rows belong to: the workspace's real owner. Every worker job used to stamp its
 * writes with the pre-accounts constant, and the goal backplanner even *filtered* on it — so on a real
 * account (whose owner is a principal UUID) 「从此目标反推步骤」 could never find an approved milestone.
 * `SYSTEM_OWNER_ID` covers only a workspace with no member row (a test store, the retired single-user
 * ledger); it is a label for "written by the system", not an identity anything checks against.
 */
export const SYSTEM_OWNER_ID = "system";

export function ownerOf(store: Pick<CrosslineStore, "getWorkspaceOwnerId">, workspaceId: string): string {
  return store.getWorkspaceOwnerId(workspaceId) ?? SYSTEM_OWNER_ID;
}
