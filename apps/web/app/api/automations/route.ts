import { resolveAccessContext } from "../../../lib/access-guard";
import { serviceProxy } from "../../../lib/service-proxy";
import { writeGuard } from "../agent/guard";

/** The person's automations, their recent runs and requests still being designed (docs/personal-agent.md). */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return serviceProxy(access.ctx, "/v1/automations");
}

/** A new automation in words (`{ text, lineId }`): designed by the worker at once, and the person is told when it is ready. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const text = typeof guard.body.text === "string" ? guard.body.text.trim().slice(0, 1000) : "";
  const lineId = typeof guard.body.lineId === "string" ? guard.body.lineId.slice(0, 64) : "";
  return serviceProxy(guard.ctx, "/v1/automations", { method: "POST", body: { text, lineId } });
}
