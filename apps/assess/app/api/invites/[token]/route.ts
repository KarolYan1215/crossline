import { requestLocale } from "../../../../lib/i18n";
import { json, lookupBlocked, lookupMissed } from "../../../../server/security";
import { getResultByInvite } from "../../../../server/store";
import { inviteView } from "../../../../server/views";

/** GET /api/invites/[inviteToken]: what an invited person sees before taking the test — the inviter's public type, never their email. */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const blocked = lookupBlocked(request);
  if (blocked) return blocked;
  const { token } = await context.params;
  const result = getResultByInvite(token);
  if (!result) return lookupMissed(request);
  return json(inviteView(result, requestLocale(request)));
}
