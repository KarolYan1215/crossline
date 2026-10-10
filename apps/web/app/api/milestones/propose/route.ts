import { NextResponse } from "next/server";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { recordRedraftRequested } from "../../../../lib/line-cards";

/**
 * Asks the architect Skill for new milestones. Everything it returns lands as a `draft`, so this route
 * can never add something the user is committed to — only something they have to look at. Still gated
 * on origin: draft or not, this spends real Codex quota per call, which another site should not be able
 * to trigger just by being open in another tab.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: unknown = {};
  try { body = await request.json(); } catch { /* an empty request means "look at the whole picture" */ }
  const ask = (body ?? {}) as { request?: unknown; only?: unknown };
  // A line's drafts redone on request: the 主线 card's 「重算」 offer goes away until its goal or facts move again.
  if (Array.isArray(ask.only)) recordRedraftRequested(access.ctx, ask.only.filter((item): item is string => typeof item === "string").slice(0, 8));
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/milestones/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: typeof ask.request === "string" ? ask.request.slice(0, 2000) : "",
        ...(Array.isArray(ask.only) ? { only: ask.only.filter((item): item is string => typeof item === "string").slice(0, 8) } : {}) }),
      // The Skill is premium-budget and reaches the web; the supervisor default of 5s would give up
      // long before it answers.
      signal: AbortSignal.timeout(6 * 60 * 60_000)
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
    }
    return NextResponse.json({ ok: false, blocker: { code: "PROPOSAL_FAILED", message: "提议未完成。" } }, { status: 503 });
  }
}
