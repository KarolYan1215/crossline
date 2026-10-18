import { resolveAccessContext } from "../../../lib/access-guard";
import { inviteState } from "../../../lib/invites";

/** The account's invite: whether one can apply, its application, and its month on the developer's model. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json(inviteState(access.ctx));
}
