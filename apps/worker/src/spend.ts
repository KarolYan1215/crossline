import { BACKGROUND_BLOCKER, backgroundSpend, engagementTier, type BackgroundSpend, type CostSignal } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { localeOf } from "./locale";

/**
 * Reads the quota for one workspace's background passes and records the reason when it pauses them, so a paused
 * background is something the person is told about rather than a tick that silently does nothing.
 */
export function createBackgroundSpend(store: CrosslineStore, readCost: (workspaceId: string) => Promise<CostSignal>, now = () => new Date()) {
  return async (workspaceId: string): Promise<BackgroundSpend> => {
    const signal = await readCost(workspaceId).catch((error: unknown): CostSignal =>
      ({ available: false, reason: error instanceof Error ? error.message : String(error) }));
    // Spending follows the person: how recently they did something themselves decides what may run at all.
    const since = store.listWorkspaces().find((workspace) => workspace.id === workspaceId)?.createdAt;
    const spend = { ...backgroundSpend(signal, localeOf(store, workspaceId)), engagement: engagementTier(store.lastPersonActivity(workspaceId), now(), since) };
    const recorded = store.getSetting(workspaceId, BACKGROUND_BLOCKER);
    if (spend.blocker) {
      // Written only when the reason changes, so `at` says since when, not when the tick last looked.
      if (!recorded || JSON.parse(recorded).code !== spend.blocker.code)
        store.setSetting(workspaceId, BACKGROUND_BLOCKER, JSON.stringify({ ...spend.blocker, at: new Date().toISOString() }));
    } else if (recorded) store.setSetting(workspaceId, BACKGROUND_BLOCKER, "");
    return spend;
  };
}
