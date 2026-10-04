import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));

describe("settings page", () => {
  // A generous timeout, not a flaky-test workaround: this is the first test in the suite whose module graph
  // pulls in `dexie` (via the `DeviceLeases` card's import of `offline-queue.ts`), and a cold transform of
  // that dependency under full-suite load can run past the 5s default — isolated, it finishes in under 2s.
  test("holds the connections and the model usage, and does not claim measured connector health", async () => {
    globalThis.crosslineStore = new CrosslineStore(":memory:");
    const { default: SettingsPage } = await import("./page");
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).not.toContain("连接器健康");
    expect(html).not.toContain("待授权");
    // Targets nobody has configured are not listed one by one as "not connected": only what can be acted on is shown.
    expect(html).not.toContain("CONNECTOR_NOT_CONFIGURED");
    // Connections are part of this page, and so is what the model calls cost.
    expect(html).toContain("连接与账号");
    expect(html).toContain("模型用量");
    expect(html).toContain("还没有模型调用记录");
    globalThis.crosslineStore.close();
    globalThis.crosslineStore = undefined;
  }, 20000);

  test("shows what each Skill spent once there are runs", async () => {
    const store = new CrosslineStore(":memory:");
    globalThis.crosslineStore = store;
    store.saveModelUsage({ workspaceId: TEST_CTX.workspaceId, skill: "crossline:crossline-onboarding", tier: "top", model: "gpt-5.6-sol", effort: "medium",
      spendMode: "normal", threadId: "t", ok: true, errorCode: "", repairs: 1, turns: 2, inputTokens: 12_000, cachedInputTokens: 0, outputTokens: 3_000,
      reasoningTokens: 500, totalTokens: 15_000, durationMs: 420_000, at: new Date().toISOString() });
    const { default: SettingsPage } = await import("./page");
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain("访谈");
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("12.0k");
    expect(html).toContain("420 秒");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);
});
