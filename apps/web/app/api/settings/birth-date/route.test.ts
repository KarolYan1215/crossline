import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "local-owner", workspaceId: "personal-crossline", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "local-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const ws = TEST_CTX.workspaceId;
const post = async (body: unknown) => (await import("./route")).POST(new Request("http://127.0.0.1:3210/api/settings/birth-date",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

test("the birth date is optional: given it is kept as a plain setting and replaces a year kept before, cleared both go, nonsense is refused", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-11-11T12:00:00Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(ws, "profile.birthYear", "1996");
  expect((await post({ birthDate: "1996-05-01" })).status).toBe(200);
  expect(store.getSetting(ws, "profile.birthDate")).toBe("1996-05-01");
  expect(store.getSetting(ws, "profile.birthYear")).toBeUndefined();
  for (const bad of ["1996", 1996, "1996-02-30", "1890-01-01", "2020-01-01"]) expect((await post({ birthDate: bad })).status).toBe(400);
  expect(store.getSetting(ws, "profile.birthDate")).toBe("1996-05-01");
  store.setSetting(ws, "profile.birthYear", "1996");
  expect((await post({ birthDate: null })).status).toBe(200);
  expect(store.getSetting(ws, "profile.birthDate")).toBeUndefined();
  expect(store.getSetting(ws, "profile.birthYear")).toBeUndefined();
});
