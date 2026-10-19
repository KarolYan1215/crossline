import { serviceProxy } from "../../../../lib/service-proxy";
import { writeGuard } from "../../agent/guard";

/** Reads new mail now (and sorts it), instead of at the next quarter hour. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  return serviceProxy(guard.ctx, "/v1/mail/check", { method: "POST", body: {}, timeoutMs: 120_000 });
}
