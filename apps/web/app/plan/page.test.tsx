import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "owner-1", workspaceId: "workspace-1", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "owner-1" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));

describe("plan page", () => {
  // Found while working through the onboarding critique: the page used to render nothing but a setup
  // form until this form was filled in, which stacked a mandatory step onto the very first visit. A
  // person should be able to see a real (if unconfirmed) preview immediately.
  test("shows a real preview before any schedule preferences are saved, not a blocking setup form", async () => {
    const store = new CrosslineStore(":memory:");
    globalThis.crosslineStore = store;
    const { default: PlanPage } = await import("./page");
    const html = renderToStaticMarkup(await PlanPage());
    expect(html).toContain("计划");
    // Default hours are flagged on the capacity chart, and the week editor is right there; nothing blocks the preview.
    expect(html).toContain("默认时段");
    expect(html).toContain("每周可用时段");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);

  // The real account: the interview recorded 「所有事情合计每周约 72 小时」 but the pattern was still the 39-hour default.
  test("when the person said they have far more hours than the pattern holds, the capacity chart shows both and flags it", async () => {
    const store = new CrosslineStore(":memory:");
    globalThis.crosslineStore = store;
    store.upsertProfileFact({ workspaceId: "workspace-1", identityId: "research", projectId: "p", slot: "weekly_hours", updatedAt: "2026-10-01T00:00:00Z",
      value: "无法按项目拆分；所有事情合计每周约 72 小时。", status: "confirmed", sourceRef: "reply-1", sourceQuote: "72 小时" });
    const { default: PlanPage } = await import("./page");
    const html = renderToStaticMarkup(await PlanPage());
    expect(html).toContain("画像所述每周投入 72 小时");
    expect(html).toContain("可用时段每周 39 小时");
    expect(html).toContain("可用时段不足");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);

  test("the default-hours flag disappears once real preferences are saved", async () => {
    const store = new CrosslineStore(":memory:");
    globalThis.crosslineStore = store;
    const { saveSchedulePreferences, ensureSeeded } = await import("../../lib/crossline");
    ensureSeeded(TEST_CTX);
    expect(saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered",
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" }],
      importance: { "research-starter": "important", "startup-starter": "ordinary",
        "media-starter": "ordinary", "investment-starter": "ordinary" } })).toEqual({ ok: true });
    const { default: PlanPage } = await import("./page");
    const html = renderToStaticMarkup(await PlanPage());
    expect(html).not.toContain("默认时段");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);
});
