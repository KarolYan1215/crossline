import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { startModelGateway, type GatewayUpstream } from "./model-gateway";

/**
 * Real sockets on both sides: an upstream on 127.0.0.1 that answers like a provider, and the gateway in front of it. What is checked is
 * what a provider actually receives (path, key, body) and what Codex actually reads back.
 */
type Seen = { path: string; authorization: string | undefined; body: Record<string, unknown> };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function upstream(answer: (seen: Seen, response: import("node:http").ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const entry = { path: request.url ?? "", authorization: request.headers.authorization, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} };
    seen.push(entry);
    answer(entry, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

async function gateway(resolve: (workspaceId: string, providerId: string) => GatewayUpstream | undefined) {
  const started = await startModelGateway({ resolve });
  closers.push(started.close);
  return started;
}

const sse = (chunks: object[]) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

test("chat: the key is added by the gateway, the request translated, and the stream comes back as Responses events", async () => {
  const provider = await upstream((_seen, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse([{ choices: [{ delta: { content: "{\"ok\":" } }] }, { choices: [{ delta: { content: "true}" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }]));
  });
  const gw = await gateway((workspaceId, providerId) => workspaceId === "ws-a" && providerId === "deepseek"
    ? { kind: "chat", baseUrl: provider.base, key: "sk-secret-1234" } : undefined);
  const url = gw.urlFor("ws-a", "deepseek");
  const answer = await fetch(`${url}/responses`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-chat", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }) });
  const text = await answer.text();
  expect(provider.seen[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer sk-secret-1234",
    body: { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] } });
  expect(text).toContain("event: response.created");
  expect(text).toContain("\"text\":\"{\\\"ok\\\":true}\"");
  expect(text).toMatch(/event: response.completed\ndata: .*"total_tokens":12/);
});

test("responses: passed through unchanged to /responses, with the key", async () => {
  const provider = await upstream((_seen, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}\n\n");
  });
  const gw = await gateway(() => ({ kind: "responses", baseUrl: provider.base, key: "or-key" }));
  const body = { model: "openai/gpt", input: [], store: false, stream: true, text: { format: { type: "json_schema" } } };
  const answer = await fetch(`${gw.urlFor("ws", "openrouter")}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(await answer.text()).toContain("response.completed");
  expect(provider.seen[0]).toEqual({ path: "/v1/responses", authorization: "Bearer or-key", body });
});

test("a refused key is a 401 to Codex, an upstream error is a failed response with a code it knows", async () => {
  let status = 401;
  const provider = await upstream((_seen, response) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Insufficient Balance" } })); });
  const gw = await gateway(() => ({ kind: "chat", baseUrl: provider.base, key: "k" }));
  const post = () => fetch(`${gw.urlFor("ws", "p")}/responses`, { method: "POST", body: JSON.stringify({ model: "m", input: [] }) });
  expect((await post()).status).toBe(401);
  status = 402;
  const failed = await post();
  expect(failed.status).toBe(200);
  expect(await failed.text()).toMatch(/response.failed[\s\S]*"code":"insufficient_quota"/);
});

test("routes cannot be guessed or aimed elsewhere: an unknown route, a workspace with no provider, a GET — none reaches an upstream", async () => {
  const provider = await upstream((_seen, response) => { response.end("{}"); });
  const gw = await gateway((workspaceId) => workspaceId === "ws-a" ? { kind: "chat", baseUrl: provider.base } : undefined);
  const port = new URL(gw.urlFor("ws-a", "p")).port;
  expect((await fetch(`http://127.0.0.1:${port}/ws-a/responses`, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await fetch(`${gw.urlFor("ws-b", "p")}/responses`, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await fetch(`${gw.urlFor("ws-a", "p")}/responses`)).status).toBe(405);
  // Same workspace and provider, same route; another workspace, another route.
  expect(gw.urlFor("ws-a", "p")).toBe(gw.urlFor("ws-a", "p"));
  expect(gw.urlFor("ws-a", "p")).not.toBe(gw.urlFor("ws-b", "p"));
  expect(provider.seen).toHaveLength(0);
});
