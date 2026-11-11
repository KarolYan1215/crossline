import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ONBOARDING_INSIGHTS, readInsightRatings } from "@crossline/core";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" }, authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

afterEach(() => { vi.unstubAllEnvs(); globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const rate = async (body: unknown) => (await import("./route")).POST(new Request("http://127.0.0.1/api/onboarding/insight",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

test("a rating is kept per round, and the receipt's 撤销 (`clear`) takes it back", async () => {
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const seq = store.appendOnboardingMessage({ workspaceId: TEST_CTX.workspaceId, sessionId: "s1", role: "assistant", createdAt: "2026-11-10T00:00:00Z",
    content: { reply: "…", questions: [], stage: "values", insight: { text: "两件事连在一起", refs: [] } } });
  const ratings = () => readInsightRatings(store.getSetting(TEST_CTX.workspaceId, ONBOARDING_INSIGHTS));
  expect((await rate({ sessionId: "s1", seq, verdict: "fits" })).status).toBe(200);
  expect(ratings()[`s1#${seq}`]).toMatchObject({ verdict: "fits", stage: "values" });
  expect((await rate({ sessionId: "s1", seq, verdict: "clear" })).status).toBe(200);
  expect(ratings()[`s1#${seq}`]).toBeUndefined();
  expect((await rate({ sessionId: "s1", seq, verdict: "maybe" })).status).toBe(400);
// Cold import of the web lib graph, as in the other route tests.
}, 30_000);
