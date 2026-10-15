import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { chatgptAccountOf, isDirectLoopbackRequest, type LocalCodexAccount } from "./codex-local";
import { createCrosslineAuth, migrateCrosslineAuth, requireAccessContext, type CrosslineAuthOptions } from "./index";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "crossline-codex-local-")); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Better Auth keeps its handle open on Windows */ } });

const BASE = "http://127.0.0.1:47210";
async function setup(account: () => LocalCodexAccount | null | undefined) {
  const options: CrosslineAuthOptions = { authDbPath: path.join(dir, "auth.db"), secret: "s".repeat(40), baseURL: BASE,
    trustedOrigins: [BASE], localCodex: { readAccount: async () => account() } };
  await migrateCrosslineAuth(options);
  return createCrosslineAuth(options);
}
const post = (headers: Record<string, string> = {}) => new Request(`${BASE}/api/auth/codex-local/session`,
  { method: "POST", headers: { host: "127.0.0.1:47210", origin: BASE, ...headers } });

test("only a ChatGPT login with an email names the account", () => {
  expect(chatgptAccountOf({ account: { type: "chatgpt", email: "Me@Example.com", planType: "plus" } })).toEqual({ email: "me@example.com", planType: "plus" });
  expect(chatgptAccountOf({ account: { type: "apiKey" } })).toBeNull();
  expect(chatgptAccountOf({ account: null, requiresOpenaiAuth: true })).toBeNull();
  expect(chatgptAccountOf({ account: { type: "chatgpt" } })).toBeNull();
});

test("the session route answers only on the app's own loopback origin, directly", () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  expect(isDirectLoopbackRequest(headers({ host: "127.0.0.1:47210" }), BASE)).toBe(true);
  expect(isDirectLoopbackRequest(headers({ host: "localhost:47210", origin: "http://localhost:47210" }), BASE)).toBe(true);
  // DNS rebinding: a page on another name resolving to 127.0.0.1 carries its own Host.
  expect(isDirectLoopbackRequest(headers({ host: "evil.example:47210" }), BASE)).toBe(false);
  expect(isDirectLoopbackRequest(headers({ host: "127.0.0.1:47210", origin: "https://evil.example" }), BASE)).toBe(false);
  // Through a proxy (tailscale serve, anything forwarding) is not "this machine, directly".
  expect(isDirectLoopbackRequest(headers({ host: "127.0.0.1:47210", "x-forwarded-for": "100.64.0.2" }), BASE)).toBe(false);
  expect(isDirectLoopbackRequest(headers({ host: "127.0.0.1:47210", "x-forwarded-for": "127.0.0.1, 100.64.0.2" }), BASE)).toBe(false);
  expect(isDirectLoopbackRequest(headers({ host: "127.0.0.1:47210", "x-forwarded-host": "crossline.tailnet.ts.net" }), BASE)).toBe(false);
  expect(isDirectLoopbackRequest(headers({ host: "127.0.0.1:47210", forwarded: "for=100.64.0.2" }), BASE)).toBe(false);
  // What Next.js itself adds to a direct request (the socket's peer and the Host) is still direct.
  expect(isDirectLoopbackRequest(headers({ host: "127.0.0.1:47210", "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": "127.0.0.1:47210",
    "x-forwarded-port": "47210", "x-forwarded-proto": "http" }), BASE)).toBe(true);
  expect(isDirectLoopbackRequest(headers({ host: "127.0.0.1:47299" }), BASE)).toBe(false);
  expect(isDirectLoopbackRequest(headers({ host: "crossline.example.com" }), "https://crossline.example.com")).toBe(false);
});

test("Codex signed in to ChatGPT becomes a Crossline session; signed out it does not", async () => {
  let account: LocalCodexAccount | null = null;
  const auth = await setup(() => account);
  const refused = await auth.handler(post());
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe("CODEX_NOT_SIGNED_IN");
  account = { email: "tester@example.com" };
  const ok = await auth.handler(post());
  expect(ok.status).toBe(200);
  // Its own cookie names: a resident app on 127.0.0.1:3210 in the same browser keeps its session (ports do not separate cookies).
  expect(ok.headers.get("set-cookie")).toMatch(/^(__Secure-)?crossline-local\.session_token=/);
  // The same account again is the same user, not a second one.
  const again = await auth.handler(post());
  const session = await auth.api.getSession({ headers: new Headers({ cookie: again.headers.get("set-cookie")!.split(";")[0]! }) });
  const first = await auth.api.getSession({ headers: new Headers({ cookie: ok.headers.get("set-cookie")!.split(";")[0]! }) });
  expect(session?.user.id).toBe(first?.user.id);
  expect(session?.user.email).toBe("tester@example.com");
}, 30_000);

test("a request from anywhere but loopback cannot mint a session, even with Codex signed in", async () => {
  const auth = await setup(() => ({ email: "tester@example.com" }));
  for (const headers of [{ host: "evil.example:47210", origin: "http://evil.example:47210" }, { "x-forwarded-for": "100.64.0.9" }]) {
    const response = await auth.handler(post(headers));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("session_token");
  }
}, 30_000);

test("signing Codex out — or into another account — ends the session; a Codex that cannot be asked does not", async () => {
  let account: LocalCodexAccount | null | undefined = { email: "tester@example.com" };
  const auth = await setup(() => account);
  const store = new CrosslineStore(":memory:");
  try {
    const cookie = (await auth.handler(post())).headers.get("set-cookie")!.split(";")[0]!;
    const request = () => new Request(`${BASE}/`, { headers: { cookie } });
    const check = () => requireAccessContext(auth, store, request(), async () => account);
    expect("ctx" in await check()).toBe(true);
    account = undefined; // restarting: unknown
    expect("ctx" in await check()).toBe(true);
    account = { email: "someone-else@example.com" };
    expect(await check()).toEqual({ error: "UNAUTHENTICATED" });
    // The session row is gone, not merely refused once: Codex coming back as the right account does not revive it.
    account = { email: "tester@example.com" };
    expect(await check()).toEqual({ error: "UNAUTHENTICATED" });
    const fresh = (await auth.handler(post())).headers.get("set-cookie")!.split(";")[0]!;
    account = null;
    expect(await requireAccessContext(auth, store, new Request(`${BASE}/`, { headers: { cookie: fresh } }), async () => account)).toEqual({ error: "UNAUTHENTICATED" });
  } finally { store.close(); }
}, 30_000);
