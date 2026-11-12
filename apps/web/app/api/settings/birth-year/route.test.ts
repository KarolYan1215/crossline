import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "local-owner", workspaceId: "personal-crossline", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "local-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
const ws = TEST_CTX.workspaceId;
const post = async (body: unknown) => (await import("./route")).POST(new Request("http://127.0.0.1:3210/api/settings/birth-year",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

test("the birth year is optional: given it is kept as a plain setting, cleared it is deleted, nonsense is refused", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect((await post({ birthYear: 1996 })).status).toBe(200);
  expect(store.getSetting(ws, "profile.birthYear")).toBe("1996");
  expect((await post({ birthYear: 1890 })).status).toBe(400);
  expect((await post({ birthYear: "1996-05-01" })).status).toBe(400);
  expect(store.getSetting(ws, "profile.birthYear")).toBe("1996");
  expect((await post({ birthYear: null })).status).toBe(200);
  expect(store.getSetting(ws, "profile.birthYear")).toBeUndefined();
});
