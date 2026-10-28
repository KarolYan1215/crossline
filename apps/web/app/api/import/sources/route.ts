import { serviceProxy } from "../../../../lib/service-proxy";
import { writeGuard } from "../../agent/guard";

/**
 * Connects Todoist, TickTick or a Notion database by the token the person made: the worker reads once and keeps the token in its secret
 * store, never the ledger. A Notion token without a database answers with the databases shared with it.
 */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const text = (key: string, max: number) => typeof guard.body[key] === "string" ? (guard.body[key] as string).slice(0, max) : "";
  return serviceProxy(guard.ctx, "/v1/import/sources", { method: "POST", timeoutMs: 120_000,
    body: { kind: text("kind", 20), token: text("token", 400), databaseId: text("databaseId", 40), label: text("label", 40) } });
}
