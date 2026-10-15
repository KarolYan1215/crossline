import { crossSiteWrite, fail, json, lookupBlocked, lookupMissed } from "../../../../../server/security";
import { getResultByToken, requestBeta } from "../../../../../server/store";

type Context = { params: Promise<{ token: string }> };

/**
 * POST /api/results/[resultToken]/beta: the person asks to be invited to the full Crossline app. The invitation goes to the address the
 * result already holds, so nothing new is collected; the request is deleted with the result.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  if (crossSiteWrite(request)) return fail("REJECTED");
  const blocked = lookupBlocked(request);
  if (blocked) return blocked;
  const { token } = await context.params;
  const result = getResultByToken(token);
  if (!result) return lookupMissed(request);
  requestBeta(result.id);
  return json({ ok: true });
}
