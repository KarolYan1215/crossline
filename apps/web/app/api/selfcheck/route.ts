import { serviceProxy } from "../../../lib/service-proxy";
import { writeGuard } from "../agent/guard";

/** 系统体检's 「立即自检」: every feature's probe runs now (apps/worker/src/self-check.ts); the answer is each result. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  return serviceProxy(guard.ctx, "/v1/selfcheck/run", { method: "POST", body: {} });
}
