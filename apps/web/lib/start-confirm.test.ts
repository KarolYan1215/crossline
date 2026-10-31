import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { BRIEF_TIME_SETTING, INTERVIEW_SETTINGS, QUIET_HOURS_SETTING, mergeInterviewSettings, readInterviewSettings } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(), CodexSupervisorRequestError: class extends Error {} }));
import { collectAsks } from "./asks";
import { effectiveSchedulePreferences } from "./crossline";
import { settleInterviewSettings, startSummary } from "./start-confirm";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId;
const refs = { milestones: new Set<string>(), tasks: new Set<string>(), lines: new Set<string>() };
const said = (key: string, value: string, target = "") => ({ key, target, value, quote: "每天 9:40 左右收到当天安排", sourceRef: "reply-22" });

/** What the extraction stores from round 11 of the freelancer evaluation (2026-10-30): the person's own preferences, as settings. */
function seed() {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(ws, INTERVIEW_SETTINGS, JSON.stringify(mergeInterviewSettings([], [said("notify.quietHours", "22:30-09:30"), said("notify.briefTime", "09:40"),
    said("schedule.focusCapMinutes", "60"), said("schedule.deadlineBufferDays", "1"), said("mail.replyDrafts", "off")], "2026-10-30T06:00:00Z", refs)));
  return store;
}

test("the start confirmation lists the interview's settings and applies the ticked ones through the settings page's functions", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-30T15:00:00.000Z");
  const store = seed();
  expect(startSummary(TEST_CTX).settings.map((item) => item.label)).toEqual(["免打扰时段", "晨间简报时间", "单段专注上限", "截止前缓冲", "回复草稿"]);
  const result = await settleInterviewSettings(TEST_CTX, new Set(["mail.replyDrafts|"]));
  expect(result).toEqual({ applied: 4, failed: 0 });
  expect(store.getSetting(ws, QUIET_HOURS_SETTING)).toBe("22:30-09:30");
  expect(store.getSetting(ws, BRIEF_TIME_SETTING)).toBe("09:40");
  const params = effectiveSchedulePreferences(TEST_CTX).preferences.params;
  expect([params?.focusCapMinutes, params?.deadlineBufferDays]).toEqual([60, 1]);
  // The unticked one is declined and the rest applied: none is offered again, and nothing is pending for 待决事项.
  expect(readInterviewSettings(store.getSetting(ws, INTERVIEW_SETTINGS)).map((item) => item.state)).toEqual(["applied", "applied", "applied", "applied", "declined"]);
  expect(startSummary(TEST_CTX).settings).toEqual([]);
});

test("after the start, settings stated later are one decision in 待决事项", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-30T15:00:00.000Z");
  const store = seed();
  store.setSetting(ws, "onboarding.startConfirmed", JSON.stringify({ at: "2026-10-30T07:00:00Z", via: "person" }));
  const ask = collectAsks(TEST_CTX).find((item) => item.kind === "interview_settings");
  expect(ask?.title).toBe("访谈中说到 5 项设置，要应用吗？");
  expect(ask?.why).toContain("免打扰时段：22:30-09:30");
});
