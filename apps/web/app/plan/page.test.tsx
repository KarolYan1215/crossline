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
    // The invitation to set real preferences is present, but as a disclosure, not the only content.
    expect(html).toContain("还不是你的真实设置");
    expect(html).toContain("schedule-setup-prompt");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);

  test("the setup invitation disappears once real preferences are saved", async () => {
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
    expect(html).not.toContain("还不是你的真实设置");
    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);
});
