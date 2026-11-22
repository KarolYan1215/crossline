import { afterEach, expect, test, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("../../../lib/codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { DELETE, GET, POST } from "./route";
import { issueMcpToken, listMcpTokens, resetMcpRateLimits } from "../../../lib/mcp/tokens";
import { TEST_CTX } from "../../../lib/test-support";

/**
 * The MCP endpoint as a host sees it (docs/mcp-server.md §3): the SDK's own client, over Streamable HTTP, against the route handlers.
 * Both a 2026-07-28 client (`auto` negotiation) and a 2025-era one (the SDK's default) reach the same tools.
 */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; resetMcpRateLimits(); vi.unstubAllEnvs(); });

const URL_ = "http://localhost:3210/api/mcp";
const NOW = "2026-11-05T15:00:00.000Z";
const estimate = { p25Minutes: 60, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };

let CTX = TEST_CTX;
function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  // A real account: a token stands for the account's owner.
  const { principal, workspace } = store.createPrincipalWithWorkspace("owner", "个人");
  CTX = { ...TEST_CTX, principalId: principal.id, workspaceId: workspace.id };
  const ws = CTX.workspaceId, owner = CTX.principalId;
  const order = (id: string, intent: string, due: string, state: "active" | "approved") => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research",
    projectId: "ece555", milestoneId: "", intent, state, riskTier: "routine", estimate, payload: { dueDate: due } });
  order("hw3", "完成 ECE 555 作业 3", "2026-11-02", "active");
  order("hw4", "完成 ECE 555 作业 4", "2026-11-07", "approved");
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "batch", type: "dates.extracted", entityId: "batch", payload: { dates: [{ project: "ece555", kind: "homework_due" }] } });
  return store;
}

function token(scope: "read" | "write", label = "Claude Code") {
  const made = issueMcpToken(CTX, { label, scope });
  if (!made.ok) throw new Error(made.code);
  return made.token;
}

/** fetch → the route's handlers, as Next would call them. */
const routeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  return request.method === "POST" ? POST(request) : request.method === "DELETE" ? DELETE(request) : GET(request);
};

async function connect(bearer: string, mode: "auto" | "legacy") {
  const client = new Client({ name: "test-host", version: "1.0.0" }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), { fetch: routeFetch, requestInit: { headers: { Authorization: `Bearer ${bearer}` } } });
  await client.connect(transport);
  return client;
}

const data = (result: unknown) => (result as { structuredContent: Record<string, unknown> }).structuredContent;

test.each(["auto", "legacy"] as const)("a %s client runs all four kinds of operation", async (mode) => {
  const store = setup();
  const client = await connect(token("write"), mode);
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual(["crossline_answer_ask", "crossline_capture", "crossline_complete", "crossline_list_asks", "crossline_list_tasks", "crossline_today"]);
  expect(tools.find((tool) => tool.name === "crossline_today")!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  expect(tools.find((tool) => tool.name === "crossline_answer_ask")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });

  // 1. Today.
  const today = data(await client.callTool({ name: "crossline_today", arguments: {} }));
  expect(today).toMatchObject({ day: "2026-11-05", dueWithin3Days: [expect.objectContaining({ workOrderId: "hw4" })] });

  // 2. Capture.
  const captured = data(await client.callTool({ name: "crossline_capture", arguments: { text: "问导师要数据" } }));
  expect(store.listCaptures(CTX.workspaceId).some((capture) => capture.id === captured.captureId)).toBe(true);

  // 3. Answer an ask.
  const { asks } = data(await client.callTool({ name: "crossline_list_asks", arguments: {} })) as { asks: Array<{ id: string; options: Array<{ id: string }> }> };
  const overdue = asks.find((ask) => ask.id.includes("hw3"))!;
  const answered = await client.callTool({ name: "crossline_answer_ask", arguments: { askId: overdue.id, optionIds: ["extend"], values: { date: "2026-11-09" } } });
  expect(answered.isError).toBeFalsy();
  expect(store.getWorkOrder(CTX.workspaceId, "hw3")!.payload).toMatchObject({ dueDate: "2026-11-09" });

  // 4. Record completion.
  const done = await client.callTool({ name: "crossline_complete", arguments: { workOrderId: "hw4", outcome: "done" } });
  expect(done.isError).toBeFalsy();
  expect(store.getWorkOrder(CTX.workspaceId, "hw4")!.state).not.toBe("approved");

  // A refusal comes back as a tool error the agent can read, not a protocol failure.
  const refused = await client.callTool({ name: "crossline_complete", arguments: { workOrderId: "hw4", outcome: "partial" } });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("NOTE_REQUIRED");
  // What it read is kept on the token for the settings card (tool and time only); writes are in 最近操作 instead.
  expect(listMcpTokens(CTX.workspaceId)[0]!.reads!.map((read) => read.tool)).toEqual(["crossline_today", "crossline_list_asks"]);
  await client.close();
});

test("a read-only token sees and can call only the reading tools", async () => {
  setup();
  const client = await connect(token("read", "ChatGPT"), "auto");
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual(["crossline_list_asks", "crossline_list_tasks", "crossline_today"]);
  const write = await client.callTool({ name: "crossline_capture", arguments: { text: "x" } }).catch((error: unknown) => ({ isError: true, error }));
  expect((write as { isError?: boolean }).isError).toBe(true);
  await client.close();
});

test("no token, a wrong token or another site's page: refused before any tool runs", async () => {
  setup();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const none = await POST(new Request(URL_, { method: "POST", headers, body }));
  expect(none.status).toBe(401);
  expect(none.headers.get("www-authenticate")).toMatch(/^Bearer /);
  const wrong = await POST(new Request(URL_, { method: "POST", headers: { ...headers, authorization: `Bearer cl_mcp_${"x".repeat(43)}` }, body }));
  expect(wrong.status).toBe(401);
  const crossSite = await POST(new Request(URL_, { method: "POST", headers: { ...headers, authorization: `Bearer ${token("write")}`, origin: "https://evil.example" }, body }));
  expect(crossSite.status).toBe(403);
});
