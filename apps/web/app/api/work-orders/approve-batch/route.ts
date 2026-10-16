import { NextResponse } from "next/server";
import { tOf } from "../../../../lib/locale";
import { approveWorkOrderProposals } from "../../../../lib/approvals";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { withUndo } from "../../../../lib/undo";

/** 「全部批准」: approves the listed proposals; any that changed or cannot be approved come back in `skipped`. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { ids?: unknown } | null;
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) {
    return NextResponse.json({ ok: false, code: "INVALID_WORK_ORDER_IDS" }, { status: 400 });
  }
  const result = await withUndo(access.ctx, tOf(access.ctx)("批准 {{count}} 个任务", { count: ids.length }), () => ({ ok: true as const, ...approveWorkOrderProposals(access.ctx, ids as string[]) }));
  return NextResponse.json(result);
}
