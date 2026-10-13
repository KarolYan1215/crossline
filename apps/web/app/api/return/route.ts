import { resolveAccessContext } from "../../../lib/access-guard";
import { appNow } from "../../../lib/crossline";
import { answerReturn, dismissReturn, returnDue, type ReturnVerdict } from "../../../lib/return";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { withUndo } from "../../../lib/undo";

const VERDICTS = new Set<ReturnVerdict>(["done", "partial", "rolled", "dropped"]);
const LABEL: Record<ReturnVerdict, string> = { done: "标为完成", partial: "记下部分完成", rolled: "顺延", dropped: "不做了" };

/**
 * The return page's answers (docs/review-2026-10-13.md §6.3): `{action: "answer", orderId, verdict, minutes?, stepIds?}` settles one task
 * in one tap (undoable); `{action: "dismiss"}` skips the page for this absence.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; orderId?: unknown; verdict?: unknown; minutes?: unknown; stepIds?: unknown };
  if (body.action === "dismiss") {
    const due = returnDue(access.ctx, appNow());
    return Response.json(due ? dismissReturn(access.ctx, due.since) : { ok: true });
  }
  const verdict = String(body.verdict ?? "") as ReturnVerdict;
  if (body.action !== "answer" || !VERDICTS.has(verdict) || typeof body.orderId !== "string")
    return Response.json({ ok: false, code: "RETURN_ANSWER_INVALID" }, { status: 400 });
  const minutes = Number(body.minutes);
  const stepIds = Array.isArray(body.stepIds) ? body.stepIds.filter((id): id is string => typeof id === "string") : [];
  const result = await withUndo(access.ctx, LABEL[verdict], () => answerReturn(access.ctx, body.orderId as string, verdict,
    { ...(Number.isFinite(minutes) && minutes > 0 ? { minutes } : {}), ...(stepIds.length ? { stepIds } : {}) }, appNow()));
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
