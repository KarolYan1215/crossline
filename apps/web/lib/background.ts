import "server-only";
import { BACKGROUND_BLOCKER, BACKGROUND_KINDS, CHATGPT_EXHAUSTED_SETTING, chatgptExhausted, BACKGROUND_PAUSED, backgroundKindOf, degradedService, engagementTier, pausedKinds, type AccessContext, type BackgroundKind, type Engagement } from "@crossline/core";
import { isPaused, listAgentTasks, setPaused, sponsorshipOf, type CrosslineStore } from "@crossline/db";
import { getStore, readSchedulePreferences } from "./crossline";

/**
 * The background tasks page (docs/review-2026-10-13.md §6.4, like ChatGPT's scheduled-tasks hub): every kind of background work with
 * its last run, this week's tokens and a pause, the tier the person's activity puts it in, and the assistant's runs going on now.
 */
export type BackgroundOverview = {
  /** The person's zone, so the page shows times as their clock reads, not UTC. */
  timeZone: string;
  engagement: { tier: Engagement; lastActiveAt: string | null };
  kinds: Array<{ kind: BackgroundKind; label: string; explained: string; paused: boolean; lastRunAt: string | null; lastOk: boolean | null; weekRuns: number; weekTokens: number;
    /** Of the week's input tokens, the share read from the provider's prompt cache (cheaper than new input); null with no input. */
    weekCacheShare: number | null }>;
  running: Array<{ taskId: string; title: string; startedAt: string }>;
  /** Background work paused for the quota (`BACKGROUND_BLOCKER`): why, until when, and what still works meanwhile. */
  quotaPause?: { message: string; resetsAt?: string; works: string[]; paused: string[] };
  /** The account's own ChatGPT quota is spent and the developer's model carries on until it resets (`CHATGPT_EXHAUSTED_SETTING`). */
  quotaFallback?: { message: string; resetsAt?: string };
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
        weekRuns: usage.reduce((sum, row) => sum + row.runs, 0), weekTokens: usage.reduce((sum, row) => sum + row.totalTokens, 0),
        weekCacheShare: cacheShare(usage) };
    }),
    running: listAgentTasks(store, ctx.workspaceId).filter((task) => task.status === "running")
      .map((task) => ({ taskId: task.taskId, title: task.title, startedAt: task.requestedAt })),
    ...quotaPauseOf(store.getSetting(ctx.workspaceId, BACKGROUND_BLOCKER)),
    ...quotaFallbackOf(store, ctx.workspaceId, now)
  };
}

/**
 * While the account's ChatGPT quota is spent and the developer's model stands in (the worker's mark), and nothing is paused for the
 * quota: the person is told the work goes on and when ChatGPT comes back. A pause (the developer's month also spent) says that instead.
 */
export function quotaFallbackOf(store: CrosslineStore, workspaceId: string, now = new Date()): { quotaFallback?: NonNullable<BackgroundOverview["quotaFallback"]> } {
  const mark = chatgptExhausted(store.getSetting(workspaceId, CHATGPT_EXHAUSTED_SETTING), now);
  if (!mark || !sponsorshipOf(store, workspaceId) || quotaPauseOf(store.getSetting(workspaceId, BACKGROUND_BLOCKER)).quotaPause) return {};
  return { quotaFallback: { message: "ChatGPT 额度已用尽，已改用开发者提供的模型继续；网页搜索、生成图片等开发者模型做不了的事等额度恢复后再做。",
    ...(mark.until ? { resetsAt: mark.until } : {}) } };
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

/**
 * How much of a kind's input came from the provider's prompt cache: a cached token costs a fraction of a new one, so the same token total
 * can mean very different quota (docs/task-preparation.md §4). Null when the kind read nothing this week.
 */
export function cacheShare(rows: ReadonlyArray<{ inputTokens: number; cachedInputTokens: number }>): number | null {
  const input = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  return input > 0 ? rows.reduce((sum, row) => sum + row.cachedInputTokens, 0) / input : null;
}

function quotaPauseOf(raw: string | undefined): { quotaPause?: NonNullable<BackgroundOverview["quotaPause"]> } {
  if (!raw) return {};
  try {
    const blocker = JSON.parse(raw) as { code?: string; message?: string; resetsAt?: string; reason?: string };
    if (!blocker.code || blocker.reason === "CODEX_SUPERVISOR_UNAVAILABLE") return {};
    const { works, paused } = degradedService(blocker.code);
    return { quotaPause: { message: blocker.message ?? "后台自动工作已暂停", ...(blocker.resetsAt ? { resetsAt: blocker.resetsAt } : {}), works, paused } };
  } catch { return {}; }
}
