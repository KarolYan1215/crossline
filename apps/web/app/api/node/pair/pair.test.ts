import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { NODE_COMPUTE_SETTING, NODE_TOKEN_SETTING, RUNTIME_OWNER_SETTING, type AccessContext } from "@crossline/core";
vi.mock("server-only", () => ({}));
const session: { ctx?: AccessContext | undefined } = {};
vi.mock("../../../../lib/access-guard", () => ({
  resolveAccessContext: vi.fn(async () => session.ctx ? { ctx: session.ctx } : { response: Response.json({ ok: false }, { status: 401 }) })
}));
import { resetPairings } from "../../../../lib/node-pairing";
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
  headers: { "x-forwarded-for": address }, body: JSON.stringify({ host: "KAROL-PC" }) }))).json() as Promise<{ ok: boolean; id: string; code: string }>;
const ask = async (id: string) => (await poll(new Request(`https://app.crossline.lol/api/node/pair?id=${id}`))).json() as Promise<{ state: string; token?: string }>;
const type = (code: string) => approve(new Request("https://app.crossline.lol/api/node/pair/approve", { method: "POST", body: JSON.stringify({ code }) }));

test("a node asks for a code with no account, the owner types it, and the node takes its own token once", async () => {
  const started = await begin();
  expect(started.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(await ask(started.id)).toMatchObject({ state: "pending" });
  // Not the runtime owner's account: refused, and the code stays usable.
  expect((await type(started.code)).status).toBe(403);
  store.setSetting(ctx.workspaceId, RUNTIME_OWNER_SETTING, "1");
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

test("a code nobody asked for is refused, codes expire, and one address cannot ask for codes without end", async () => {
  store.setSetting(ctx.workspaceId, RUNTIME_OWNER_SETTING, "1");
  expect((await type("ABCD-EFGH")).status).toBe(404);
  for (let i = 0; i < 12; i += 1) expect((await begin("198.51.100.9")).ok).toBe(true);
  const limited = await start(new Request("https://app.crossline.lol/api/node/pair", { method: "POST", headers: { "x-forwarded-for": "198.51.100.9" }, body: "{}" }));
  expect(limited.status).toBe(429);
  expect((await begin("198.51.100.10")).ok).toBe(true);
  const later = await begin("203.0.113.8");
  vi.useFakeTimers({ now: Date.now() + 11 * 60_000 });
  try { expect(await ask(later.id)).toEqual({ state: "expired" }); expect((await type(later.code)).status).toBe(404); } finally { vi.useRealTimers(); }
});
