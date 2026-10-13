import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { startingWithin } from "./schedule-window";

test("work starting within two days (or begun in the last hour) is in the window; later work and an unreadable record are not", () => {
  const store = new CrosslineStore(":memory:");
  const now = new Date("2026-10-13T12:00:00.000Z");
  expect(startingWithin(store, "w", now)).toEqual(new Set());
  store.setSetting("w", "schedule.orderStarts", JSON.stringify({ soon: "2026-10-14T09:00:00.000Z", begun: "2026-10-13T11:30:00.000Z",
    later: "2026-10-16T09:00:00.000Z", past: "2026-10-12T09:00:00.000Z" }));
  expect([...startingWithin(store, "w", now)].sort()).toEqual(["begun", "soon"]);
  store.setSetting("w", "schedule.orderStarts", "{ not json");
  expect(startingWithin(store, "w", now)).toEqual(new Set());
  store.close();
});
