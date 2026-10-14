import "server-only";
import { BACKGROUND_KINDS, BACKGROUND_PAUSED, backgroundKindOf, engagementTier, pausedKinds, type AccessContext, type BackgroundKind, type Engagement } from "@crossline/core";
import { isPaused, listAgentTasks, setPaused } from "@crossline/db";
import { getStore, readSchedulePreferences } from "./crossline";

/**
 * The background tasks page (docs/review-2026-10-13.md §6.4, like ChatGPT's scheduled-tasks hub): every kind of background work with
 * its last run, this week's tokens and a pause, the tier the person's activity puts it in, and the assistant's runs going on now.
 */
export type BackgroundOverview = {
  /** The person's zone, so the page shows times as their clock reads, not UTC. */
  timeZone: string;
  engagement: { tier: Engagement; lastActiveAt: string | null };
  kinds: Array<{ kind: BackgroundKind; label: string; explained: string; paused: boolean; lastRunAt: string | null; lastOk: boolean | null; weekRuns: number; weekTokens: number }>;
  running: Array<{ taskId: string; title: string; startedAt: string }>;
};

export function backgroundOverview(ctx: AccessContext, now = new Date()): BackgroundOverview {
  const store = getStore();
  const lastActiveAt = store.lastPersonActivity(ctx.workspaceId) ?? null;
  const since = store.listWorkspaces().find((workspace) => workspace.id === ctx.workspaceId)?.createdAt;
  const paused = pausedKinds(store.getSetting(ctx.workspaceId, BACKGROUND_PAUSED));
  const week = store.summarizeModelUsage(ctx.workspaceId, new Date(now.getTime() - 7 * 86_400_000).toISOString());
  const last = store.lastModelRuns(ctx.workspaceId);
  return {
    timeZone: readSchedulePreferences(ctx)?.timeZone ?? process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago",
    engagement: { tier: engagementTier(lastActiveAt ?? undefined, now, since), lastActiveAt },
    kinds: BACKGROUND_KINDS.map(({ kind, label, explained }) => {
      const runs = last.filter((row) => backgroundKindOf(row.skill) === kind).sort((a, b) => b.at.localeCompare(a.at));
      const usage = week.filter((row) => backgroundKindOf(row.skill) === kind);
      return { kind, label, explained, paused: kind === "assistant" ? isPaused(store, ctx.workspaceId) : paused.has(kind),
        lastRunAt: runs[0]?.at ?? null, lastOk: runs[0] ? runs[0].ok : null,
        weekRuns: usage.reduce((sum, row) => sum + row.runs, 0), weekTokens: usage.reduce((sum, row) => sum + row.totalTokens, 0) };
    }),
    running: listAgentTasks(store, ctx.workspaceId).filter((task) => task.status === "running")
      .map((task) => ({ taskId: task.taskId, title: task.title, startedAt: task.requestedAt }))
  };
}

/** Pauses or resumes one kind; the assistant's pause is its own setting, shared with 设置 → 自动化与助手. */
export function setBackgroundPaused(ctx: AccessContext, kind: BackgroundKind, paused: boolean): { ok: true } | { ok: false; code: string } {
  if (!BACKGROUND_KINDS.some((entry) => entry.kind === kind)) return { ok: false, code: "BACKGROUND_KIND_UNKNOWN" };
  const store = getStore();
  if (kind === "assistant") { setPaused(store, ctx.workspaceId, paused); return { ok: true }; }
  const current = pausedKinds(store.getSetting(ctx.workspaceId, BACKGROUND_PAUSED));
  if (paused) current.add(kind); else current.delete(kind);
  store.setSetting(ctx.workspaceId, BACKGROUND_PAUSED, JSON.stringify([...current]));
  return { ok: true };
}
