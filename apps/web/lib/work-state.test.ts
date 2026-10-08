import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { ACTIVITY_DETAIL_CONSENT, loadCurrentPlan, saveSchedulePreferences } from "./crossline";
import { activityItems, currentWorkState } from "./timeline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const NOW = "2026-10-02T15:00:00.000Z";
const feed = (store: CrosslineStore, fromMinutesAgo: number, toMinutesAgo: number, app: string, category: string) => {
  for (let m = fromMinutesAgo; m > toMinutesAgo; m -= 1) {
    store.recordActivityReading({ workspaceId: TEST_CTX.workspaceId, at: new Date(Date.parse(NOW) - m * 60_000).toISOString(), intervalSeconds: 60, app, title: "secret title", category, idle: false });
  }
};

test("without the detailed consent there is no work state and no activity blocks, whatever is stored", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW);
  feed(store, 15, 0, "Code.exe", "coding");
  expect(currentWorkState(TEST_CTX, await loadCurrentPlan(TEST_CTX))).toBeUndefined();
  expect(activityItems(TEST_CTX, "America/Chicago", new Date(NOW))).toEqual([]);
});

test("with consent, fifteen minutes of coding reads as focus, and the day gets one merged block that carries no title", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW);
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" }], importance: {} });
  store.setSetting(TEST_CTX.workspaceId, ACTIVITY_DETAIL_CONSENT, "granted");
  feed(store, 15, 0, "Code.exe", "coding");
  const state = currentWorkState(TEST_CTX, await loadCurrentPlan(TEST_CTX));
  expect(state).toMatchObject({ state: "focused", label: "专注" });
  const items = activityItems(TEST_CTX, "America/Chicago", new Date(NOW));
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "activity", title: "编程", start: "09:45", end: "10:00" });
  expect(JSON.stringify([state, items])).not.toContain("secret title");
});

import { currentMilestoneLabel } from "./crossline";

test("a line's card names an approved milestone, the earliest due; with only drafts it says so, never a draft's title", () => {
  const milestones = [
    { id: "a", identityId: "research", status: "archived", title: "老的示例" },
    { id: "b", identityId: "research", status: "draft", title: "草稿一" },
    { id: "c", identityId: "research", status: "draft", title: "草稿二" },
    { id: "d", identityId: "startup", status: "approved", title: "晚的" },
    { id: "e", identityId: "startup", status: "approved", title: "早的" }
  ];
  const deadlines = new Map([["d", "2026-11-30"], ["e", "2026-10-18"]]);
  expect(currentMilestoneLabel(milestones, deadlines, "research")).toBe("2 个里程碑草稿待批准");
  expect(currentMilestoneLabel(milestones, deadlines, "startup")).toBe("早的");
  expect(currentMilestoneLabel(milestones, deadlines, "media")).toBe("等待批准里程碑");
});
