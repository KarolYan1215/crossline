import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "owner-1", workspaceId: "workspace-1", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "owner-1" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));
// Rendered outside the app router: a line card refreshes itself in place with `router.refresh()` after its interview turn.
vi.mock("next/navigation", async (original) => ({ ...await original<typeof import("next/navigation")>(), useRouter: () => ({ refresh: () => {} }) }));

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
const seedReady = async () => (await import("../lib/test-support")).seedReadyToStart(globalThis.crosslineStore!, TEST_CTX.workspaceId);

const PAGES = [
  ["today", () => import("./page"), undefined],
  ["plan", () => import("./plan/page"), {}],
  ["milestones", () => import("./milestones/page"), noParams],
  ["workbench", () => import("./workbench/page"), noParams],
  ["approvals", () => import("./approvals/page"), noParams]
] as const;
const render = async (load: (typeof PAGES)[number][1], props: unknown) => {
  const { default: Page } = await load();
  return renderToStaticMarkup(await (Page as (props: unknown) => Promise<React.ReactElement>)(props));
};

test.each(PAGES)("空账号打开 %s 页被带回访谈", async (_name, load, props) => {
  await expect(render(load, props)).rejects.toMatchObject({ digest: expect.stringContaining("/onboarding") });
}, 30000);

/** What the old test meant by 「an empty account renders honestly」: one that meets the start standard and has no milestone or work yet. */
test.each(PAGES)("达到可开始标准、还没有里程碑和工作时 %s 页照常渲染", async (_name, load, props) => {
  await seedReady();
  expect((await render(load, props)).length).toBeGreaterThan(200);
}, 30000);

test("the settings page is not gated: it renders on an account with nothing on it", async () => {
  const { default: Page } = await import("./settings/page");
  expect(renderToStaticMarkup(await Page()).length).toBeGreaterThan(200);
}, 30000);

test("the old assistant address sends an account to the interview until it is ready, then to 设置 → 自动化与助手", async () => {
  const { default: AssistantPage } = await import("./assistant/page");
  await expect(AssistantPage()).rejects.toMatchObject({ digest: expect.stringContaining("/onboarding") });
  await seedReady();
  await expect(AssistantPage()).rejects.toMatchObject({ digest: expect.stringContaining("/settings#automation") });
});

test("a profile alone is not enough: with facts but not the start items, Today leads back to the interview", async () => {
  globalThis.crosslineStore!.upsertProfileFact({ workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "", slot: "stage",
    value: "博一", status: "confirmed", sourceRef: "reply-1", sourceQuote: "博一", updatedAt: "2026-10-02T00:00:00.000Z" });
  const { default: HomePage } = await import("./page");
  await expect(HomePage()).rejects.toMatchObject({ digest: expect.stringContaining("/onboarding") });
}, 30000);
