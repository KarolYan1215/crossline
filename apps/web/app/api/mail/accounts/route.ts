import { serviceProxy } from "../../../../lib/service-proxy";
import { writeGuard } from "../../agent/guard";

/** Connects a mailbox, read-only: the worker signs in once and keeps the app password in its secret store, never the ledger. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const text = (key: string, max: number) => typeof guard.body[key] === "string" ? (guard.body[key] as string).slice(0, max) : "";
  return serviceProxy(guard.ctx, "/v1/mail/accounts", { method: "POST", timeoutMs: 60_000,
    body: { address: text("address", 200), password: text("password", 200), host: text("host", 200), label: text("label", 40),
      ...(typeof guard.body.port === "number" ? { port: guard.body.port } : {}) } });
}
