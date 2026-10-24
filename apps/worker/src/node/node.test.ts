import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CodexRpcBoundary } from "@crossline/codex";
import { nodeCapacity, startNodeAgent, type AppServerLines } from "./agent";
import { loginNodeWithApiKey } from "./control";
import { createNodeHub, type NodeHub, type NodeStatus } from "./hub";
import { codexVersionOf, nodePath, refusal, rewriteParams, underRoots } from "./protocol";
import { publicHttpsOnly, type NodeBrowsers } from "./browser";

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

async function setUp(options: { nodeCodex?: string; allowed?: () => boolean; deadAfterMs?: number; tokenValid?: () => boolean; role?: "device" | "standalone"; browsers?: NodeBrowsers } = {}) {
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
    authenticate: (token) => token === "good-token-0123456789abcdef" && (options.tokenValid?.() ?? true) ? "ws-owner" : undefined,
    allowed: options.allowed ?? (() => true),
    heartbeatMs: 50,
    ...(options.deadAfterMs !== undefined ? { deadAfterMs: options.deadAfterMs } : {}),
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
  const agent = startNodeAgent({ url: `http://127.0.0.1:${hub.port}`, token: "good-token-0123456789abcdef", dir, spawn: runtime.spawn, backoffMs: [60_000], refusedWaitMs: 60_000,
    role: options.role ?? "device", capacity: 3, host: "PC-A", ...(options.browsers ? { browsers: options.browsers } : {}) });
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
  expect(off.agent.status()).toMatchObject({ code: "NODE_NOT_ALLOWED", message: expect.stringContaining("没有开启") });
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

test("a token revoked on the site (解除配对) lets the node go at the next heartbeat, and the node is told why", async () => {
  let valid = true;
  const { agent } = await setUp({ tokenValid: () => valid });
  await until(() => hub!.clientFor("ws-owner"));
  valid = false;
  await until(() => agent.status().state === "refused" ? true : undefined);
  expect(agent.status()).toMatchObject({ code: "NODE_TOKEN_REVOKED", message: expect.stringContaining("令牌已撤销") });
  expect(hub!.clientFor("ws-owner")).toBeUndefined();
});

test("a linked device and the standalone node work at once: both are members, the device ranked first, capacities added", async () => {
  await setUp({ role: "standalone" });
  await until(() => hub!.members("ws-owner").length === 1 ? true : undefined);
  const second = fakeRuntime("0.163.0");
  const device = startNodeAgent({ url: `http://127.0.0.1:${hub!.port}`, token: "good-token-0123456789abcdef", dir: path.join(dir, "second"), spawn: second.spawn,
    backoffMs: [60_000], refusedWaitMs: 60_000, role: "device", capacity: 5, host: "PC-B" });
  try {
    await until(() => hub!.members("ws-owner").length === 2 ? true : undefined);
    expect(hub!.members("ws-owner").map((member) => [member.id, member.capacity, member.priority])).toEqual([["device:PC-B", 5, 2], ["standalone:PC-A", 3, 1]]);
    expect(hub!.capacity("ws-owner")).toBe(8);
    expect(hub!.status("ws-owner")).toMatchObject({ state: "ready", host: "PC-B" });
    expect(hub!.status("ws-owner")?.nodes?.map((node) => [node.role, node.state])).toEqual([["device", "ready"], ["standalone", "ready"]]);
    // The same computer coming back takes its own place, not the other node's.
    const again = fakeRuntime("0.163.0");
    const back = startNodeAgent({ url: `http://127.0.0.1:${hub!.port}`, token: "good-token-0123456789abcdef", dir: path.join(dir, "third"), spawn: again.spawn,
      backoffMs: [60_000], refusedWaitMs: 60_000, role: "device", capacity: 5, host: "PC-B" });
    try {
      await until(() => device.status().code === "NODE_REPLACED" ? true : undefined);
      await until(() => hub!.members("ws-owner").length === 2 ? true : undefined);
      expect(hub!.members("ws-owner").map((member) => member.id)).toEqual(["device:PC-B", "standalone:PC-A"]);
    } finally { back.stop(); }
  } finally { device.stop(); }
});

test("a node that arrives while the server's own runtime is still starting is told to come back soon, not refused for a version", async () => {
  let version = "";
  gatewayServer = createServer(); await new Promise<void>((resolve) => gatewayServer!.listen(0, "127.0.0.1", resolve));
  hub = await createNodeHub({ port: 0, authenticate: () => "ws-owner", allowed: () => true, roots: () => [], gateway: () => undefined,
    serverCodex: () => version, prepare: async () => {}, heartbeatMs: 50 });
  const runtime = fakeRuntime("0.163.0");
  const agent = startNodeAgent({ url: `http://127.0.0.1:${hub.port}`, token: "t".repeat(24), dir, spawn: runtime.spawn, backoffMs: [100], refusedWaitMs: 60_000, role: "device" });
  stopAgent = agent.stop;
  await until(() => agent.status().code === "NODE_SERVER_STARTING" ? true : undefined);
  expect(agent.status().state).toBe("waiting");
  version = "crossline/0.163.0 (Linux)";
  await until(() => hub!.clientFor("ws-owner"));
});

test("a node not heard from within the silence limit is let go and its account's runs go back to the server", async () => {
  const { agent } = await setUp({ deadAfterMs: 1 });
  // Ready or not, with a 1 ms limit it cannot stay: the next beat finds it silent.
  await until(() => agent.status().state === "waiting" ? true : undefined);
  // Each side learns of the close on its own: the hub's record may land a moment after the node's.
  await until(() => hub!.status("ws-owner")?.state === "offline" ? true : undefined);
  expect(hub!.clientFor("ws-owner")).toBeUndefined();
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

test("an OpenAI API key signs the node's Codex in; anything not shaped like one never reaches Codex, and the key is not returned", async () => {
  let spawned = 0;
  const seen: Array<{ method: string; params: unknown }> = [];
  let signedIn = false;
  const spawn = (): AppServerLines => {
    spawned += 1;
    let emit: ((line: string) => void) | undefined;
    return {
      write: (line) => {
        const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
        if (!message.id) return;
        seen.push({ method: message.method!, params: message.params });
        if (message.method === "account/login/start") signedIn = true;
        const result = message.method === "account/read" ? { account: signedIn ? { type: "apiKey" } : null } : {};
        setTimeout(() => emit?.(JSON.stringify({ id: message.id, result })));
      },
      onLine: (handler) => { emit = handler; }, onExit: () => {}, stop: () => {}
    };
  };
  expect(await loginNodeWithApiKey(spawn, "not-a-key")).toMatchObject({ ok: false });
  expect(spawned).toBe(0);
  const key = `sk-${"a".repeat(40)}`;
  const signed = await loginNodeWithApiKey(spawn, key);
  expect(signed).toEqual({ ok: true, account: { type: "apiKey" } });
  expect(JSON.stringify(signed)).not.toContain(key);
  expect(seen.find((item) => item.method === "account/login/start")?.params).toEqual({ type: "apiKey", apiKey: key });
});

test("a node takes as many runs as it has cores (one per GB of memory at most), between 4 and 16, unless the owner set a number", () => {
  const GB = 1024 ** 3;
  expect(nodeCapacity(16, 32 * GB, {})).toBe(16);
  expect(nodeCapacity(32, 64 * GB, {})).toBe(16);
  expect(nodeCapacity(8, 6 * GB, {})).toBe(6);
  expect(nodeCapacity(2, 4 * GB, {})).toBe(4);
  expect(nodeCapacity(16, 32 * GB, { CROSSLINE_NODE_CAPACITY: "10" })).toBe(10);
  expect(nodeCapacity(16, 32 * GB, { CROSSLINE_NODE_CAPACITY: "99" })).toBe(16);
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

test("a node with a browser drives a reader's page for the server: operations in order, a large video back in pieces; one without is not offered", async () => {
  const seen: string[] = [];
  const video = Buffer.alloc(20 * 1_048_576, 7);
  const browsers: NodeBrowsers = { available: true, closeAll: async () => {},
    handle: async (request) => { seen.push(request.op); return request.op === "goto" ? 200 : request.op === "fetchMedia" ? { state: "ok", bytes: video, contentType: "video/mp4" } : null; } };
  await setUp({ browsers });
  const link = await until(() => hub!.browserFor("ws-owner"));
  expect(link.host).toBe("PC-A");
  await link.call({ op: "open", site: "https://www.xiaohongshu.com/explore", capture: ["/feed"] });
  expect(await link.call({ op: "goto", url: "https://www.xiaohongshu.com/explore" })).toBe(200);
  const media = await link.call({ op: "fetchMedia", url: "https://sns-video-bd.xhscdn.com/a.mp4", referer: "x", maxBytes: 1e9 }) as { state: string; bytes: Buffer; contentType: string };
  expect(media).toMatchObject({ state: "ok", contentType: "video/mp4" });
  expect(media.bytes.equals(video)).toBe(true);
  expect(seen).toEqual(["open", "goto", "fetchMedia"]);
});

test("a node without a browser is not offered one", async () => {
  await setUp();
  await until(() => hub!.status("ws-owner")?.state === "ready" ? true : undefined);
  expect(hub!.browserFor("ws-owner")).toBeUndefined();
});

test("a browser on the person's computer goes only to public https names", async () => {
  const allow = publicHttpsOnly(async (host) => host === "inside.example.com" ? ["192.168.1.5"] : ["93.184.216.34"]);
  expect(await allow("https://www.xiaohongshu.com/explore")).toBe(true);
  expect(await allow("http://www.xiaohongshu.com/")).toBe(false);
  expect(await allow("https://127.0.0.1/")).toBe(false);
  expect(await allow("https://localhost/")).toBe(false);
  expect(await allow("https://inside.example.com/")).toBe(false);
  expect(await allow("https://example.com:8443/")).toBe(false);
  expect(await allow("data:image/png;base64,AAAA")).toBe(true);
});
