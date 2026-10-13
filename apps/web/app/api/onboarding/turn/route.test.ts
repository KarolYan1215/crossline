import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" }, authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));
const supervisor = vi.hoisted(() => vi.fn(async () => ({ state: "asked", sessionId: "s1" })));
vi.mock("../../../../lib/codex-runtime", () => ({ requestCodexSupervisor: supervisor, CodexSupervisorRequestError: class extends Error {} }));
const sendPush = vi.hoisted(() => vi.fn(async () => ({ sent: 1, gone: 0, failed: 0 })));
vi.mock("../../../../lib/push", () => ({ sendPush }));

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; sendPush.mockClear(); });

const turn = async () => (await import("./route")).POST(new Request("http://127.0.0.1/api/onboarding/turn",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s1", text: "好的" }) }));

test("a round that lands while no page has been visible for a while calls the person back to the interview", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(TEST_CTX.workspaceId, "presence.visibleAt", new Date(Date.now() - 5 * 60_000).toISOString());
  expect((await turn()).status).toBe(200);
  expect(sendPush).toHaveBeenCalledWith(TEST_CTX, expect.objectContaining({ title: "访谈下一轮已就绪", path: "/onboarding" }));
});

test("no call back while the page is in front", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(TEST_CTX.workspaceId, "presence.visibleAt", new Date(Date.now() - 30_000).toISOString());
  expect((await turn()).status).toBe(200);
  expect(sendPush).not.toHaveBeenCalled();
});
