import { resolveAccessContext } from "../../../lib/access-guard";
import { serviceProxy } from "../../../lib/service-proxy";
import { writeGuard } from "../agent/guard";

/** The registration forms Crossline is filling or filled for the person (docs/opportunity-agent.md §10); machine owner only. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return serviceProxy(access.ctx, "/v1/forms");
}

/** The person's 报名 on an offer card (`{ opportunity, choice, drafts? }`): one form run queued for its registration host. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { opportunity, choice, drafts } = guard.body;
  if (typeof opportunity !== "object" || opportunity === null || (choice !== "register" && choice !== "apply")) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(guard.ctx, "/v1/forms/queue", { method: "POST", body: { opportunity, choice, ...(drafts ? { drafts } : {}) } });
}
