import { resolveAccessContext } from "../../../lib/access-guard";
import { serviceProxy } from "../../../lib/service-proxy";

/** The connected mailboxes (no passwords) and what sorting did lately (docs/personal-agent.md). */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return serviceProxy(access.ctx, "/v1/mail");
}
