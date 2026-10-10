import { resolveAccessContext } from "../../../lib/access-guard";
import { cardChoices, loadConversation } from "../../../lib/conversation";

/** `?day=YYYY-MM-DD` (default today): the one input box's conversation of that day. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const day = new URL(request.url).searchParams.get("day") ?? "";
  // The ids let the box queue a capture offline (the offline queue signs commands with them).
  return Response.json({ ok: true, ownerId: access.ctx.principalId, workspaceId: access.ctx.workspaceId, choices: await cardChoices(access.ctx),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(day) ? loadConversation(access.ctx, day) : loadConversation(access.ctx)) });
}
