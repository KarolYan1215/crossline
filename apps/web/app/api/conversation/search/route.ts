import { resolveAccessContext } from "../../../../lib/access-guard";
import { searchConversation } from "../../../../lib/conversation";

/** `?q=`: every day's conversation searched for the words (a note jotted in the box lives only there). */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return Response.json({ ok: true, results: q.trim() ? searchConversation(access.ctx, q) : [] });
}
