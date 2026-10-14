import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { icalAddress, readIcal } from "./ical";

const fixture = readFileSync(path.join(import.meta.dirname, "fixtures", "subscription.ics"), "utf8");
const read = () => readIcal(fixture, { sourceId: "s1", from: new Date("2026-10-12T05:00:00Z"), to: new Date("2026-11-06T06:00:00Z"), timeZone: "America/Chicago" });

test("a subscribed calendar becomes one timed item per occurrence, with skipped and moved occurrences applied", () => {
  const { items, calendarName } = read();
  expect(calendarName).toBe("课程与组会");
  const lectures = items.filter((item) => item.title.startsWith("ECE 548")).map((item) => [item.title, item.start]);
  expect(lectures).toEqual([
    ["ECE 548 Lecture", "2026-10-13T16:00:00.000Z"],
    // Oct 15 is an EXDATE; Oct 20 was moved to 14:00.
    ["ECE 548 Lecture (moved)", "2026-10-20T19:00:00.000Z"],
    ["ECE 548 Lecture", "2026-10-22T16:00:00.000Z"],
    ["ECE 548 Lecture", "2026-10-27T16:00:00.000Z"],
    ["ECE 548 Lecture", "2026-10-29T16:00:00.000Z"],
    // After the clocks go back on Nov 1, 11:00 in Chicago is 17:00 UTC.
    ["ECE 548 Lecture", "2026-11-03T17:00:00.000Z"],
    ["ECE 548 Lecture", "2026-11-05T17:00:00.000Z"]
  ]);
  // Each occurrence has its own identity, or the sync would fold the series into one block.
  expect(new Set(items.map((item) => item.iCalUid)).size).toBe(items.length);
  expect(items.every((item) => item.provider === "graph_calendar" && item.externalId.startsWith("ical:s1:"))).toBe(true);
});

test("zones are read the way each calendar app writes them: defined in the file, a Windows name, or an IANA name it does not define", () => {
  const { items } = read();
  const at = (title: string) => items.find((item) => item.title === title);
  expect(at("导师组周会")).toMatchObject({ start: "2026-10-16T14:00:00.000Z", end: "2026-10-16T15:00:00.000Z" });
  expect(at("Call with NYC")).toMatchObject({ start: "2026-10-19T17:00:00.000Z" });
  expect(at("Dentist")).toMatchObject({ start: "2026-10-21T15:00:00.000Z" });
});

test("all-day, free and cancelled events are not busy time, and nothing outside the window comes through", () => {
  const titles = read().items.map((item) => item.title);
  for (const left of ["Fall break", "Office hours (optional)", "Canceled seminar", "Far away"]) expect(titles).not.toContain(left);
});

test("a pasted subscription link is read over https only; webcal is the same address", () => {
  expect(icalAddress(" webcal://p01-caldav.icloud.com/published/2/abc ")?.toString()).toBe("https://p01-caldav.icloud.com/published/2/abc");
  expect(icalAddress("https://calendar.google.com/calendar/ical/x/private-y/basic.ics")?.hostname).toBe("calendar.google.com");
  expect(icalAddress("http://example.com/cal.ics")).toBeUndefined();
  expect(icalAddress("not a link")).toBeUndefined();
});
