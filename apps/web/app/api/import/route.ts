import { resolveAccessContext } from "../../../lib/access-guard";
import { serviceProxy } from "../../../lib/service-proxy";

/** The connected tools (no tokens), the batches waiting for the person's confirmation and the lines to file them under (docs/personal-agent.md §9). */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return serviceProxy(access.ctx, "/v1/import");
}
