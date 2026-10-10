import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { decideCard } from "../../../../lib/conversation";

/** `{messageId, indexes?, option?, dismiss?}`: carry out a card's actions, choose a question's option, or dismiss what is left. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { messageId?: unknown; indexes?: unknown; option?: unknown; dismiss?: unknown };
  if (typeof body.messageId !== "string" || !body.messageId) return Response.json({ ok: false, code: "CARD_NOT_FOUND" }, { status: 400 });
  const indexes = Array.isArray(body.indexes) ? body.indexes.filter((index): index is number => Number.isInteger(index) && index >= 0 && index < 8) : undefined;
  const result = await decideCard(access.ctx, body.messageId, {
    ...(indexes ? { indexes } : {}), ...(Number.isInteger(body.option) ? { option: body.option as number } : {}), dismiss: body.dismiss === true });
  return Response.json(result, { status: result.ok ? 200 : 404 });
}
