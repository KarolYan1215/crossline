import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { answerDraft, answerDraftConsent, type DraftAnswer } from "../../../../lib/time-drafts";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

const ACTIONS = new Set(["confirm", "not_work", "rule"]);

/**
 * 拟计时 on the wrap-up (lib/time-drafts.ts): `{consent: true | false}` answers the one question that turns 「应用与窗口」 on for drafting;
 * `{ids, action: "confirm" | "not_work" | "rule", workOrderId?, stepId?}` answers drafts — 记 (on the drafted or the picked task), 不算工作, or
 * 以后这类都算 X (`rule`, which needs the task). Several ids are the drafts beside one block, recorded together.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { consent?: unknown; ids?: unknown; action?: unknown; workOrderId?: unknown; stepId?: unknown } | null;
  if (typeof body?.consent === "boolean") {
    const result = answerDraftConsent(access.ctx, body.consent);
    return NextResponse.json(result, { status: result.ok ? 200 : 403 });
  }
  const ids = body?.ids;
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200;
  if (!body || !Array.isArray(ids) || !ids.length || ids.length > 20 || !ids.every(text) || !ACTIONS.has(String(body.action))
    || (body.workOrderId !== undefined && !text(body.workOrderId)) || (body.stepId !== undefined && !text(body.stepId))
    || (body.action === "rule" && body.workOrderId === undefined))
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const answer: DraftAnswer = body.action === "not_work" ? { action: "not_work" }
    : body.action === "rule" ? { action: "rule", workOrderId: body.workOrderId as string }
    : { action: "confirm", ...(body.workOrderId ? { workOrderId: body.workOrderId as string } : {}), ...(body.stepId ? { stepId: body.stepId as string } : {}) };
  let minutes = 0;
  for (const id of ids as string[]) {
    const result = answerDraft(access.ctx, id, answer);
    if (!result.ok) return NextResponse.json(result, { status: result.code === "DRAFT_NOT_FOUND" ? 404 : 400 });
    minutes += result.minutes ?? 0;
  }
  return NextResponse.json({ ok: true, minutes });
}
