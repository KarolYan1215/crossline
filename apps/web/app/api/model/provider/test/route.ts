import { NextResponse } from "next/server";
import { tOf } from "../../../../../lib/locale";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../../lib/access-guard";

export const runtime = "nodejs";

/** Starts the conformance check for this account's model connection; answered at once, the card follows its progress. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try { return NextResponse.json(await requestCodexSupervisor(access.ctx, "/v1/model/provider/test", { method: "POST" }), { status: 202 }); }
  catch (error) {
    const known = error instanceof CodexSupervisorRequestError ? error
      : new CodexSupervisorRequestError(503, { code: "CODEX_SUPERVISOR_UNAVAILABLE", message: tOf(access.ctx)("后台服务没有连上，稍后再试。") });
    return NextResponse.json({ blocker: known.blocker }, { status: known.status });
  }
}
