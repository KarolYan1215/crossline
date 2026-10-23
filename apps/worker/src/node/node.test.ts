import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CodexRpcBoundary } from "@crossline/codex";
import { startNodeAgent, type AppServerLines } from "./agent";
import { createNodeHub, type NodeHub, type NodeStatus } from "./hub";
import { codexVersionOf, nodePath, refusal, rewriteParams, underRoots } from "./protocol";

// Real sockets and a real relay between two ends in one process: under the full suite's load a test can take longer than vitest's 5 s.
vi.setConfig({ testTimeout: 30_000 });

const ROOT = "/srv/repo/skills/marketplace";
const MARKET = `${ROOT}/.agents/plugins/marketplace.json`;

let dir: string;
let hub: NodeHub | undefined;
let stopAgent: (() => void) | undefined;
let gatewayServer: ReturnType<typeof createServer> | undefined;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "crossline-node-")); });
afterEach(async () => {
  stopAgent?.();
  await hub?.close();
  gatewayServer?.close();
  hub = undefined; stopAgent = undefined; gatewayServer = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for `codex app-server`: answers initialize with its version, records every request, answers each with `{ok: true}`. */
function fakeRuntime(version: string) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const answers: Array<Record<string, unknown>> = [];
  let emit: ((line: string) => void) | undefined;
  const spawn = (): AppServerLines => ({
    write: (line) => {
      const message = JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (message.method === "initialize") { setTimeout(() => emit?.(JSON.stringify({ id: message.id, result: { userAgent: `crossline/${version} (Windows)` } }))); return; }
      if (message.method === "initialized") return;
      if (!message.method) { answers.push(message as Record<string, unknown>); return; }
      requests.push({ method: message.method, params: message.params ?? {} });
      setTimeout(() => emit?.(JSON.stringify({ id: message.id, result: { ok: true } })));
    },
    onLine: (handler) => { emit = handler; },
    onExit: () => {},
    stop: () => { emit = undefined; }
  });
  return { spawn, requests, answers, emitLine: (line: string) => emit?.(line) };
}

async function until<T>(read: () => T | undefined, ms = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function setUp(options: { nodeCodex?: string; allowed?: () => boolean } = {}) {
  gatewayServer = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { response.writeHead(200, { "content-type": "text/plain" }); response.write(`gateway ${request.method} ${request.url} `); response.end(body); });
  });
  await new Promise<void>((resolve) => gatewayServer!.listen(0, "127.0.0.1", resolve));
  const gateway = `http://127.0.0.1:${(gatewayServer.address() as { port: number }).port}`;
  const statuses: NodeStatus[] = [];
  hub = await createNodeHub({
    port: 0,
    authenticate: (token) => token === "good-token-0123456789abcdef" ? "ws-owner" : undefined,
    allowed: options.allowed ?? (() => true),
    heartbeatMs: 50,
    roots: () => [ROOT],
    imageRoots: () => ["/srv/data"],
    readFile: (file) => { if (file === "/srv/data/shot.png") return Buffer.from("PNG-BYTES"); throw new Error("ENOENT"); },
    gateway: () => gateway,
    serverCodex: () => "crossline/0.163.0 (Linux)",
    prepare: async (client) => { await client.request("plugin/install", { marketplacePath: MARKET, pluginName: "crossline" }); },
    onStatus: (_ws, status) => statuses.push(status),
    readTree: (requested) => requested === ROOT ? [{ rel: ".agents/plugins/marketplace.json", data: Buffer.from("{\"name\":\"crossline-local\"}") },
      { rel: "plugins/crossline/skills/a/SKILL.md", data: Buffer.from("# a") }] : []
  });
  const runtime = fakeRuntime(options.nodeCodex ?? "0.163.0");
  const agent = startNodeAgent({ url: `http://127.0.0.1:${hub.port}`, token: "good-token-0123456789abcdef", dir, spawn: runtime.spawn, backoffMs: [60_000], refusedWaitMs: 60_000 });
  stopAgent = agent.stop;
  return { runtime, agent, statuses, gateway };
}

test("a connected node is prepared through its own runtime, gets the server's plugin files mirrored, and then serves the owner's runs", async () => {
  const { runtime, statuses, gateway } = await setUp();
  const client = await until(() => hub!.clientFor("ws-owner"));
  expect(statuses.at(-1)).toMatchObject({ state: "ready", codex: "0.163.0" });
  // The plugin's directory was mirrored on the node, and the install pointed at the mirror.
  const install = runtime.requests.find((request) => request.method === "plugin/install")!;
  const mirrored = install.params.marketplacePath as string;
  expect(mirrored).toBe(path.join(dir, "mirror", "srv", "repo", "skills", "marketplace", ".agents", "plugins", "marketplace.json"));
  expect(readFileSync(mirrored, "utf8")).toContain("crossline-local");
  expect(existsSync(path.join(dir, "mirror", "srv", "repo", "skills", "marketplace", "plugins", "crossline", "skills", "a", "SKILL.md"))).toBe(true);

  // A structured run: its working directory becomes the node's own, a provider's base_url the node's relay to the server's gateway.
  await client.request("thread/start", { cwd: "/srv/repo", sandbox: "read-only", config: { "model_providers.sponsor": { base_url: `${gateway}/route-1/v1` } } });
  const start = runtime.requests.find((request) => request.method === "thread/start")!;
  expect(start.params.cwd).toBe(path.join(dir, "work"));
  const baseUrl = (start.params.config as Record<string, { base_url: string }>)["model_providers.sponsor"]!.base_url;
  expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/route-1\/v1$/);
  expect(baseUrl.startsWith(gateway)).toBe(false);
  // The relay carries a request over the connection to the server's gateway and streams the answer back.
  const relayed = await fetch(`${baseUrl}/chat/completions`, { method: "POST", body: "hello" });
  expect(relayed.status).toBe(200);
  expect(await relayed.text()).toBe("gateway POST /route-1/v1/chat/completions hello");

  // The runtime's own requests (a dynamic tool call) reach the server's handler and its answer goes back to the runtime.
  (client as CodexRpcBoundary & { onServerRequest: NonNullable<CodexRpcBoundary["onServerRequest"]> }).onServerRequest(async (method) => ({ answered: method }));
  runtime.emitLine(JSON.stringify({ id: 77, method: "item/tool/call", params: { tool: "read_ledger" } }));
  const answer = await until(() => runtime.answers.find((item) => item.id === 77));
  expect(answer.result).toEqual({ answered: "item/tool/call" });
});

test("a picture a turn hands the model is copied from the server first; one outside the data or not a picture is refused", async () => {
  const { runtime } = await setUp();
  const client = await until(() => hub!.clientFor("ws-owner"));
  await client.request("turn/start", { threadId: "t1", input: [{ type: "text", text: "看图" }, { type: "localImage", path: "/srv/data/shot.png" }] });
  const turn = runtime.requests.find((request) => request.method === "turn/start")!;
  const image = (turn.params.input as Array<{ type: string; path?: string }>)[1]!;
  expect(image.path!.startsWith(path.join(dir, "work", "images"))).toBe(true);
  expect(readFileSync(image.path!, "utf8")).toBe("PNG-BYTES");
  await expect(client.request("turn/start", { threadId: "t1", input: [{ type: "localImage", path: "/etc/shadow.png" }] })).rejects.toThrow(/NODE_PATH_REFUSED/);
  await expect(client.request("turn/start", { threadId: "t1", input: [{ type: "localImage", path: "/srv/data/notes.txt" }] })).rejects.toThrow(/NODE_PATH_REFUSED/);
});

test("the node refuses a shell, full access and any method the runners do not use; the server's run gets the refusal as an error", async () => {
  await setUp();
  const client = await until(() => hub!.clientFor("ws-owner"));
  await expect(client.request("thread/start", { sandbox: "danger-full-access" })).rejects.toThrow(/NODE_SHELL_REFUSED/);
  await expect(client.request("thread/start", { sandbox: "read-only", config: { "features.shell_tool": true } })).rejects.toThrow(/NODE_SHELL_REFUSED/);
  await expect(client.request("command/exec", { command: ["whoami"] })).rejects.toThrow(/NODE_METHOD_REFUSED/);
  await expect(client.request("account/logout", {})).rejects.toThrow(/NODE_METHOD_REFUSED/);
});

test("another Codex version, or a site that has not switched the node on, is refused and nothing is routed to it", async () => {
  const other = await setUp({ nodeCodex: "0.155.0" });
  await until(() => other.statuses.find((status) => status.state === "refused"));
  expect(other.statuses.at(-1)!.message).toContain("0.155.0");
  expect(hub!.clientFor("ws-owner")).toBeUndefined();
  await until(() => other.agent.status().state === "refused" ? true : undefined);
  stopAgent?.(); await hub?.close(); gatewayServer?.close(); hub = undefined;

  const off = await setUp({ allowed: () => false });
  await until(() => off.agent.status().state === "refused" ? true : undefined);
  expect(off.agent.status().message).toContain("没有开启");
  expect(hub!.clientFor("ws-owner")).toBeUndefined();
});

test("switched off on the site, a connected node is let go at the next heartbeat and the owner's runs are the server's again", async () => {
  let on = true;
  const { agent } = await setUp({ allowed: () => on });
  await until(() => hub!.clientFor("ws-owner"));
  on = false;
  await until(() => hub!.clientFor("ws-owner") === undefined ? true : undefined);
  await until(() => agent.status().state === "refused" ? true : undefined);
  expect(hub!.status("ws-owner")).toMatchObject({ state: "refused", message: expect.stringContaining("已关闭") });
});

test("when the node goes away its runs fail at once and later runs go back to the server", async () => {
  const { agent } = await setUp();
  const client = await until(() => hub!.clientFor("ws-owner"));
  const pending = client.request("turn/start", { threadId: "t" }).catch((error: Error) => error.message);
  agent.stop();
  stopAgent = undefined;
  // Whichever came first, the answer or the disconnect: never a hang.
  expect(typeof await pending === "string" || (await pending as unknown) !== undefined).toBe(true);
  await until(() => hub!.clientFor("ws-owner") === undefined ? true : undefined);
  await expect(client.request("turn/start", {})).rejects.toThrow(/CROSSLINE_NODE_DISCONNECTED/);
});

test("paths: only the server's skill roots are mirrored; a run's cwd goes to the node's work directory; a prompt is never touched", () => {
  expect(underRoots(`${ROOT}/x`, [ROOT])).toBe(true);
  expect(underRoots("/srv/repo/../etc/passwd", ["/srv/repo"])).toBe(false);
  expect(underRoots("/etc/passwd", [ROOT])).toBe(false);
  expect(nodePath("/srv/repo", [ROOT], "M", "W")).toBe("W");
  const rewritten = rewriteParams({ cwd: "/srv/repo", input: [{ type: "text", text: `${ROOT}/x` }], cwds: ["/srv/repo"] }, { roots: [ROOT], mirror: "M", work: "W" }) as Record<string, unknown>;
  expect(rewritten.cwd).toBe("W");
  expect(rewritten.cwds).toEqual(["W"]);
  expect((rewritten.input as Array<{ text: string }>)[0]!.text).toBe(`${ROOT}/x`);
  expect(refusal("skills/config/write", {})).toBeUndefined();
  expect(codexVersionOf({ userAgent: "crossline/0.163.0 (Linux; x86_64)" })).toBe("0.163.0");
  expect(readdirSync(dir)).toEqual([]);
});
