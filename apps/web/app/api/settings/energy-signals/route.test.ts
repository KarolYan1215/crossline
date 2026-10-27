import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "local-owner", workspaceId: "personal-crossline", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "local-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
const ws = TEST_CTX.workspaceId;
const post = async (body: unknown) => (await import("./route")).POST(new Request("http://127.0.0.1:3210/api/settings/energy-signals",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

test("手机健康数据 is switched like the other signals: off deletes the phone's record and its token, and GET says whether it is on", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(ws, "health.token.sha256", "0".repeat(64));
  store.setSetting(ws, "health.daily", JSON.stringify([{ day: "2026-10-19", steps: 5000 }]));
  const { GET } = await import("./route");
  expect(await (await GET(new Request("http://127.0.0.1:3210/api/settings/energy-signals"))).json()).toMatchObject({ phoneHealth: true });
  expect((await post({ signal: "phone_health", on: false })).status).toBe(200);
  expect(store.getSetting(ws, "health.phone")).toBe("denied");
  expect(store.getSetting(ws, "health.daily")).toBeUndefined();
  expect(store.getSetting(ws, "health.token.sha256")).toBeUndefined();
  expect(await (await GET(new Request("http://127.0.0.1:3210/api/settings/energy-signals"))).json()).toMatchObject({ phoneHealth: false });
  expect((await post({ signal: "phone_health", on: true })).status).toBe(200);
  expect(store.getSetting(ws, "health.phone")).toBe("granted");
  expect((await post({ signal: "phone", on: true })).status).toBe(400);
});
