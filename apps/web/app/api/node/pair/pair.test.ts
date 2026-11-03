import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { NODE_COMPUTE_SETTING, NODE_TOKEN_SETTING, type AccessContext } from "@crossline/core";
vi.mock("server-only", () => ({}));
const session: { ctx?: AccessContext | undefined } = {};
vi.mock("../../../../lib/access-guard", () => ({
  resolveAccessContext: vi.fn(async () => session.ctx ? { ctx: session.ctx } : { response: Response.json({ ok: false }, { status: 401 }) })
}));
import { addressKey, resetPairings } from "../../../../lib/node-pairing";
import { TEST_CTX } from "../../../../lib/test-support";
import { GET as computeStatus } from "../../device/compute/route";
import { POST as approve } from "./approve/route";
import { DELETE as unpair, GET as poll, POST as start } from "./route";

let data: string;
let store: CrosslineStore;
let ctx: AccessContext;
beforeEach(() => {
  data = mkdtempSync(path.join(tmpdir(), "crossline-pair-"));
  vi.stubEnv("CROSSLINE_DATA_DIR", data);
  store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const { workspace } = store.createPrincipalWithWorkspace("hosted-owner", "个人");
  ctx = { ...TEST_CTX, workspaceId: workspace.id, principalId: store.getWorkspaceOwnerId(workspace.id)! };
  session.ctx = ctx;
  resetPairings();
});
afterEach(() => { store.close(); globalThis.crosslineStore = undefined; session.ctx = undefined; vi.unstubAllEnvs(); rmSync(data, { recursive: true, force: true }); });

const begin = async (address = "203.0.113.7") => (await start(new Request("https://app.crossline.lol/api/node/pair", { method: "POST",
  headers: { "x-forwarded-for": address }, body: JSON.stringify({ host: "KAROL-PC", os: "Windows 10.0.26200", version: "1.2.0", shell: true }) }))).json() as Promise<{ ok: boolean; id: string; code: string }>;
const ask = async (id: string) => (await poll(new Request(`https://app.crossline.lol/api/node/pair?id=${id}`))).json() as Promise<{ state: string; token?: string }>;
const type = (code: string, confirm = true) => approve(new Request("https://app.crossline.lol/api/node/pair/approve", { method: "POST", body: JSON.stringify({ code, confirm }) }));

test("a node asks for a code with no account, any account types it for itself, and the node takes its own token once", async () => {
  const started = await begin();
  expect(started.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(await ask(started.id)).toMatchObject({ state: "pending" });
  // Scheme C: an account that is not the runtime owner pairs its own computer; the token is this workspace's alone.
  // Typed in lower case without the dash is the same code.
  const typed = await type(started.code.replace("-", "").toLowerCase());
  expect(await typed.json()).toMatchObject({ ok: true, host: "KAROL-PC" });
  const answer = await ask(started.id);
  expect(answer.state).toBe("approved");
  expect(store.getSetting(ctx.workspaceId, NODE_TOKEN_SETTING)).toBe(createHash("sha256").update(answer.token!).digest("hex"));
  // Pairing is the yes to running the account's model work; the card shows the computer.
  expect(store.getSetting(ctx.workspaceId, NODE_COMPUTE_SETTING)).toBe("on");
  expect(await (await computeStatus(new Request("https://app.crossline.lol/api/device/compute"))).json()).toMatchObject({ paired: { host: "KAROL-PC" } });
  // Handed over once.
  expect(await ask(started.id)).toEqual({ state: "expired" });
  // 解除配对 removes the node's token.
  await unpair(new Request("https://app.crossline.lol/api/node/pair", { method: "DELETE" }));
  expect(store.getSetting(ctx.workspaceId, NODE_TOKEN_SETTING)).toBeUndefined();
});

test("typing a code first shows what that computer says it is and what it will receive, and binds nothing until confirmed", async () => {
  const started = await begin();
  const shown = await type(started.code, false);
  expect(shown.status).toBe(200);
  const body = await shown.json() as { ok: boolean; paired: boolean; computer: object; receives: string[] };
  expect(body).toMatchObject({ ok: true, paired: false, computer: { host: "KAROL-PC", os: "Windows 10.0.26200", version: "1.2.0", shell: true } });
  // All of the account's model runs, copies of the assistant's inputs, and (its switch being on) the shell.
  expect(body.receives).toHaveLength(3);
  expect(body.receives.join("")).toContain("执行命令");
  expect(store.getSetting(ctx.workspaceId, NODE_TOKEN_SETTING)).toBeUndefined();
  expect(await ask(started.id)).toMatchObject({ state: "pending" });
  expect(await (await type(started.code)).json()).toMatchObject({ ok: true, paired: true, host: "KAROL-PC" });
  expect((await ask(started.id)).state).toBe("approved");
});

test("an account that types ten wrong codes in an hour is stopped, even on a right one, and other accounts are not", async () => {
  const started = await begin();
  for (let i = 0; i < 10; i += 1) expect((await type(`ZZZZ-ZZ${"23456789ABCDEFGH"[i]}${"23456789ABCDEFGH"[i]}`, false)).status).toBe(404);
  const stopped = await type(started.code, false);
  expect(stopped.status).toBe(429);
  expect(await stopped.json()).toMatchObject({ ok: false, code: "NODE_PAIR_LIMIT" });
  const other = store.createPrincipalWithWorkspace("someone-else", "别人").workspace;
  session.ctx = { ...ctx, workspaceId: other.id, principalId: store.getWorkspaceOwnerId(other.id)! };
  expect((await type(started.code, false)).status).toBe(200);
  vi.useFakeTimers({ now: Date.now() + 61 * 60_000 });
  session.ctx = ctx;
  try { expect((await type("ZZZZ-ZZZZ", false)).status).toBe(404); } finally { vi.useRealTimers(); }
});

test("a code nobody asked for is refused, codes expire, and one address cannot ask for codes without end", async () => {
  expect((await type("ABCD-EFGH")).status).toBe(404);
  for (let i = 0; i < 12; i += 1) expect((await begin("198.51.100.9")).ok).toBe(true);
  const limited = await start(new Request("https://app.crossline.lol/api/node/pair", { method: "POST", headers: { "x-forwarded-for": "198.51.100.9" }, body: "{}" }));
  expect(limited.status).toBe(429);
  expect((await begin("198.51.100.10")).ok).toBe(true);
  const later = await begin("203.0.113.8");
  vi.useFakeTimers({ now: Date.now() + 11 * 60_000 });
  try { expect(await ask(later.id)).toEqual({ state: "expired" }); expect((await type(later.code)).status).toBe(404); } finally { vi.useRealTimers(); }
});

test("an IPv6 /64 counts as one address, and addresses quiet for an hour are forgotten", async () => {
  expect(addressKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
  expect(addressKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
  expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  expect(addressKey("203.0.113.7")).toBe("203.0.113.7");

  for (let i = 0; i < 12; i += 1) expect((await begin(`2001:db8:1:2::${(i + 1).toString(16)}`)).ok).toBe(true);
  expect((await begin("2001:db8:1:2:9999::1")).ok).toBe(false);
  expect((await begin("2001:db8:1:3::1")).ok).toBe(true);

  const starts = (globalThis as { crosslineNodePairStarts?: Map<string, number[]> }).crosslineNodePairStarts!;
  expect(starts.size).toBe(2);
  vi.useFakeTimers({ now: Date.now() + 61 * 60_000 });
  try {
    expect((await begin("198.51.100.20")).ok).toBe(true);
    expect([...starts.keys()]).toEqual(["198.51.100.20"]);
  } finally { vi.useRealTimers(); }
});
