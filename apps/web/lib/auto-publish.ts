import "server-only";
import { createHash } from "node:crypto";
import { requiredApproval, type AccessContext } from "@crossline/core";
import { getStore } from "./crossline";
import { blocksToPublish } from "./calendar-publish";
import { requestCodexSupervisor } from "./codex-runtime";

const LAST_HASH = "calendar.autopublish.hash";
/** How often the web process looks for a changed schedule to publish. */
export const AUTO_PUBLISH_INTERVAL_MS = 10 * 60_000;

/** A system job's context for one workspace: its owner, marked as not a person's request. */
export function systemContext(workspaceId: string, ownerId: string, now: Date): AccessContext {
  return { principalId: ownerId, workspaceId, role: "owner", identity: { provider: "credential", issuer: "crossline-system", subject: ownerId },
    authMethod: "system-job", requestId: `auto-publish:${now.toISOString()}` };
}

/**
 * Keeps the Crossline calendar in step with the approved plan without a click — the person's decision
 * (`write_focus_block` is now `automatic`), and only the boundary of what is written moved: still only the
 * calendar named Crossline, only events this app made and the person has not changed, deletes only in the
 * future, previews never. A run with nothing new to write sends nothing (the blocks' hash is compared first).
 */
export async function autoPublishPass(now = new Date()): Promise<Array<{ workspaceId: string; state: string }>> {
  if (requiredApproval("write_focus_block") !== "automatic") return [];
  const store = getStore();
  const outcomes: Array<{ workspaceId: string; state: string }> = [];
  for (const workspace of store.listWorkspaces()) {
    const ownerId = store.getWorkspaceOwnerId(workspace.id);
    if (!ownerId || !store.getSetting(workspace.id, "calendar.write.account")) continue;
    const ctx = systemContext(workspace.id, ownerId, now);
    try {
      const { approved, blocks } = await blocksToPublish(ctx, now);
      if (!approved) { outcomes.push({ workspaceId: workspace.id, state: "plan_not_approved" }); continue; }
      const hash = createHash("sha256").update(JSON.stringify(blocks)).digest("hex").slice(0, 32);
      if (store.getSetting(workspace.id, LAST_HASH) === hash) { outcomes.push({ workspaceId: workspace.id, state: "unchanged" }); continue; }
      const result = await requestCodexSupervisor<{ state?: string }>(ctx, "/v1/calendar/publish", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks }), signal: AbortSignal.timeout(120_000) });
      if (result.state === "published") store.setSetting(workspace.id, LAST_HASH, hash);
      outcomes.push({ workspaceId: workspace.id, state: result.state ?? "unknown" });
    } catch {
      outcomes.push({ workspaceId: workspace.id, state: "failed" });
    }
  }
  return outcomes;
}
