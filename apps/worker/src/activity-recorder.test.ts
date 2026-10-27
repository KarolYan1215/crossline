import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ACTIVITY_HOURLY, atComputerByHour, atComputerLines, type ActivityReading } from "@crossline/core";
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

test("键鼠节律 is its own switch: quarter-hour totals of input seconds, pauses and pointer travel, nothing else; off deletes them", async () => {
  const { INPUT_RHYTHM_BUCKETS, INPUT_RHYTHM_CONSENT, inputRhythmAt } = await import("@crossline/core");
  const { store, tracker, w } = setup();
  try {
    const at = (iso: string): ActivityReading => ({ at: iso, idleMs: 500, app: "Code.exe", title: "secret.ts", rhythm: { activeSec: 50, pauses: 2, mousePx: 900 } });
    tracker.handle(at("2026-09-20T10:01:00.000Z"));
    expect(store.getSetting(w, INPUT_RHYTHM_BUCKETS)).toBeUndefined();
    store.setSetting(w, INPUT_RHYTHM_CONSENT, "granted");
    for (let minute = 1; minute <= 14; minute += 1) tracker.handle(at(`2026-09-20T10:${String(minute).padStart(2, "0")}:00.000Z`));
    const buckets = JSON.parse(store.getSetting(w, INPUT_RHYTHM_BUCKETS)!);
    expect(buckets).toEqual([{ start: "2026-09-20T10:00:00.000Z", minutes: 14, activeSec: 700, pauses: 28, mousePx: 12_600 }]);
    expect(JSON.stringify(buckets)).not.toContain("secret");
    expect(inputRhythmAt(buckets, "2026-09-20T10:30:00.000Z")).toEqual({ fragmentation: 2.4, pointerPace: 18 });
    store.setSetting(w, INPUT_RHYTHM_CONSENT, "denied");
    tracker.handle(at("2026-09-20T10:20:00.000Z"));
    expect(store.getSetting(w, INPUT_RHYTHM_BUCKETS)).toBeUndefined();
  } finally { store.close(); }
});

test("the source's rhythm fields are kept only when all three are sane numbers", () => {
  const at = new Date("2026-09-20T10:00:00.000Z");
  expect(parseReadingLine(JSON.stringify({ idleMs: 5, app: "a", title: "b", activeSec: 40, pauses: 3, mousePx: 1200 }), at)?.rhythm)
    .toEqual({ activeSec: 40, pauses: 3, mousePx: 1200 });
  expect(parseReadingLine(JSON.stringify({ idleMs: 5, app: "a", title: "b", activeSec: -1, pauses: 3, mousePx: 1200 }), at)?.rhythm).toBeUndefined();
});

test("idle and active minutes are kept per hour under the activity consent, survive a restart, and go when it is withdrawn", () => {
  const { store, tracker, w } = setup();
  try {
    store.setSetting(w, LOCAL_ACTIVITY_CONSENT, "granted");
    tracker.handle(reading(0));
    tracker.handle(reading(1, "Code.exe", "x", 300_000));
    expect(JSON.parse(store.getSetting(w, ACTIVITY_HOURLY)!)).toEqual([{ start: "2026-09-20T10:00:00.000Z", active: 1, idle: 1 }]);
    // A new tracker (the worker restarted) carries on from the stored day instead of counting from zero.
    const restarted = createActivityTracker(store, () => [w], 60);
    restarted.handle(reading(2));
    expect(store.listEnergyObservations(w)[0]!.aggregate).toMatchObject({ activeMinutes: 2, idleMinutes: 1, sampleCount: 3 });
    expect(JSON.parse(store.getSetting(w, ACTIVITY_HOURLY)!)[0]).toMatchObject({ active: 2, idle: 1 });
    store.setSetting(w, LOCAL_ACTIVITY_CONSENT, "denied");
    restarted.handle(reading(3));
    expect(store.getSetting(w, ACTIVITY_HOURLY)).toBeUndefined();
  } finally { store.close(); }
});

test("the usual day at the computer is read from at least three days of hours", () => {
  const hours = ["2026-09-20", "2026-09-21", "2026-09-22"].flatMap((day) => [
    { start: `${day}T14:00:00.000Z`, active: 50, idle: 10 }, { start: `${day}T15:00:00.000Z`, active: 40, idle: 20 }]);
  expect(atComputerByHour(hours.slice(0, 4), "America/Chicago")).toBeUndefined();
  const day = atComputerByHour(hours, "America/Chicago")!;
  expect(day.days).toBe(3);
  expect(day.active[9]).toBe(50);
  expect(day.present[10]).toBe(1);
  expect(atComputerLines(hours, "America/Chicago")[0]).toContain("9–11 点");
});
