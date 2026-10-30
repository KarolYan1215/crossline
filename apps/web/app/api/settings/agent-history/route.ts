import { NextResponse } from "next/server";
import { setAgentHistory } from "../../../../lib/consents";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** Whether the worker may read when and where the person used Codex and Claude Code (time only). Turning it off forgets the summary. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return NextResponse.json({ ok: false, code: "INVALID_AGENT_HISTORY" }, { status: 400 });
  // This computer's own readings belong to its owner's account only; a guest's device is elsewhere (2026-10-15 walkthrough).
  const result = setAgentHistory(access.ctx, body.on);
  return NextResponse.json(result, { status: result.ok ? 200 : 403 });
}
