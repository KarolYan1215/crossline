import { crossSiteWrite, fail, json, lookupBlocked, lookupMissed } from "../../../../server/security";
import { deleteResult, getResultByToken } from "../../../../server/store";
import { resultView } from "../../../../server/views";

type Context = { params: Promise<{ token: string }> };

/** GET /api/results/[resultToken]: the person's own result, from the link in their mail. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const blocked = lookupBlocked(request);
  if (blocked) return blocked;
  const { token } = await context.params;
  const result = getResultByToken(token);
  if (!result) return lookupMissed(request);
  return json(resultView(result));
}

/** DELETE /api/results/[resultToken]: the result, its pairs on both sides, its figure and every link to them, at once. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  if (crossSiteWrite(request)) return fail("REJECTED");
  const blocked = lookupBlocked(request);
  if (blocked) return blocked;
  const { token } = await context.params;
  const result = getResultByToken(token);
  if (!result) return lookupMissed(request);
  deleteResult(result.id);
  return json({ ok: true });
}
