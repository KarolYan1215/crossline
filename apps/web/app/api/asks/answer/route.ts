import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { answerAsk } from "../../../../lib/asks";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** The person's answer to one ask: which option, and the follow-up fields that option asked for. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { askId?: unknown; optionId?: unknown; values?: unknown } | null;
  if (typeof body?.askId !== "string" || typeof body.optionId !== "string" || body.askId.length > 300 || body.optionId.length > 40)
    return NextResponse.json({ ok: false, code: "INVALID_ASK_ANSWER" }, { status: 400 });
  const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values as Record<string, unknown> : {};
  const result = await answerAsk(access.ctx, body.askId, body.optionId, values);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "ASK_NOT_FOUND" ? 404 : 409 });
}
