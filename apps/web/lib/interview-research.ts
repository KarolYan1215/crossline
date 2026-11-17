import type { ResearchThread } from "@crossline/core";
import { getStore } from "./crossline";

/** The interview's research threads (worker `onboarding-research.ts`), as the worker keeps them in the ledger. */
export function readResearchThreads(workspaceId: string, sessionId: string): ResearchThread[] {
  try {
    const value = JSON.parse(getStore().getSetting(workspaceId, `onboarding.research:${sessionId}`) ?? "[]") as unknown;
    return Array.isArray(value) ? value as ResearchThread[] : [];
  } catch { return []; }
}
