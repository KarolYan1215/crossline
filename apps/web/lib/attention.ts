import "server-only";
import { writeMeasuredCapacity } from "./measured-capacity";
import { autoCloseFinished } from "./auto-close";
import { getStore } from "./crossline";
import { recordScheduledToday } from "./schedule-memory";
import { countPending } from "./pending";
import { writeAttentionSnapshot } from "./asks";
import { systemContext } from "./auto-publish";
import { adoptPendingDates } from "./imported-dates";
import { yieldToRequests } from "./yield";

/** How often the web refreshes what the worker's notifications read. */
export const ATTENTION_INTERVAL_MS = 10 * 60_000;

/**
 * Writes each workspace's open asks and pending count where the worker's notifications read them, and records what today's plan
 * placed. The asks are built here, where the forecast and the plan live; the worker only delivers. A workspace that fails is skipped.
 * A batch of dates still waiting is adopted first: since 2026-10-19 what the files say is taken, not asked, but only the interview page
 * adopted, so a batch read before that day by an account past its interview waited on 待确认 for good (one from 10-15 on the real account).
 */
export async function attentionPass(now = new Date()): Promise<number> {
  const store = getStore();
  let written = 0;
  for (const workspace of store.listWorkspaces()) {
    const ownerId = store.getWorkspaceOwnerId(workspace.id);
    if (!ownerId) continue;
    const ctx = systemContext(workspace.id, ownerId, now);
    // Each step is synchronous work of up to seconds on a big account: requests are answered between them (lib/yield.ts).
    await yieldToRequests();
    try { adoptPendingDates(ctx); } catch { /* left for the interview page */ }
    await yieldToRequests();
    try { await recordScheduledToday(ctx, now); } catch { /* the asks still go out */ }
    await yieldToRequests();
    try { writeAttentionSnapshot(ctx, countPending(ctx).total, now); written += 1; } catch { /* next interval */ }
    // Tasks whose person's part is done hand themselves in (docs/plans/closed-loop-1030.md §3).
    try { autoCloseFinished(ctx, now); } catch { /* next interval */ }
    // The measured pace, for the worker's date moves and preparation windows (docs/plans/closed-loop-1030.md §1).
    try { writeMeasuredCapacity(ctx, now); } catch { /* next interval */ }
  }
  return written;
}
