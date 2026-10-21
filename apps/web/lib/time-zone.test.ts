import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { effectiveSchedulePreferences, planToday, saveScheduleParams, syncDeviceTimeZone } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const NOW = new Date("2026-10-21T03:14:00.000Z");

test("the device's zone replaces the server's default, including one a schedule save had copied into the preferences", () => {
  vi.stubEnv("CROSSLINE_TIME_ZONE", "Asia/Shanghai");
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  // Saving a packing number used to freeze the server's zone into the saved preferences.
  saveScheduleParams(TEST_CTX, { gapMinutes: 10 });
  expect(effectiveSchedulePreferences(TEST_CTX).preferences.timeZone).toBe("Asia/Shanghai");
  expect(planToday(TEST_CTX, NOW)).toBe("2026-10-21");

  expect(syncDeviceTimeZone(TEST_CTX, "America/Chicago")).toEqual({ ok: true, changed: true });
  expect(effectiveSchedulePreferences(TEST_CTX)).toMatchObject({ isDefault: false, preferences: { timeZone: "America/Chicago" } });
  // 03:14 UTC is still the evening before in Chicago.
  expect(planToday(TEST_CTX, NOW)).toBe("2026-10-20");
  // The other preferences stay, and the same zone again changes nothing.
  expect(effectiveSchedulePreferences(TEST_CTX).preferences.params?.gapMinutes).toBe(10);
  expect(syncDeviceTimeZone(TEST_CTX, "America/Chicago")).toEqual({ ok: true, changed: false });
  expect(globalThis.crosslineStore.listEvents(TEST_CTX.workspaceId, { type: "schedule.time_zone_detected" })).toHaveLength(1);
});

test("an account with no preferences yet gets them, with the device's zone; nonsense is refused", () => {
  vi.stubEnv("CROSSLINE_TIME_ZONE", "Asia/Shanghai");
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(syncDeviceTimeZone(TEST_CTX, "Mars/Olympus")).toEqual({ ok: false, code: "SCHEDULE_TIME_ZONE_INVALID" });
  expect(syncDeviceTimeZone(TEST_CTX, 42)).toEqual({ ok: false, code: "SCHEDULE_TIME_ZONE_INVALID" });
  expect(effectiveSchedulePreferences(TEST_CTX).isDefault).toBe(true);
  expect(syncDeviceTimeZone(TEST_CTX, "Europe/Berlin")).toEqual({ ok: true, changed: true });
  expect(effectiveSchedulePreferences(TEST_CTX)).toMatchObject({ isDefault: false, preferences: { timeZone: "Europe/Berlin", mode: "buffered" } });
  // A device already in the server's zone still records it, so the default no longer decides.
  globalThis.crosslineStore.close();
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(syncDeviceTimeZone(TEST_CTX, "Asia/Shanghai")).toEqual({ ok: true, changed: false });
  expect(effectiveSchedulePreferences(TEST_CTX).isDefault).toBe(false);
});
