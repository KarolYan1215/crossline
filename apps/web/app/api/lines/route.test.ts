import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { LINE_SETTING } from "@crossline/identity-packs";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" }, authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const call = async (method: "GET" | "POST", body?: unknown) => {
  const route = await import("./route");
  const request = new Request("http://127.0.0.1/api/lines", { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return method === "GET" ? route.GET(request) : route.POST(request);
};

test("goalParts adopts a goal built from attributes: validated, composed into goals[0], returned by GET, undoable", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(TEST_CTX.workspaceId, LINE_SETTING, JSON.stringify([{ id: "line-media", label: "创作者", color: "media", goal: "", goals: [], createdAt: "" }]));
  const saved = await call("POST", { id: "line-media", goalParts: ["科普", "有影响力"] });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ ok: true, op: { label: "修改长期目标：创作者" } });
  const lines = await (await call("GET")).json() as { lines: Array<{ id: string; goals: string[]; goalParts: string[] }> };
  expect(lines.lines[0]).toMatchObject({ goals: ["成为科普的、有影响力的创作者"], goalParts: ["科普", "有影响力"] });

  const overlapping = await call("POST", { id: "line-media", goalParts: ["科普", "科普视频"] });
  expect(overlapping.status).toBe(400);
  expect(await overlapping.json()).toMatchObject({ ok: false, code: "LINE_GOAL_PARTS_DUPLICATE", message: "「科普」与「科普视频」重复" });
  expect((await call("POST", { id: "line-media", goalParts: "科普" })).status).toBe(400);
  expect((await call("POST", { id: "line-media", goalParts: [] })).status).toBe(400);
});
