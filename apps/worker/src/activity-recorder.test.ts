import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { ActivityReading } from "@crossline/core";
import { ACTIVITY_BLACKLIST, ACTIVITY_DETAIL_CONSENT, ACTIVITY_LONG_GAPS, ACTIVITY_PAUSED_UNTIL, createActivityTracker, LOCAL_ACTIVITY_CONSENT, SLEEP_TRACKING_CONSENT } from "./activity-recorder";
import { parseReadingLine } from "./activity-source";

const reading = (minute: number, app = "Code.exe", title = "x.ts - Crossline", idleMs = 1_000): ActivityReading =>
  ({ at: `2026-09-20T10:${String(minute).padStart(2, "0")}:00.000Z`, idleMs, app, title });
const setup = () => {
  const store = new CrosslineStore(":memory:");
  const w = store.createPrincipalWithWorkspace("user-1", "个人").workspace.id;
  return { store, w, tracker: createActivityTracker(store, () => [w], 60) };
};

test("nothing is stored until consent is granted, and revoking it stops collection immediately", () => {
  const { store, tracker, w } = setup();
  try {
    tracker.handle(reading(0));
    expect(store.listEnergyObservations(w)).toEqual([]);
    store.setSetting(w, LOCAL_ACTIVITY_CONSENT, "denied");
    tracker.handle(reading(1));
    expect(store.listEnergyObservations(w)).toEqual([]);

    store.setSetting(w, LOCAL_ACTIVITY_CONSENT, "granted");
    tracker.handle(reading(2));
    const observation = store.listEnergyObservations(w)[0]!;
    expect(observation.source).toBe("local_activity");
    expect(Object.keys(observation.aggregate).sort()).toEqual(["activeMinutes", "idleMinutes", "sampleCount", "windowSwitches"]);
    // Aggregate consent alone never stores an app or a title.
    expect(store.listActivitySegments(w, "2000-01-01T00:00:00.000Z")).toEqual([]);
    expect(observation.level).toBe("uncalibrated");

    store.setSetting(w, LOCAL_ACTIVITY_CONSENT, "denied");
    tracker.handle(reading(3));
    expect(store.listEnergyObservations(w)[0]?.aggregate.sampleCount).toBe(1);
  } finally { store.close(); }
});

test("one aggregate row per day, updated in place; segments are stored only with the second consent", () => {
  const { store, tracker, w } = setup();
  try {
    store.setSetting(w, ACTIVITY_DETAIL_CONSENT, "granted");
    for (let minute = 0; minute < 5; minute++) tracker.handle(reading(minute));
    expect(store.listEnergyObservations(w)).toHaveLength(1);
    expect(store.listEnergyObservations(w)[0]?.aggregate.activeMinutes).toBe(5);
    const segments = store.listActivitySegments(w, "2000-01-01T00:00:00.000Z");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ app: "Code.exe", category: "coding", idle: false });
    expect(store.recentActivityEntries(w, 5)[0]?.title).toBe("x.ts - Crossline");
  } finally { store.close(); }
});

test("private windows are not recorded at all, not even their app name; the minute still counts as active", () => {
  const { store, tracker, w } = setup();
  try {
    store.setSetting(w, ACTIVITY_DETAIL_CONSENT, "granted");
    store.setSetting(w, ACTIVITY_BLACKLIST, JSON.stringify(["心理咨询"]));
    tracker.handle(reading(0, "chrome.exe", "Bank of America - Account Summary"));
    tracker.handle(reading(1, "1Password.exe", "Vault"));
    tracker.handle(reading(2, "chrome.exe", "我的心理咨询预约"));
    expect(store.listActivitySegments(w, "2000-01-01T00:00:00.000Z")).toEqual([]);
    expect(JSON.stringify(store.recentActivityEntries(w, 10))).not.toMatch(/Bank|Vault|心理/);
    expect(store.listEnergyObservations(w)[0]?.aggregate.activeMinutes).toBe(3);
  } finally { store.close(); }
});

test("pausing stops recording until the stated time, and idle readings carry no title", () => {
  const { store, tracker, w } = setup();
  try {
    store.setSetting(w, ACTIVITY_DETAIL_CONSENT, "granted");
    store.setSetting(w, ACTIVITY_PAUSED_UNTIL, "2026-09-20T10:03:00.000Z");
    tracker.handle(reading(1));
    tracker.handle(reading(2));
    expect(store.listActivitySegments(w, "2000-01-01T00:00:00.000Z")).toEqual([]);
    tracker.handle(reading(3, "Code.exe", "secret idle doc.ts", 300_000));
    const [entry] = store.recentActivityEntries(w, 1);
    expect(entry).toMatchObject({ idle: true, title: "" });
  } finally { store.close(); }
});

test("a reading line from the source is validated and truncated", () => {
  const at = new Date("2026-09-20T10:00:00.000Z");
  expect(parseReadingLine(JSON.stringify({ idleMs: 5, app: "a", title: "b" }), at)).toMatchObject({ idleMs: 5, app: "a", title: "b" });
  expect(parseReadingLine("not json", at)).toBeUndefined();
  expect(parseReadingLine(JSON.stringify({ idleMs: "x", app: "a", title: "b" }), at)).toBeUndefined();
  expect(parseReadingLine(JSON.stringify({ idleMs: 1, app: "a", title: "t".repeat(1000) }), at)?.title).toHaveLength(300);
});

test("作息记录 is its own switch: a night away is kept as its start and end only when it is on, whatever the activity consent; off deletes it", () => {
  const { store, tracker, w } = setup();
  try {
    const at = (iso: string, idleMs = 1_000): ActivityReading => ({ at: iso, idleMs, app: "Code.exe", title: "x.ts" });
    // The activity consent alone does not record it.
    store.setSetting(w, LOCAL_ACTIVITY_CONSENT, "granted");
    tracker.handle(at("2026-09-20T04:30:00.000Z"));
    tracker.handle(at("2026-09-20T12:10:00.000Z"));
    expect(store.getSetting(w, ACTIVITY_LONG_GAPS)).toBeUndefined();
    // Its own consent does, even with the activity consent withdrawn.
    store.setSetting(w, LOCAL_ACTIVITY_CONSENT, "denied");
    store.setSetting(w, SLEEP_TRACKING_CONSENT, "granted");
    tracker.handle(at("2026-09-21T04:40:00.000Z"));
    // Idle readings during the night are not activity; the computer may also simply be off.
    tracker.handle(at("2026-09-21T07:00:00.000Z", 3_600_000));
    tracker.handle(at("2026-09-21T12:05:00.000Z"));
    tracker.handle(at("2026-09-21T12:06:00.000Z"));
    expect(JSON.parse(store.getSetting(w, ACTIVITY_LONG_GAPS)!)).toEqual([{ from: "2026-09-21T04:40:00.000Z", to: "2026-09-21T12:05:00.000Z" }]);
    // Without the activity consent, no minutes are counted for that day.
    expect(store.listEnergyObservations(w).map((item) => item.id)).not.toContain("local-activity:2026-09-21");
    // Off: the next reading forgets everything it kept.
    store.setSetting(w, SLEEP_TRACKING_CONSENT, "denied");
    tracker.handle(at("2026-09-21T12:07:00.000Z"));
    expect(store.getSetting(w, ACTIVITY_LONG_GAPS)).toBeUndefined();
    expect(store.getSetting(w, "activity.lastActiveAt")).toBeUndefined();
  } finally { store.close(); }
});
