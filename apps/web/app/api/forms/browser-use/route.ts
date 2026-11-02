import { resolveAccessContext } from "../../../../lib/access-guard";
import { serviceProxy } from "../../../../lib/service-proxy";
import { writeGuard } from "../../agent/guard";

/** Whether browser-use, the second fallback form engine, is installed on this computer (docs/opportunity-agent.md §10.7). */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return serviceProxy(access.ctx, "/v1/forms/browser-use");
}

/** The person's download press on 报名资料卡 (`{ consent: true }`): the worker fetches browser-use from PyPI into its own environment. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  if (guard.body.consent !== true) return Response.json({ ok: false, code: "BROWSER_USE_CONSENT_REQUIRED" }, { status: 400 });
  return serviceProxy(guard.ctx, "/v1/forms/browser-use", { method: "POST", body: { consent: true } });
}
