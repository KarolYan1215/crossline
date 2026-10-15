import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" }, authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

afterEach(() => { vi.unstubAllEnvs(); globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("an account whose interview ended but one line's project has no deadline is told so, and can answer 「没有截止」 here", async () => {
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const { seedReadyToStart } = await import("../../../../lib/test-support");
  seedReadyToStart(store, TEST_CTX.workspaceId);
  // The media line's only project loses the person's 「没有截止」.
  store.deleteProfileFact(TEST_CTX.workspaceId, "media", "media-example", "no_deadline");
  store.saveOnboardingSession({ id: "s1", ownerId: "o", workspaceId: TEST_CTX.workspaceId, state: "complete", createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z", coverage: { stage: "details" } });
  store.appendOnboardingMessage({ workspaceId: TEST_CTX.workspaceId, sessionId: "s1", role: "assistant", createdAt: "2026-10-02T00:00:00Z",
    content: { reply: "…", questions: [], nextAction: "ready_for_milestones", stage: "details" } });
  const { GET } = await import("./route");
  const body = await (await GET(new Request("http://127.0.0.1/api/onboarding/state"))).json() as {
    readyToStart: boolean; startMissing: Array<{ id: string; label: string; detail: string; owner: string }>; extraQuestions: Array<{ id: string }> };
  expect(body.readyToStart).toBe(false);
  expect(body.startMissing).toEqual([expect.objectContaining({ id: "line_project:media", owner: "interview" })]);
  expect(body.extraQuestions.map((question) => question.id)).toContain("gap-deadline-media-example");
}, 30_000); // the route imports the whole board (week, timeline, checklist): a cold import alone can pass five seconds on a busy machine
