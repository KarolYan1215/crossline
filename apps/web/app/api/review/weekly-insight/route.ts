import { requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";

/** Asks the weekly insight skill to run now, same "fire and read the ledger back" shape as
 * prepare-materials/milestone-gate/plan-explain. Results land as `weekly_review.insight_proposal`
 * events the Review page already reads. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  await requestCodexSupervisor(ctx, "/v1/review/weekly-insight", {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000)
  }).catch(() => undefined);
  return Response.json({ ok: true });
}
