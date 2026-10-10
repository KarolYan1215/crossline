import { resolveAccessContext } from "../../../lib/access-guard";
import { cardChoices, loadConversation } from "../../../lib/conversation";
import { ensureOpener } from "../../../lib/nudges";

/** `?day=YYYY-MM-DD` (default today): the one input box's conversation of that day; `?choices` adds what a card's fields can be changed to. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const day = new URL(request.url).searchParams.get("day") ?? "";
  // The day's first words are said when its conversation is first opened (docs/one-input.md §4.1).
  if (!day) await ensureOpener(access.ctx).catch(() => false);
  // The ids let the box queue a capture offline (the offline queue signs commands with them).
  return Response.json({ ok: true, ownerId: access.ctx.principalId, workspaceId: access.ctx.workspaceId, // The names a card's fields can take cost a full read of the account: only on request (a page's first load), not on every poll.
    ...(new URL(request.url).searchParams.has("choices") ? { choices: await cardChoices(access.ctx) } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(day) ? loadConversation(access.ctx, day) : loadConversation(access.ctx)) });
}
