import { expect, test } from "vitest";
import { replayTime } from "./replay-time";

const now = Date.parse("2026-10-06T18:00:00.000Z");

test("a replayed command keeps the time it was done on the device", () => {
  expect(replayTime("2026-10-06T14:00:00.000Z", now)).toBe("2026-10-06T14:00:00.000Z");
});

test("a time in the future, too old, or unreadable is not trusted", () => {
  expect(replayTime("2026-10-06T19:00:00.000Z", now)).toBeUndefined();
  expect(replayTime("2026-09-20T14:00:00.000Z", now)).toBeUndefined();
  expect(replayTime("not a date", now)).toBeUndefined();
});
