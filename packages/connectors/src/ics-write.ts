/**
 * iCalendar text that Crossline writes (RFC 5545), for the two calendar paths that need no account at a provider (the owner's decision
 * of 2026-11-10, docs/calendar-write-setup.md): the private subscription feed (`METHOD` absent, path a) and the invitations mailed to the
 * person (iMIP, RFC 6047: `METHOD:REQUEST` / `METHOD:CANCEL`, path b).
 *
 * What it writes is deliberately small: a stable UID, the time, the title, a sequence number, free/busy. No description, location or
 * notes — the feed is reachable by anyone holding the link, and an invitation sits in a mailbox, so nothing beyond 「主线 · 任务名」 leaves.
 * A one-off is written in UTC. A weekly series is written in the person's zone (`TZID`) with the `VTIMEZONE` it names, built from the
 * zone's own offsets over the series' span, since RFC 5545 §3.2.19 requires every referenced TZID to be defined in the object.
 */

export type IcsSeries = {
  /** 0 = Sunday. */
  weekdays: number[];
  /** First and last day, YYYY-MM-DD, in `timeZone`. */
  startDate: string; until: string;
  /** Wall-clock HH:MM in `timeZone`. */
  localStart: string; localEnd: string;
  timeZone: string;
  /** Days skipped, YYYY-MM-DD. */
  exceptions?: string[];
};

export type IcsEvent = {
  uid: string;
  summary: string;
  /** Instants (ISO-8601). For a series, the first occurrence; the series itself is `series`. */
  start: string; end: string;
  sequence?: number;
  series?: IcsSeries;
  /** Shown as free (the default for what Crossline writes: a plan is not a meeting). */
  busy?: boolean;
  /** Minutes before the start for one display alarm; none when absent. */
  alarmMinutes?: number;
  cancelled?: boolean;
  /** iMIP only. */
  organizer?: { email: string; name?: string };
  attendees?: string[];
};

export type IcsCalendar = { name?: string; method?: "REQUEST" | "CANCEL" | "PUBLISH"; events: IcsEvent[]; now: Date };

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** RFC 5545 §3.3.11: backslash, semicolon, comma and line breaks are escaped in TEXT. */
export function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** RFC 5545 §3.1: lines longer than 75 octets are folded with CRLF and one space, never inside a UTF-8 character. */
export function icsFold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "", size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // The first line holds 75 octets; continuation lines hold 74 after their leading space.
    if (size + bytes > (parts.length ? 74 : 75)) { parts.push(current); current = ""; size = 0; }
    current += char; size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** An instant as a UTC DATE-TIME: 20261110T150000Z. */
export function icsUtc(at: Date | string): string {
  const date = typeof at === "string" ? new Date(at) : at;
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

const localStamp = (day: string, time: string) => `${day.replace(/-/g, "")}T${time.replace(":", "")}00`;

/** The zone's offset from UTC at an instant, in minutes. */
function offsetMinutes(zone: string, at: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((wall - Math.floor(at / 1000) * 1000) / 60_000);
}

/** A wall-clock day and time in a zone as an instant (two passes settle the offset across a change). */
export function zonedInstant(day: string, time: string, zone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - offsetMinutes(zone, guess) * 60_000;
  utc = guess - offsetMinutes(zone, utc) * 60_000;
  return new Date(utc);
}

const offsetText = (minutes: number) => `${minutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;
const wallAt = (at: number, offset: number) => icsUtc(new Date(at + offset * 60_000)).slice(0, 15);

/**
 * A VTIMEZONE for `zone` over [from, to]: one observance per period between the zone's offset changes, each starting at its onset in the
 * local time of the offset before it (RFC 5545 §3.6.5). The larger offsets of the span are DAYLIGHT, the smallest STANDARD.
 */
export function icsTimeZone(zone: string, from: number, to: number): string[] {
  const DAY = 86_400_000;
  const changes: Array<{ at: number; before: number; after: number }> = [];
  let previous = offsetMinutes(zone, from);
  for (let at = from + DAY; at <= to + DAY; at += DAY) {
    const now = offsetMinutes(zone, at);
    if (now === previous) continue;
    // The minute it changed, between the two days.
    let low = at - DAY, high = at;
    while (high - low > 60_000) { const mid = Math.floor((low + high) / 2 / 60_000) * 60_000; if (offsetMinutes(zone, mid) === previous) low = mid; else high = mid; }
    changes.push({ at: high, before: previous, after: now });
    previous = now;
  }
  const first = offsetMinutes(zone, from);
  const standard = Math.min(first, ...changes.map((change) => change.after));
  const observance = (start: string, before: number, after: number) => {
    const kind = after > standard ? "DAYLIGHT" : "STANDARD";
    return [`BEGIN:${kind}`, `DTSTART:${start}`, `TZOFFSETFROM:${offsetText(before)}`, `TZOFFSETTO:${offsetText(after)}`, `END:${kind}`];
  };
  return ["BEGIN:VTIMEZONE", `TZID:${zone}`,
    ...observance(changes.length ? wallAt(from, first) : "19700101T000000", first, first),
    ...changes.flatMap((change) => observance(wallAt(change.at, change.before), change.before, change.after)),
    "END:VTIMEZONE"];
}

function eventLines(event: IcsEvent, now: Date, method: IcsCalendar["method"]): string[] {
  const lines = ["BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${icsUtc(now)}`];
  const series = event.series;
  if (series) {
    lines.push(`DTSTART;TZID=${series.timeZone}:${localStamp(series.startDate, series.localStart)}`,
      `DTEND;TZID=${series.timeZone}:${localStamp(series.startDate, series.localEnd)}`);
    // UNTIL is UTC when DTSTART has a TZID (§3.3.10): the end of the last day there.
    const until = icsUtc(new Date(zonedInstant(series.until, "23:59", series.timeZone).getTime() + 59_000));
    const days = [...new Set(series.weekdays)].sort().map((day) => DAYS[day]).join(",");
    lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${days};UNTIL=${until}`);
    for (const day of (series.exceptions ?? []).filter((item) => item >= series.startDate && item <= series.until)) {
      lines.push(`EXDATE;TZID=${series.timeZone}:${localStamp(day, series.localStart)}`);
    }
  } else lines.push(`DTSTART:${icsUtc(event.start)}`, `DTEND:${icsUtc(event.end)}`);
  lines.push(`SUMMARY:${icsText(event.summary)}`, `SEQUENCE:${event.sequence ?? 0}`,
    `STATUS:${event.cancelled || method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`, `TRANSP:${event.busy ? "OPAQUE" : "TRANSPARENT"}`);
  if (event.organizer) lines.push(`ORGANIZER${event.organizer.name ? `;CN=${quoteParam(event.organizer.name)}` : ""}:mailto:${event.organizer.email}`);
  // The person is told, not asked to answer: no RSVP is requested and nothing replies to the organizer.
  for (const attendee of event.attendees ?? []) lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${attendee}`);
  if (event.alarmMinutes !== undefined && method !== "CANCEL") {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(event.summary)}`, `TRIGGER:-PT${Math.max(0, Math.round(event.alarmMinutes))}M`, "END:VALARM");
  }
  lines.push("END:VEVENT");
  return lines;
}

/** A parameter value is quoted when it holds a character that would end it (§3.2); a double quote cannot appear in one at all. */
const quoteParam = (value: string) => { const clean = value.replace(/"/g, "'"); return /[;:,]/.test(clean) ? `"${clean}"` : clean; };

/** A whole iCalendar object, CRLF-terminated and folded. */
export function buildIcs(calendar: IcsCalendar): string {
  const zones = new Map<string, { from: number; to: number }>();
  for (const series of calendar.events.flatMap((event) => event.series ? [event.series] : [])) {
    const from = Date.parse(`${series.startDate}T00:00:00Z`) - 2 * 86_400_000, to = Date.parse(`${series.until}T00:00:00Z`) + 2 * 86_400_000;
    const known = zones.get(series.timeZone);
    zones.set(series.timeZone, { from: Math.min(from, known?.from ?? from), to: Math.max(to, known?.to ?? to) });
  }
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Crossline//Calendar 1.0//ZH", "CALSCALE:GREGORIAN",
    ...(calendar.method ? [`METHOD:${calendar.method}`] : []),
    ...(calendar.name ? [`X-WR-CALNAME:${icsText(calendar.name)}`, `NAME:${icsText(calendar.name)}`] : []),
    ...[...zones.entries()].flatMap(([zone, span]) => icsTimeZone(zone, span.from, span.to)),
    ...calendar.events.flatMap((event) => eventLines(event, calendar.now, calendar.method)),
    "END:VCALENDAR"];
  return `${lines.map(icsFold).join("\r\n")}\r\n`;
}
