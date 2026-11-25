import { serviceProxy } from "../../../lib/service-proxy";
import { writeGuard } from "../agent/guard";

/**
 * A saved website login for registration forms (docs/plans/harness-1125.md §5): host, username and password go to the worker, which
 * keeps the last two in its secret store only and answers with the host; nothing is kept or echoed here. The worker refuses
 * (`LOGIN_VAULT_LOCAL_ONLY`) anywhere but the machine owner's own computer with a screen — never on the hosted server.
 */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
  return serviceProxy(guard.ctx, "/v1/apply-logins", { method: "POST",
    body: { host: text(guard.body.host, 300), username: text(guard.body.username, 320), password: text(guard.body.password, 500) } });
}
