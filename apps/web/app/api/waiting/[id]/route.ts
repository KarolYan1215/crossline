import { NextResponse } from "next/server";
import { answerWaiting } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** The person's answer to 「…到了吗？」: arrived, not yet (with a new day to ask), or no longer waited for. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { kind?: unknown; followUpAt?: unknown } | null;
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return NextResponse.json({ ok: false, code: "WAITING_ITEM_NOT_FOUND" }, { status: 404 });
  const answer = body?.kind === "arrived" ? { kind: "arrived" as const }
    : body?.kind === "cancelled" ? { kind: "cancelled" as const }
    : body?.kind === "deferred" && typeof body.followUpAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.followUpAt)
      ? { kind: "deferred" as const, followUpAt: body.followUpAt } : undefined;
  if (!answer) return NextResponse.json({ ok: false, code: "INVALID_WAITING_ANSWER" }, { status: 400 });
  const result = answerWaiting(access.ctx, id, answer);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "WAITING_ITEM_NOT_FOUND" ? 404 : 409 });
}
