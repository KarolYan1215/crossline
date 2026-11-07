import { crossSiteWrite, fail, json, lookupBlocked, lookupMissed } from "../../../../../server/security";
import { forwardBetaRequest } from "../../../../../server/app-invite";
import { getResultByToken, requestBeta } from "../../../../../server/store";

type Context = { params: Promise<{ token: string }> };

/**
 * POST /api/results/[resultToken]/beta: the person asks to be invited to the full Crossline app. The invitation goes to the address the
 * result already holds, so nothing new is collected; the request is deleted with the result. The first time, it is also passed on to the
 * app (`server/app-invite.ts`), which mails the developer the application.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  if (crossSiteWrite(request)) return fail("REJECTED");
  const blocked = lookupBlocked(request);
  if (blocked) return blocked;
  const { token } = await context.params;
  const result = getResultByToken(token);
  if (!result) return lookupMissed(request);
  if (requestBeta(result.id)) await forwardBetaRequest(result);
  return json({ ok: true });
}
