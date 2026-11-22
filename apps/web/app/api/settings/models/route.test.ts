import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { MODEL_CHOICE_SETTING } from "@crossline/core";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "local-owner", workspaceId: "personal-crossline", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "local-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));
const supervisor = vi.fn();
vi.mock("../../../../lib/codex-runtime", () => ({ requestCodexSupervisor: (...args: unknown[]) => supervisor(...args) }));

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; supervisor.mockReset(); });
const ws = TEST_CTX.workspaceId;
const post = async (body: unknown) => (await import("./route")).POST(new Request("http://127.0.0.1:3210/api/settings/models",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const get = async () => (await (await import("./route")).GET(new Request("http://127.0.0.1:3210/api/settings/models"))).json();

test("a slot is set, cleared back to the route table, and anything else is refused (D19)", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect((await post({ slot: "crossline-onboarding", model: "gpt-5.6-sol", effort: "xhigh" })).status).toBe(200);
  expect((await post({ slot: "*", model: "gpt-5.6-terra" })).status).toBe(200);
  expect(JSON.parse(store.getSetting(ws, MODEL_CHOICE_SETTING)!)).toEqual({ "crossline-onboarding": { model: "gpt-5.6-sol", effort: "xhigh" }, "*": { model: "gpt-5.6-terra" } });
  expect((await post({ slot: "crossline-made-up", model: "gpt-5.6-sol" })).status).toBe(400);
  expect((await post({ slot: "*", model: "gpt-5.6-sol", effort: "ultra" })).status).toBe(400);
  expect((await post({ slot: "*", model: "a model\nwith a paragraph" })).status).toBe(400);
  expect((await post({ slot: "*", model: null })).status).toBe(200);
  expect(JSON.parse(store.getSetting(ws, MODEL_CHOICE_SETTING)!)).toEqual({ "crossline-onboarding": { model: "gpt-5.6-sol", effort: "xhigh" } });
});

test("the list is the account's own catalogue without hidden models, and a worker that cannot answer still gives the choices", async () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  await post({ slot: "crossline-onboarding-extract", model: "gpt-5.6-sol" });
  supervisor.mockResolvedValueOnce({ provider: false, models: [
    { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", efforts: ["low", "high"], defaultEffort: "high", isDefault: false, hidden: false },
    { model: "internal", efforts: [], defaultEffort: "", isDefault: false, hidden: true }] });
  const listed = await get();
  expect(supervisor).toHaveBeenCalledWith(TEST_CTX, "/v1/codex/models", expect.anything());
  expect(listed.models).toEqual([{ model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", efforts: ["low", "high"], defaultEffort: "high", isDefault: false }]);
  supervisor.mockRejectedValueOnce(new Error("worker unreachable"));
  const down = await get();
  expect(down).toMatchObject({ models: [], choices: { "crossline-onboarding-extract": { model: "gpt-5.6-sol" } }, unavailable: "worker unreachable" });
});
