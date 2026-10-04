import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "./index";

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const reading = (minute: number, over: object = {}) => ({ workspaceId: "w", at: new Date(Date.UTC(2026, 9, 2, 12, minute)).toISOString(), intervalSeconds: 60,
  app: "Code.exe", title: "activity.ts - Crossline", category: "coding", idle: false, ...over });

test("readings of the same window extend one segment, and a different window or a gap starts a new one", () => {
  store.recordActivityReading(reading(0));
  store.recordActivityReading(reading(1));
  store.recordActivityReading(reading(2));
  store.recordActivityReading(reading(3, { app: "chrome.exe", title: "arXiv", category: "reading" }));
  store.recordActivityReading(reading(4, { app: "Code.exe" }));
  // Twenty minutes later: the machine was off or asleep, not working in the same window.
  store.recordActivityReading(reading(24, { app: "Code.exe" }));
  const segments = store.listActivitySegments("w", "2026-10-01T00:00:00.000Z");
  expect(segments.map((segment) => [segment.app, segment.start.slice(11, 16), segment.end.slice(11, 16)])).toEqual([
    ["Code.exe", "12:00", "12:03"], ["chrome.exe", "12:03", "12:04"], ["Code.exe", "12:04", "12:05"], ["Code.exe", "12:24", "12:25"]
  ]);
});

test("titles are not returned by the listing, only by the one call that shows the person what is kept", () => {
  store.recordActivityReading(reading(0));
  expect(JSON.stringify(store.listActivitySegments("w", "2026-10-01T00:00:00.000Z"))).not.toContain("activity.ts");
  expect(store.recentActivityEntries("w", 5)[0]).toMatchObject({ title: "activity.ts - Crossline", app: "Code.exe" });
});

test("old titles are blanked but the minutes stay, very old rows go, and everything can be cleared at once", () => {
  store.recordActivityReading(reading(0, { at: "2026-09-01T12:00:00.000Z" }));
  store.recordActivityReading(reading(0, { at: "2026-06-01T12:00:00.000Z", app: "old.exe" }));
  store.recordActivityReading(reading(0));
  expect(store.pruneActivity("w", "2026-09-18T00:00:00.000Z", "2026-07-01T00:00:00.000Z")).toEqual({ blanked: 2, deleted: 1 });
  const entries = store.recentActivityEntries("w", 10);
  expect(entries.map((entry) => [entry.app, entry.title])).toEqual([["Code.exe", "activity.ts - Crossline"], ["Code.exe", ""]]);
  expect(store.clearActivityTitles("w")).toBe(1);
  expect(store.recentActivityEntries("w", 10).every((entry) => entry.title === "")).toBe(true);
});

test("activity is workspace-scoped and a backup carries it without any title", () => {
  store.recordActivityReading(reading(0));
  store.recordActivityReading(reading(0, { workspaceId: "other", title: "someone else" }));
  expect(store.listActivitySegments("w", "2026-10-01T00:00:00.000Z")).toHaveLength(1);
  const snapshot = store.exportSnapshot("w") as { tables: Record<string, Array<Record<string, unknown>>> };
  expect(snapshot.tables.activity_segments).toHaveLength(1);
  expect(JSON.stringify(snapshot)).not.toContain("activity.ts");
  expect(JSON.stringify(snapshot)).not.toContain("someone else");
});
