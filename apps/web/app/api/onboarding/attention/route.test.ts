import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" }, authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const beat = async (body: unknown) => (await import("./route")).POST(new Request("http://127.0.0.1/api/onboarding/attention",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

test("beats add attention time on the server's clock, and only a bounded input age is accepted", async () => {
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
  expect((await beat({ inputAgoMs: 1000 })).status).toBe(200);
  vi.setSystemTime(new Date("2026-10-12T10:00:15Z"));
  expect((await beat({ inputAgoMs: 1000 })).status).toBe(200);
  expect(JSON.parse(store.getSetting(TEST_CTX.workspaceId, "onboarding.attention")!)).toMatchObject({ seconds: 15 });
  expect((await beat({ inputAgoMs: -1 })).status).toBe(400);
  expect((await beat({ inputAgoMs: "1" })).status).toBe(400);
  expect((await beat({ inputAgoMs: 700_000 })).status).toBe(400);
// The route's first import is cold (the whole web lib graph); under a loaded full run it alone passed the 5 s default.
}, 30_000);
