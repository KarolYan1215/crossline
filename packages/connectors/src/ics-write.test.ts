import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { buildIcs, icsFold, icsText, icsTimeZone, zonedInstant } from "./ics-write";
import { readIcal } from "./ical";

const NOW = new Date("2026-11-10T08:00:00Z");

/** The RFC 5545 rules a reader relies on, checked on the raw text. */
function rfcProblems(text: string): string[] {
  const problems: string[] = [];
  if (!text.endsWith("\r\n")) problems.push("not CRLF-terminated");
  if (/[^\r]\n/.test(text)) problems.push("bare LF");
  const physical = text.split("\r\n").slice(0, -1);
  for (const line of physical) if (new TextEncoder().encode(line).length > 75) problems.push(`over 75 octets: ${line.slice(0, 30)}`);
  const logical = text.replace(/\r\n[ \t]/g, "").split("\r\n").slice(0, -1);
  const stack: string[] = [];
  for (const line of logical) {
    if (!/^[A-Z][A-Z0-9-]*(;[^:]*)?:/.test(line)) problems.push(`not name:value: ${line}`);
    if (line.startsWith("BEGIN:")) stack.push(line.slice(6));
    if (line.startsWith("END:") && stack.pop() !== line.slice(4)) problems.push(`unbalanced ${line}`);
  }
  if (stack.length) problems.push("unclosed components");
  if (logical[0] !== "BEGIN:VCALENDAR" || !logical.includes("VERSION:2.0") || !logical.some((line) => line.startsWith("PRODID:"))) problems.push("calendar header");
  // Every VEVENT has UID, DTSTAMP and DTSTART; every referenced TZID is defined.
  const events = text.replace(/\r\n[ \t]/g, "").split("BEGIN:VEVENT").slice(1);
  for (const event of events) for (const name of ["UID:", "DTSTAMP:", "DTSTART"]) if (!event.includes(`\r\n${name}`)) problems.push(`VEVENT without ${name}`);
  const defined = new Set([...text.matchAll(/\r\nTZID:([^\r]+)/g)].map((match) => match[1]));
  for (const match of text.matchAll(/;TZID=([^:;]+)/g)) if (!defined.has(match[1])) problems.push(`TZID ${match[1]} not defined`);
  return problems;
}

describe("ICS writer", () => {
  it("escapes TEXT and folds long lines without splitting a character", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const folded = icsFold(`SUMMARY:${"科研 · 写论文第三章".repeat(6)}`);
    for (const line of folded.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"科研 · 写论文第三章".repeat(6)}`);
  });

  it("writes a feed that passes the RFC checks and reads back with the same times and titles", () => {
    const text = buildIcs({ name: "Crossline", now: NOW, events: [
      { uid: "a1@crossline.lol", summary: "科研 · 读论文, 做笔记; 第 2 章", start: "2026-11-11T15:00:00Z", end: "2026-11-11T16:30:00Z", alarmMinutes: 10 },
      { uid: "s1@crossline.lol", summary: "科研 · 组会", start: "2026-11-12T20:00:00Z", end: "2026-11-12T21:00:00Z",
        series: { weekdays: [4], startDate: "2026-11-12", until: "2026-12-31", localStart: "14:00", localEnd: "15:00", timeZone: "America/Chicago", exceptions: ["2026-11-26"] } }
    ] });
    expect(rfcProblems(text)).toEqual([]);
    const read = readIcal(text, { sourceId: "feed", from: new Date("2026-11-10T00:00:00Z"), to: new Date("2026-12-10T00:00:00Z"), timeZone: "America/Chicago" });
    expect(read.calendarName).toBe("Crossline");
    // TRANSPARENT events are skipped by the reader (free time), so read the parsed object directly for those.
    const root = new ICAL.Component(ICAL.parse(text));
    const events = root.getAllSubcomponents("vevent").map((component) => new ICAL.Event(component));
    expect(events[0]!.summary).toBe("科研 · 读论文, 做笔记; 第 2 章");
    expect(events[0]!.startDate.toJSDate().toISOString()).toBe("2026-11-11T15:00:00.000Z");
    expect(read.items).toEqual([]);
  });

  it("expands a weekly series in its own zone across the DST change, skipping the exception", () => {
    const text = buildIcs({ now: NOW, events: [{ uid: "s1@crossline.lol", summary: "组会", start: "2026-10-29T19:00:00Z", end: "2026-10-29T20:00:00Z", busy: true,
      series: { weekdays: [4], startDate: "2026-10-29", until: "2026-11-26", localStart: "14:00", localEnd: "15:00", timeZone: "America/Chicago", exceptions: ["2026-11-19"] } }] });
    expect(rfcProblems(text)).toEqual([]);
    const read = readIcal(text, { sourceId: "feed", from: new Date("2026-10-28T00:00:00Z"), to: new Date("2026-12-01T00:00:00Z"), timeZone: "Asia/Shanghai" });
    // 14:00 Chicago is 19:00Z under CDT and 20:00Z under CST (the change is 2026-11-01).
    expect(read.items.map((item) => item.start)).toEqual(["2026-10-29T19:00:00.000Z", "2026-11-05T20:00:00.000Z", "2026-11-12T20:00:00.000Z", "2026-11-26T20:00:00.000Z"]);
  });

  it("names the zone's offset change at its onset in the local time before it", () => {
    const lines = icsTimeZone("America/Chicago", Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"));
    const text = lines.join("\n");
    expect(text).toContain("BEGIN:DAYLIGHT\nDTSTART:20260930T190000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0500");
    expect(text).toContain("BEGIN:STANDARD\nDTSTART:20261101T020000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0600");
    // A zone without changes is one STANDARD observance.
    expect(icsTimeZone("Asia/Shanghai", Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-12-31T00:00:00Z")).join("\n")).toContain("DTSTART:19700101T000000\nTZOFFSETFROM:+0800\nTZOFFSETTO:+0800");
  });

  it("writes iMIP REQUEST and CANCEL with organizer, attendee and sequence", () => {
    const base = { uid: "x@crossline.lol", summary: "创业 · 投资人电话", start: "2026-11-12T01:00:00Z", end: "2026-11-12T01:30:00Z",
      organizer: { email: "calendar@mail.crossline.lol", name: "Crossline 日历" }, attendees: ["person@example.com"] };
    const request = buildIcs({ method: "REQUEST", now: NOW, events: [{ ...base, sequence: 2, alarmMinutes: 10 }] });
    expect(rfcProblems(request)).toEqual([]);
    const unfolded = request.replace(/\r\n /g, "");
    expect(unfolded).toContain("METHOD:REQUEST\r\n");
    expect(unfolded).toContain("SEQUENCE:2\r\n");
    expect(unfolded).toContain("ORGANIZER;CN=Crossline 日历:mailto:calendar@mail.crossline.lol\r\n");
    expect(unfolded).toContain("RSVP=FALSE:mailto:person@example.com\r\n");
    const cancel = buildIcs({ method: "CANCEL", now: NOW, events: [{ ...base, sequence: 3, alarmMinutes: 10 }] });
    expect(rfcProblems(cancel)).toEqual([]);
    expect(cancel).toContain("STATUS:CANCELLED\r\n");
    expect(cancel).not.toContain("VALARM");
  });

  it("finds the instant of a wall-clock time on both sides of a change", () => {
    expect(zonedInstant("2026-10-31", "09:00", "America/Chicago").toISOString()).toBe("2026-10-31T14:00:00.000Z");
    expect(zonedInstant("2026-11-02", "09:00", "America/Chicago").toISOString()).toBe("2026-11-02T15:00:00.000Z");
  });
});
