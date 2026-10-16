import { retryAvatarIfDue } from "../../../../server/avatar";
import { crossSiteWrite, fail, json, lookupBlocked, lookupMissed } from "../../../../server/security";
import { deleteResult, getResultByToken } from "../../../../server/store";
import { resultView } from "../../../../server/views";

type Context = { params: Promise<{ token: string }> };

/**
 * GET /api/results/[resultToken]: the person's own result, from the link in their mail. A figure that fell back after a passing failure
 * (a timeout, an overload) is queued again here, on the person's own later visit, never on a friend's; the page then waits for it.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const blocked = lookupBlocked(request);
  if (blocked) return blocked;
  const { token } = await context.params;
  const result = getResultByToken(token);
  if (!result) return lookupMissed(request);
  let retried = false;
  try {
    retried = retryAvatarIfDue(result);
  } catch (error) {
    console.warn(JSON.stringify({ event: "assess.avatar_retry_failed", resultId: result.id, error: error instanceof Error ? error.message : String(error) }));
  }
  return json(resultView(retried ? getResultByToken(token) ?? result : result));
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
