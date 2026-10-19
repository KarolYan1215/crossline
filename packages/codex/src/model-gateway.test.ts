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

const ok = (response: import("node:http").ServerResponse) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(sse([{ choices: [{ delta: { content: "{}" }, finish_reason: "stop" }] }]));
};
const busy = (response: import("node:http").ServerResponse, status = 429) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "System is too busy now, 满载" } }));
};
const post = (url: string, skill: string, model = "m-main") => fetch(`${url}/responses`, { method: "POST",
  headers: { "content-type": "application/json", ...(skill ? { "x-crossline-skill": skill } : {}) }, body: JSON.stringify({ model, input: [] }) });

test("a background request refused for load waits and tries the same model again; nobody sees the refusal", async () => {
  let refusals = 2;
  const provider = await upstream((_seen, response) => { if (refusals-- > 0) busy(response); else ok(response); });
  const events: Array<Record<string, unknown>> = [];
  const started = await startModelGateway({ resolve: () => ({ kind: "chat", baseUrl: provider.base, key: "k", fallback: () => ["m-other"] }),
    backoffMs: [10, 10, 10], quickRetryMs: 10, log: (event) => events.push(event) });
  closers.push(started.close);
  const answer = await post(started.urlFor("ws", "sponsor"), "crossline:crossline-step-planner");
  expect(await answer.text()).toContain("response.completed");
  // Three requests, all to the same model: background work is not moved to another (dearer) model.
  expect(provider.seen.map((seen) => seen.body.model)).toEqual(["m-main", "m-main", "m-main"]);
  expect(events.map((event) => event.action)).toEqual(["retry", "retry"]);
});

test("a person's request refused for load is tried once more, then on the next model that passed this Skill's checks", async () => {
  const provider = await upstream((seen, response) => { if (seen.body.model === "m-main") busy(response, 503); else ok(response); });
  const events: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const started = await startModelGateway({ resolve: () => ({ kind: "chat", baseUrl: provider.base, key: "k",
    fallback: (skill, model) => { asked.push(`${skill}|${model}`); return ["m-main", "m-backup"]; } }),
    backoffMs: [10], quickRetryMs: 10, log: (event) => events.push(event) });
  closers.push(started.close);
  const answer = await post(started.urlFor("ws", "sponsor"), "crossline:crossline-onboarding");
  expect(await answer.text()).toContain("response.completed");
  expect(provider.seen.map((seen) => seen.body.model)).toEqual(["m-main", "m-main", "m-backup"]);
  expect(asked).toEqual(["crossline:crossline-onboarding|m-main"]);
  expect(events.map((event) => event.action)).toEqual(["retry", "fallback"]);
  // With no other model to go to, the refusal reaches Codex as a rate limit it retries itself.
  const none = await startModelGateway({ resolve: () => ({ kind: "chat", baseUrl: provider.base, key: "k" }), backoffMs: [10], quickRetryMs: 10, log: () => {} });
  closers.push(none.close);
  expect(await (await post(none.urlFor("ws", "sponsor"), "crossline:crossline-concierge")).text()).toMatch(/response.failed/);
});

test("the limit on requests in flight to one model halves on a refusal and grows back with successes", async () => {
  let inFlight = 0, most = 0, refuse = true;
  const provider = await upstream((_seen, response) => {
    inFlight += 1; most = Math.max(most, inFlight);
    if (refuse) { refuse = false; inFlight -= 1; busy(response); return; }
    setTimeout(() => { inFlight -= 1; ok(response); }, 30);
  });
  const started = await startModelGateway({ resolve: () => ({ kind: "chat", baseUrl: provider.base, key: "k" }), initialConcurrency: 4,
    backoffMs: [10, 10], quickRetryMs: 10, log: () => {} });
  closers.push(started.close);
  const url = started.urlFor("ws", "sponsor");
  // The first refusal halves 4 to 2: at most two of the six requests reach the model at once afterwards.
  await post(url, "crossline:crossline-task-titler").then((answer) => answer.text());
  most = 0;
  await Promise.all(Array.from({ length: 6 }, () => post(url, "crossline:crossline-task-titler").then((answer) => answer.text())));
  expect(most).toBeLessThanOrEqual(3);
  expect(most).toBeGreaterThanOrEqual(2);
});
