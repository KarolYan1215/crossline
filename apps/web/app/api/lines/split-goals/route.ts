import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { tOf } from "../../../../lib/locale";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";

/**
 * Splits now, instead of at the next tick, every adopted long-term goal that has no attributes yet (§4.1). The worker runs it and answers
 * at once; each line is split once (a `line.goal_split` event per goal), so calling this again does nothing for a line already split.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try {
    const result = await requestCodexSupervisor<Record<string, unknown>>(access.ctx, "/v1/lines/split-goals", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000)
    });
    return Response.json({ ok: true, ...result }, { status: 202 });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      return Response.json({ ok: false, code: error.blocker.code, message: error.blocker.message }, { status: error.status });
    }
    return Response.json({ ok: false, code: "GOAL_SPLIT_UNAVAILABLE", message: tOf(access.ctx)("后台服务暂不可用，稍后会自动拆分") }, { status: 503 });
  }
}
