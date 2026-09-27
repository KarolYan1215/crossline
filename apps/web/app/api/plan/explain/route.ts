import { planToday } from "../../../../lib/crossline";
import { requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";

/**
 * Asks the plan explainer to run now. Answered as soon as the run starts (the Skill takes real time),
 * and the Plan page reads the result back from the `plan.explained` event the worker writes — the same
 * "fire, then read the ledger" shape prepare-materials/milestone-gate already use.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  const today = planToday(ctx);
  await requestCodexSupervisor(ctx, `/v1/plan/${today}/explain`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000)
  }).catch(() => undefined);
  return Response.json({ ok: true });
}
