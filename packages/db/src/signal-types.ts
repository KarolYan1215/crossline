/**
 * One stretch of the same window in the foreground. The title is the person's own and stays on this machine: it is not
 * returned by `listActivitySegments`, not exported, and blanked after the retention period. `recentActivityEntries` is the
 * only way to read it, and it exists so the person can see exactly what is kept.
 */
export type StoredActivitySegment = {
  workspaceId: string; start: string; end: string; app: string; category: string; idle: boolean;
};
export type RecentActivityEntry = StoredActivitySegment & { title: string };

/** What one Skill run cost, as the runtime reported it. Kept so "what does this cost me" has an answer. */
export type StoredModelUsage = {
  workspaceId: string; skill: string; tier: string; model: string; effort: string; spendMode: string; threadId: string;
  ok: boolean; errorCode: string; repairs: number; turns: number; inputTokens: number; cachedInputTokens: number;
  outputTokens: number; reasoningTokens: number; totalTokens: number; durationMs: number; at: string;
  /** What the run was for when it is not the Skill's own business (`non_core`); absent reads as ''. */
  purpose?: string;
};
export type ModelUsageSummary = {
  skill: string; model: string; runs: number; failed: number; repairs: number;
  inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number; averageSeconds: number;
  /** The slowest single run in the window — what a time limit has to clear, which an average hides. */
  longestSeconds: number;
};

export type StoredEnergyObservation = {
  id: string; ownerId: string; workspaceId: string;
  source: "self_report" | "execution_history" | "time_pattern" | "local_activity" | "camera_aggregate";
  level: "low" | "medium" | "high" | "uncalibrated";
  confidence: "low" | "medium" | "high";
  aggregate: Record<string, number>;
  observedAt: string;
};
