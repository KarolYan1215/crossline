import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { decideCard } from "../../../../lib/conversation";

/** `{messageId, indexes?, option?, dismiss?, edits?}`: carry out a card's actions (with the fields the person changed), choose a question's option, or dismiss what is left. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { messageId?: unknown; indexes?: unknown; option?: unknown; dismiss?: unknown; edits?: unknown };
  if (typeof body.messageId !== "string" || !body.messageId) return Response.json({ ok: false, code: "CARD_NOT_FOUND" }, { status: 400 });
  const indexes = Array.isArray(body.indexes) ? body.indexes.filter((index): index is number => Number.isInteger(index) && index >= 0 && index < 8) : undefined;
  const rawEdits = body.edits && typeof body.edits === "object" && !Array.isArray(body.edits) ? Object.entries(body.edits as Record<string, unknown>) : [];
  const edits: Record<number, Record<string, unknown>> = Object.fromEntries(rawEdits
    .filter(([key, value]) => /^[0-7]$/.test(key) && value !== null && typeof value === "object" && !Array.isArray(value))) as Record<number, Record<string, unknown>>;
  const result = await decideCard(access.ctx, body.messageId, {
    ...(indexes ? { indexes } : {}), ...(Number.isInteger(body.option) ? { option: body.option as number } : {}), dismiss: body.dismiss === true, ...(rawEdits.length ? { edits } : {}) });
  return Response.json(result, { status: result.ok ? 200 : result.code === "CARD_REVIEWING" ? 409 : 404 });
}
