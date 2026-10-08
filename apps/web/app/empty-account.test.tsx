import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "owner-1", workspaceId: "workspace-1", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "owner-1" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));

/**
 * A real account starts with no example goals or work on its board. Every page that used to lean on the
 * seeded examples has to render that honestly rather than throw or show a broken shell.
 */
beforeEach(() => {
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  globalThis.crosslineStore = new CrosslineStore(":memory:");
});
afterEach(() => { vi.unstubAllEnvs(); globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const noParams = { searchParams: Promise.resolve({}) };

test.each([
  ["plan", () => import("./plan/page"), {}],
  ["milestones", () => import("./milestones/page"), noParams],
  ["workbench", () => import("./workbench/page"), noParams],
  ["approvals", () => import("./approvals/page"), noParams],
  ["settings", () => import("./settings/page"), {}]
] as const)("the %s page renders on an account with nothing on it", async (_name, load, props) => {
  const { default: Page } = await load();
  const html = renderToStaticMarkup(await (Page as (props: unknown) => Promise<React.ReactElement>)(props));
  expect(html.length).toBeGreaterThan(200);
}, 30000);

test("the old assistant address sends an empty account to 设置 → 自动化与助手", async () => {
  const { default: AssistantPage } = await import("./assistant/page");
  await expect(AssistantPage()).rejects.toMatchObject({ digest: expect.stringContaining("/settings#automation") });
});

test("Today renders once the interview has produced a profile but no goal has been approved yet", async () => {
  globalThis.crosslineStore!.upsertProfileFact({ workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "", slot: "stage",
    value: "博一", status: "confirmed", sourceRef: "reply-1", sourceQuote: "博一", updatedAt: "2026-10-02T00:00:00.000Z" });
  const { default: HomePage } = await import("./page");
  const html = renderToStaticMarkup(await HomePage());
  expect(html.length).toBeGreaterThan(500);
}, 30000);

test("Today sends a workspace nobody has set up to the interview", async () => {
  const { default: HomePage } = await import("./page");
  await expect(HomePage()).rejects.toMatchObject({ digest: expect.stringContaining("/onboarding") });
}, 30000);
