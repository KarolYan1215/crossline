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
    // One index, every module under it, nothing developer-facing.
    for (const section of ["通用", "时间与提醒", "自动化与助手", "日历与连接", "隐私与屏幕活动", "用量与体检"]) expect(html).toContain(section);
    expect(html).toContain("模型用量");
    expect(html).toContain("近 7 天没有模型调用");
    expect(html).not.toMatch(/CROSSLINE_|CODEX_HOME|sidecar|pnpm |scripts\//);
    // The 系统体检 card renders from an empty ledger without inventing numbers.
    expect(html).toContain("系统体检");
    expect(html).toContain("尚无计时完成的任务");
    // Each assistant capability is on or off (2026-10-15): results take effect by default, only what needs the person is reviewed.
    expect(html).toContain("助手做完的结果默认直接生效");
    expect(html).not.toContain("逐次审阅");
    // Every card in a long module is one click from the index, and each connection has its tutorial beside its button (2026-10-21).
    for (const anchor of ["#phone", "#mail", "#calendar-subscriptions", "#model", "#energy"]) {
      expect(html).toContain(`href="${anchor}"`);
      expect(html).toContain(`id="${anchor.slice(1)}"`);
    }
    expect(html.indexOf('id="st-calendar"')).toBeLessThan(html.indexOf('id="st-notify"'));
    for (const guide of ["接入教程：各家邮箱的授权码与服务器", "接入教程：手机健康数据", "接入教程：Siri「记一下」", "接入教程：各日历的订阅链接"]) expect(html).toContain(guide);
    // The Skill library is read after the page is shown (`SkillLibraryLoader`, 2026-10-28); its folded summary is tested in skill-library.test.tsx.
    expect(html).toContain('id="skills"');
    expect(html).toContain("正在读取…");
    expect(html).not.toContain("Skill 库概览");
    globalThis.crosslineStore.close();
    globalThis.crosslineStore = undefined;
  }, 20000);

  test("shows model use by function as a chart, without model names", async () => {
    const store = new CrosslineStore(":memory:");
    globalThis.crosslineStore = store;
    store.saveModelUsage({ workspaceId: TEST_CTX.workspaceId, skill: "crossline:crossline-onboarding", tier: "top", model: "gpt-5.6-sol", effort: "medium",
      spendMode: "normal", threadId: "t", ok: true, errorCode: "", repairs: 1, turns: 2, inputTokens: 12_000, cachedInputTokens: 0, outputTokens: 3_000,
      reasoningTokens: 500, totalTokens: 15_000, durationMs: 420_000, at: new Date().toISOString() });
    const { default: SettingsPage } = await import("./page");
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain("访谈");
    expect(html).not.toContain("gpt-5.6-sol");
    expect(html).toContain("15k tokens");
    expect(html).toContain("最长 420 秒");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);
});
