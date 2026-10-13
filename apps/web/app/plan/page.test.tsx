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
    const html = renderToStaticMarkup(await PlanPage({}));
    expect(html).toContain("计划");
    // Unconfirmed hours are flagged on the capacity chart (the example account meets the start standard with the interview's proposed
    // hours, so the flag says where they came from), and the week editor is right there; nothing blocks the preview.
    expect(html).toContain("推断时段（访谈）");
    expect(html).toContain("每周可用时段");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);

  // The real account: the interview recorded 「所有事情合计每周约 72 小时」 but the pattern was still the 39-hour default.
  // Since the start standard (2026-10-12) a page opens only once weekly hours are known — proposed by the interview or painted — so the
  // stated weekly hours are compared with the proposal instead of standing in for it.
  test("with no painted week, the interview's proposed hours are used and marked inferred; stated hours beyond them are flagged", async () => {
    const store = new CrosslineStore(":memory:");
    globalThis.crosslineStore = store;
    store.upsertProfileFact({ workspaceId: "workspace-1", identityId: "research", projectId: "p", slot: "weekly_hours", updatedAt: "2026-10-01T00:00:00Z",
      value: "无法按项目拆分；所有事情合计每周约 72 小时。", status: "confirmed", sourceRef: "reply-1", sourceQuote: "72 小时" });
    const { default: PlanPage } = await import("./page");
    const html = renderToStaticMarkup(await PlanPage({}));
    expect(html).toContain("画像所述每周投入 72 小时");
    expect(html).toContain("推断时段（访谈）");
    expect(html).toContain("可用时段不足");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);

  // Decided 2026-10-10: the calendar is on Today only; the plan page is the long view over a horizon, then the schedule's settings.
  test("no calendar: four charts over the chosen horizon, then the settings as three tabs without a separate importance tab", async () => {
    const store = new CrosslineStore(":memory:");
    globalThis.crosslineStore = store;
    const { default: PlanPage } = await import("./page");
    const html = renderToStaticMarkup(await PlanPage({ searchParams: Promise.resolve({ horizon: "4" }) }));
    for (const title of ["容量与需求", "里程碑完成预测", "主线投入：计划 vs 实际", "估时准确度与节律", "排程设置"]) expect(html).toContain(title);
    expect(html).toMatch(/aria-checked="true"[^>]*>4 周</);
    for (const tab of [">可用时段<", ">排程参数<", ">排程依据<"]) expect(html).toContain(tab);
    expect(html).not.toContain(">重要性<");
    // No day / week / month calendar any more, and 「本周已排」 is no longer said twice.
    expect(html).not.toContain("mo-cell");
    expect(html).not.toContain("wk-col");
    expect(html).not.toContain("本周已排");
    // Nothing has been timed on a fresh account: the measured charts say so instead of drawing empty axes.
    expect(html).toContain("尚无实测");
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
    const html = renderToStaticMarkup(await PlanPage({}));
    expect(html).not.toContain("默认时段");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);
});
