import "@crossline/i18n/catalog/worker";
import { expect, test } from "vitest";
import { readIcal } from "./ical";

// The placeholder an untitled event gets is written in the workspace's language; Chinese when none is given.
const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", "BEGIN:VEVENT", "UID:no-title@test", "DTSTAMP:20261001T000000Z",
  "DTSTART:20261014T150000Z", "DTEND:20261014T160000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const window = { sourceId: "s", from: new Date("2026-10-13T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z"), timeZone: "UTC" };

test("an event without a title is named in the reader's language", () => {
  expect(readIcal(ics, window).items[0]?.title).toBe("（无标题）");
  expect(readIcal(ics, { ...window, locale: "en" }).items[0]?.title).toBe("(no title)");
});
