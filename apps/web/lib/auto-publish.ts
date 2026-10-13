import "server-only";
import { createHash } from "node:crypto";
import { CALENDAR_PUBLISH_FAILURE, requiredApproval, type AccessContext } from "@crossline/core";
import { getStore } from "./crossline";
import { blocksToPublish } from "./calendar-publish";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "./codex-runtime";
import { publishFixedEvents } from "./fixed-events";
import { onOptimalWritten } from "./optimal-schedule";

const LAST_HASH = "calendar.autopublish.hash";
/** How often the web process looks for a changed schedule to publish. */
export const AUTO_PUBLISH_INTERVAL_MS = 10 * 60_000;

/** A system job's context for one workspace: its owner, marked as not a person's request. */
export function systemContext(workspaceId: string, ownerId: string, now: Date): AccessContext {
  return { principalId: ownerId, workspaceId, role: "owner", identity: { provider: "credential", issuer: "crossline-system", subject: ownerId },
    authMethod: "system-job", requestId: `auto-publish:${now.toISOString()}` };
}

/**
 * Keeps the Crossline calendar in step with the plan without a click — the person's decision
 * (`write_focus_block` is now `automatic`), and only the boundary of what is written moved: still only the
 * calendar named Crossline, only events this app made and the person has not changed, deletes only in the
 * future, previews never. A run with nothing new to write sends nothing (the blocks' hash is compared first).
 */
function recordFailure(workspaceId: string, failure: { code: string; message: string } | undefined, now: Date): void {
  try { getStore().setSetting(workspaceId, CALENDAR_PUBLISH_FAILURE, failure ? JSON.stringify({ ...failure, at: now.toISOString() }) : ""); }
  catch { /* the publish result is what matters */ }
}

/** Forgets the last published hash, so the next pass publishes even though nothing changed (the person fixed the login). */
export function forgetPublishedHash(workspaceId: string): void {
  getStore().setSetting(workspaceId, LAST_HASH, "");
}

export async function autoPublishPass(now = new Date()): Promise<Array<{ workspaceId: string; state: string }>> {
  if (requiredApproval("write_focus_block") !== "automatic") return [];
  const outcomes: Array<{ workspaceId: string; state: string }> = [];
  for (const workspace of getStore().listWorkspaces()) {
    const state = await publishWorkspace(workspace.id, now);
    if (state) outcomes.push({ workspaceId: workspace.id, state });
  }
  return outcomes;
}

/** One workspace's publish; undefined when it has no writer account. `pending`: the optimal plan is still being solved. */
export async function publishWorkspace(workspaceId: string, now = new Date()): Promise<string | undefined> {
  const store = getStore();
  const ownerId = store.getWorkspaceOwnerId(workspaceId);
  if (!ownerId || !store.getSetting(workspaceId, "calendar.write.account")) return undefined;
  const ctx = systemContext(workspaceId, ownerId, now);
  // The person's fixed events are theirs, not the plan's: published as their own scope.
  await publishFixedEvents(ctx, now).catch(() => undefined);
  try {
    const { blocks, pending } = await blocksToPublish(ctx, now, { waitForOptimal: true });
    if (pending) return "pending";
    const hash = createHash("sha256").update(JSON.stringify(blocks)).digest("hex").slice(0, 32);
    if (store.getSetting(workspaceId, LAST_HASH) === hash) return "unchanged";
    const result = await requestCodexSupervisor<{ state?: string; code?: string; message?: string }>(ctx, "/v1/calendar/publish", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks }), signal: AbortSignal.timeout(120_000) });
    if (result.state === "published") store.setSetting(workspaceId, LAST_HASH, hash);
    // A failure is kept for the person (an ask with what to do), not only returned to a timer that discards it.
    recordFailure(workspaceId, result.state === "published" ? undefined : { code: result.code ?? "CALENDAR_PUBLISH_FAILED", message: result.message ?? "" }, now);
    return result.state ?? "unknown";
  } catch (error) {
    recordFailure(workspaceId, error instanceof CodexSupervisorRequestError ? { code: error.blocker.code, message: error.blocker.message ?? "" }
      : { code: "CALENDAR_PUBLISH_FAILED", message: error instanceof Error ? error.message.slice(0, 200) : "" }, now);
    return "failed";
  }
}

/** The optimal plan is written to the calendar as soon as it is solved, not at the next ten-minute pass. */
export function publishNow(workspaceId: string): Promise<string | undefined> {
  if (requiredApproval("write_focus_block") !== "automatic") return Promise.resolve(undefined);
  return publishWorkspace(workspaceId).catch(() => "failed");
}
onOptimalWritten((workspaceId) => { if (process.env.CROSSLINE_AUTO_PUBLISH !== "off") void publishNow(workspaceId); });
