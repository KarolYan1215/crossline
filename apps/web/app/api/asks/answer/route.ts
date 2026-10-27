import { NextResponse } from "next/server";
import { ASK_NOTE_MAX, decisionSeconds } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { answerAsk } from "../../../../lib/asks";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * The person's answer to one ask: `{askId, optionIds?, optionId?, values, note?, seconds?}` — the options chosen (several where the ask takes
 * several; the single `optionId` of the original shape still works), the follow-up fields they asked for, the person's own words, and how long the card was on screen before they answered.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { askId?: unknown; optionId?: unknown; optionIds?: unknown; values?: unknown; note?: unknown; seconds?: unknown } | null;
  const optionIds = Array.isArray(body?.optionIds) ? body.optionIds : typeof body?.optionId === "string" ? [body.optionId] : [];
  const note = body?.note === undefined ? "" : body.note;
  if (typeof body?.askId !== "string" || body.askId.length > 300 || optionIds.length > 20
    || optionIds.some((id) => typeof id !== "string" || id.length > 40) || typeof note !== "string" || note.length > ASK_NOTE_MAX)
    return NextResponse.json({ ok: false, code: "INVALID_ASK_ANSWER" }, { status: 400 });
  const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values as Record<string, unknown> : {};
  const seconds = decisionSeconds(body.seconds);
  const result = await answerAsk(access.ctx, body.askId, { optionIds: optionIds as string[], note, ...(seconds === undefined ? {} : { seconds }) }, values);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "ASK_NOT_FOUND" ? 404 : 409 });
}
