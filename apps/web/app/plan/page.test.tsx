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

  // Decided 2026-10-10: the calendar is on Today only. Laid out again 2026-10-15: a milestone timeline per line on top, three charts,
  // then the week's hours and energy beside the timed rhythm, the long-term goals, and one advanced fold — no tabs, no importance slider.
  test("no calendar: the timeline, three charts, time and energy, long-term goals and an advanced fold — no tabs and no importance slider", async () => {
    const store = new CrosslineStore(":memory:");
    globalThis.crosslineStore = store;
    const { default: PlanPage } = await import("./page");
    const html = renderToStaticMarkup(await PlanPage({ searchParams: Promise.resolve({ horizon: "4" }) }));
    for (const title of ["里程碑时间轴", "容量与需求", "主线投入：计划 vs 实际", "估时准确度", "时段与精力", "近 8 周实际节律", "排程依据", "高级：排程参数、主线份额与排程顺序"])
      expect(html).toContain(title);
    expect(html).toMatch(/aria-checked="true"[^>]*>4 周</);
    expect(html).not.toContain('aria-label="设置项"');
    expect(html).not.toContain("重要性预设依据");
    expect(html).not.toContain("里程碑完成预测");
    // The day axis of the grid runs to 24.
    expect(html).toMatch(/data-edge="end"[^>]*>24</);
    // No day / week / month calendar any more, and 「本周已排」 is no longer said twice.
    expect(html).not.toContain("mo-cell");
    expect(html).not.toContain("wk-col");
    expect(html).not.toContain("本周已排");
    // Nothing has been timed on a fresh account: the measured charts say so instead of drawing empty axes.
    expect(html).toContain("尚无实测");
    expect(html).toContain("尚无计时记录");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);

  test("this week's energy advice is laid over the grid with its reason, until the person sets it aside", async () => {
    const store = new CrosslineStore(":memory:");
    globalThis.crosslineStore = store;
    const { ensureSeeded } = await import("../../lib/crossline");
    ensureSeeded(TEST_CTX);
    const { ENERGY_ADVICE_SETTING, ENERGY_ADVICE_DISMISSED } = await import("@crossline/core");
    // Every waking half hour advised low: anything the person marked otherwise differs.
    const levels = Array.from({ length: 7 }, () => Array.from({ length: 48 }, (_, slot) => slot >= 16 && slot < 46 ? 1 : 0));
    store.setSetting("workspace-1", ENERGY_ADVICE_SETTING, JSON.stringify({ computedAt: "2026-10-12T10:00:00.000Z", id: "abc12345", levels, ruleLevels: levels,
      summary: "按通用作息与 2 次自评：高精力 无。", basis: ["作息：尚无记录，按通用作息"], evidence: { nights: 0, reports: 2 },
      review: { state: "skipped", summary: "额度偏紧", findings: [], adjustments: [], droppedSources: 0 }, sources: [] }));
    const { default: PlanPage } = await import("./page");
    const html = renderToStaticMarkup(await PlanPage({}));
    expect(html).toContain("本周建议");
    expect(html).toContain("按通用作息与 2 次自评");
    expect(html).toContain('data-advice="1"');
    expect(html).toContain("批准建议并预览");
    // Thin footing is said on the card, and does not stop 批准.
    expect(html).toContain("依据：2 次自评、无睡眠记录，依据偏薄");
    store.setSetting("workspace-1", ENERGY_ADVICE_DISMISSED, "abc12345");
    const after = renderToStaticMarkup(await PlanPage({}));
    expect(after).not.toContain("批准建议并预览");
    expect(after).not.toContain('data-advice="1"');
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
