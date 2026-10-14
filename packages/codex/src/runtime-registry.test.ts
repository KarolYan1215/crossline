import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
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

function setup(extra: { maxRunning?: number; answers?: Record<string, unknown> } = {}) {
  let clock = 0;
  const owner = fakeSidecar("owner");
  const started: ReturnType<typeof fakeSidecar>[] = [];
  const registry = createRuntimeRegistry({ owner, ownerWorkspaceId: () => "ws-owner", baseDir: dir, now: () => clock,
    ...(extra.maxRunning ? { maxRunning: extra.maxRunning } : {}),
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

test("at most N guests run at once: the least recently used idle one makes room, a busy set says so", async () => {
  const { registry, started, advance, homeOf } = setup({ maxRunning: 2 });
  for (const ws of ["a", "b", "c"]) connect(homeOf(ws));
  await registry.client("a"); advance(120_000);
  await registry.client("b"); advance(120_000);
  expect((await registry.client("c")).ok).toBe(true);
  expect(started[0]!.stopped).toBe(true);
  // b and c were both used within the last minute: a fourth waits rather than cutting into someone's run.
  await registry.client("b");
  connect(homeOf("d"));
  expect(await registry.client("d")).toMatchObject({ ok: false, blocker: { code: "RUNTIME_LIMIT_REACHED" } });
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
