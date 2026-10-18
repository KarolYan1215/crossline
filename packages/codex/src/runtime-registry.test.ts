import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { markClientBusy } from "./model-gate";
import { createRuntimeRegistry, type RuntimeSidecar } from "./runtime-registry";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "crossline-runtimes-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in app-server: records what it was asked, can fire notifications, and knows whether it was stopped. */
function fakeSidecar(home: string, answers: Record<string, unknown> = {}) {
  const handlers = new Set<(message: Record<string, unknown>) => void>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const sidecar: RuntimeSidecar & { home: string; stopped: boolean; calls: typeof calls; emit: (message: Record<string, unknown>) => void } = {
    home, stopped: false, calls,
    client: { request: async (method: string, params: unknown) => { calls.push({ method, params }); return answers[method] ?? {}; },
      onNotification: (handler) => { handlers.add(handler); return () => handlers.delete(handler); } },
    stop: () => { sidecar.stopped = true; }, onExit: () => () => undefined,
    emit: (message) => { for (const handler of handlers) handler(message); }
  };
  return sidecar;
}
const connect = (home: string) => { mkdirSync(home, { recursive: true }); writeFileSync(path.join(home, "auth.json"), "{}"); };

function setup(extra: { maxRunning?: number; pollMs?: number; maxQueueMs?: number; answers?: Record<string, unknown>; onConnected?: (ws: string) => void } = {}) {
  let clock = 0;
  const owner = fakeSidecar("owner");
  const started: ReturnType<typeof fakeSidecar>[] = [];
  const registry = createRuntimeRegistry({ owner, ownerWorkspaceId: () => "ws-owner", baseDir: dir, now: () => clock,
    ...(extra.maxRunning ? { maxRunning: extra.maxRunning } : {}),
    ...(extra.pollMs !== undefined ? { pollMs: extra.pollMs } : {}), ...(extra.maxQueueMs !== undefined ? { maxQueueMs: extra.maxQueueMs } : {}),
    ...(extra.onConnected ? { onConnected: extra.onConnected } : {}),
    start: async (home) => { const sidecar = fakeSidecar(home, extra.answers); started.push(sidecar); return sidecar; } });
  return { registry, owner, started, advance: (ms: number) => { clock += ms; }, homeOf: (ws: string) => path.join(dir, ws, "codex-home") };
}

test("the owner keeps the machine's runtime; another account never gets it, and is told to connect its own", async () => {
  const { registry, owner, started } = setup();
  expect(await registry.client("ws-owner")).toEqual({ ok: true, client: owner.client });
  expect(await registry.client("ws-guest")).toMatchObject({ ok: false, blocker: { code: "RUNTIME_UNCONNECTED" } });
  expect(registry.current("ws-guest")).toBeUndefined();
  expect(started).toHaveLength(0);
});

test("a connected account gets its own process in its own home, reused while in use and stopped when idle", async () => {
  const { registry, owner, started, advance, homeOf } = setup();
  connect(homeOf("ws-guest"));
  const first = await registry.client("ws-guest");
  expect(first.ok && first.client).not.toBe(owner.client);
  expect(started[0]!.home).toBe(homeOf("ws-guest"));
  expect((await registry.client("ws-guest")).ok).toBe(true);
  expect(started).toHaveLength(1);
  // Events from a long turn count as use: 25 minutes of work with events keeps it alive past 30 minutes from the start.
  advance(25 * 60_000); started[0]!.emit({ method: "item/started" });
  advance(10 * 60_000); registry.stopIdle();
  expect(started[0]!.stopped).toBe(false);
  advance(31 * 60_000); registry.stopIdle();
  expect(started[0]!.stopped).toBe(true);
  expect(registry.current("ws-guest")).toBeUndefined();
});

const handle = (result: Awaited<ReturnType<ReturnType<typeof setup>["registry"]["client"]>>) => {
  if (!result.ok) throw new Error(result.blocker.code);
  return result.client;
};

test("at most N guests run at once: the least recently used idle one makes room, a newcomer waits while all are working", async () => {
  const { registry, started, advance, homeOf } = setup({ maxRunning: 2, pollMs: 5 });
  for (const ws of ["a", "b", "c", "d"]) connect(homeOf(ws));
  await registry.client("a"); advance(120_000);
  const b = handle(await registry.client("b")); advance(120_000);
  const c = handle(await registry.client("c"));
  expect(started[0]!.stopped).toBe(true);
  // b and c both have a run in flight: d waits in line instead of being refused or cutting into someone's run.
  markClientBusy(b, 1); markClientBusy(c, 1);
  let settled = false;
  const d = registry.client("d").then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(settled).toBe(false);
  expect(started[1]!.stopped || started[2]!.stopped).toBe(false);
  // b's run ends and it has been quiet past the grace: d gets b's place.
  markClientBusy(b, -1); advance(20_000);
  expect((await d).ok).toBe(true);
  expect(started[1]!.stopped).toBe(true);
  expect(started[2]!.stopped).toBe(false);
  markClientBusy(c, -1);
});

test("work that held a client while its runtime made room for someone else starts the runtime again on its first request", async () => {
  const { registry, started, advance, homeOf } = setup({ maxRunning: 1, answers: { "thread/start": { thread: { id: "t1" } } } });
  for (const ws of ["a", "b"]) connect(homeOf(ws));
  const a = handle(await registry.client("a"));
  const heard: unknown[] = [];
  a.onNotification((message) => heard.push(message.method));
  advance(60_000);
  await registry.client("b");
  expect(started[0]!.stopped).toBe(true);
  advance(60_000);
  // a's queued run gets its turn: the same client works, on a new process, and its listeners hear the new process.
  expect(await a.request("thread/start", {})).toEqual({ thread: { id: "t1" } });
  expect(started).toHaveLength(3);
  expect(started[1]!.stopped).toBe(true);
  started[2]!.emit({ method: "turn/started" });
  expect(heard).toEqual(["turn/started"]);
});

test("a runtime stuck busy past the longest wait is refused, not waited on forever", async () => {
  const { registry, advance, homeOf } = setup({ maxRunning: 1, maxQueueMs: 0 });
  for (const ws of ["a", "b"]) connect(homeOf(ws));
  const a = handle(await registry.client("a")); advance(60_000);
  markClientBusy(a, 1);
  expect(await registry.client("b")).toMatchObject({ ok: false, blocker: { code: "RUNTIME_LIMIT_REACHED" } });
  markClientBusy(a, -1);
});

test("logging in starts the guest's runtime even before it is connected; device code shows the address and the code", async () => {
  const { registry, started } = setup({ answers: { "account/login/start": { type: "chatgptDeviceCode", loginId: "L1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } } });
  const login = await registry.login("ws-guest", { type: "chatgptDeviceCode" });
  expect(login).toMatchObject({ state: "pending", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
  // An API key is handed to the runtime and not kept: what the registry remembers about that login carries no key.
  const keyed = await registry.login("ws-other", { type: "apiKey", apiKey: "sk-test-SECRET" });
  expect(JSON.stringify([keyed, registry.loginStatus("ws-other")])).not.toContain("SECRET");
  expect(started[0]!.calls).toEqual([{ method: "account/login/start", params: { type: "chatgptDeviceCode" } }]);
  started[0]!.emit({ method: "account/login/completed", params: { loginId: "L1", success: true } });
  expect(registry.loginStatus("ws-guest")?.state).toBe("completed");
});

test("a successful login is announced once, so background work decided without a model is decided again at once", async () => {
  const heard: string[] = [];
  const { registry, started } = setup({ onConnected: (ws) => heard.push(ws),
    answers: { "account/login/start": { type: "chatgptDeviceCode", loginId: "L1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } } });
  await registry.login("ws-guest", { type: "chatgptDeviceCode" });
  expect(heard).toEqual([]);
  started[0]!.emit({ method: "account/login/completed", params: { loginId: "L1", success: false } });
  expect(heard).toEqual([]);
  started[0]!.emit({ method: "account/login/completed", params: { loginId: "L1", success: true } });
  expect(heard).toEqual(["ws-guest"]);
  await registry.login("ws-key", { type: "apiKey", apiKey: "sk-test" });
  expect(heard).toEqual(["ws-guest", "ws-key"]);
});

test("signing a guest out deletes its home — its login and its memories — and never touches the owner", async () => {
  const { registry, owner, homeOf } = setup();
  connect(homeOf("ws-guest"));
  await registry.client("ws-guest");
  await registry.logout("ws-guest");
  expect(existsSync(homeOf("ws-guest"))).toBe(false);
  expect(registry.connected("ws-guest")).toBe(false);
  await registry.logout("ws-owner");
  expect((await registry.client("ws-owner"))).toEqual({ ok: true, client: owner.client });
});

test("a guest with only a model provider of its own gets its own runtime, but does not count as signed in to Codex", async () => {
  const owner = fakeSidecar("owner");
  const registry = createRuntimeRegistry({ owner, ownerWorkspaceId: () => "ws-owner", baseDir: dir, now: () => 0,
    hasProvider: (workspaceId) => workspaceId === "ws-provider", start: async (home) => fakeSidecar(home) });
  expect(registry.connected("ws-provider")).toBe(true);
  expect(registry.signedIn("ws-provider")).toBe(false);
  const runtime = await registry.client("ws-provider");
  expect(runtime.ok && runtime.client).not.toBe(owner.client);
  expect(registry.connected("ws-other")).toBe(false);
  expect(registry.signedIn("ws-owner")).toBe(true);
});
