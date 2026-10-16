import { requestLocale } from "../../../../lib/i18n";
import { json, lookupBlocked, lookupMissed } from "../../../../server/security";
import { getPairByToken, getResultById } from "../../../../server/store";
import { pairView } from "../../../../server/views";

/** GET /api/pairs/[pairToken]: the two people's card. Gone as soon as either of them deletes their result. */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const blocked = lookupBlocked(request);
  if (blocked) return blocked;
  const { token } = await context.params;
  const pair = getPairByToken(token);
  const a = pair && getResultById(pair.inviterId);
  const b = pair && getResultById(pair.inviteeId);
  if (!pair || !a || !b) return lookupMissed(request);
  return json(pairView(pair, a, b, requestLocale(request)));
}
