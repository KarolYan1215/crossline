import { getStore } from "../../../../../lib/crossline";
import { feedText, workspaceForFeedToken } from "../../../../../lib/calendar-write";
import { systemContext } from "../../../../../lib/auto-publish";

/**
 * The private calendar feed (path a of docs/calendar-write-setup.md, the owner's decision of 2026-11-10): `webcal://<host>/api/calendar/
 * feed/<token>.ics`. No session — a calendar app cannot sign in — so the token is the only key: 32 random bytes, compared in constant time,
 * answered only while the person has the feed on, and replaced (every old link dead) from Settings. It carries only the confirmed fixed
 * events and the work blocks, titled 「主线 · 任务名」, with no notes, places or materials. An unknown token is a plain 404.
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const workspaceId = workspaceForFeedToken(token.replace(/\.ics$/, ""));
  const ownerId = workspaceId ? getStore().getWorkspaceOwnerId(workspaceId) : undefined;
  if (!workspaceId || !ownerId) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const now = new Date();
  const text = await feedText(systemContext(workspaceId, ownerId, now), now);
  return new Response(text, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": "inline; filename=crossline.ics",
    "cache-control": "private, no-store", "x-robots-tag": "noindex" } });
}
