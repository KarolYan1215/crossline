import "server-only";
import { getStore } from "./crossline";
import { recordScheduledToday } from "./schedule-memory";
import { countPending } from "./pending";
import { writeAttentionSnapshot } from "./asks";
import { systemContext } from "./auto-publish";

/** How often the web refreshes what the worker's notifications read. */
export const ATTENTION_INTERVAL_MS = 10 * 60_000;

/**
 * Writes each workspace's open asks and pending count where the worker's notifications read them, and records what today's plan
 * placed. The asks are built here, where the forecast and the plan live; the worker only delivers. A workspace that fails is skipped.
 */
export async function attentionPass(now = new Date()): Promise<number> {
  const store = getStore();
  let written = 0;
  for (const workspace of store.listWorkspaces()) {
    const ownerId = store.getWorkspaceOwnerId(workspace.id);
    if (!ownerId) continue;
    const ctx = systemContext(workspace.id, ownerId, now);
    try { await recordScheduledToday(ctx, now); } catch { /* the asks still go out */ }
    try { writeAttentionSnapshot(ctx, countPending(ctx).total, now); written += 1; } catch { /* next interval */ }
  }
  return written;
}
