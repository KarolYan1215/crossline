import ICAL from "ical.js";
import type { ExternalItem } from "./index";

/**
 * A calendar read from a subscription address (docs/onboarding-v3.md 「日历接入」, decided 2026-10-14): the private iCal link Apple,
 * Google and Outlook all export, read-only, with no sign-in. Turned into the same `ExternalItem`s a Graph read produces, so the sync
 * that already keeps the plan's reality lane (`createGraphSync`) carries it without knowing where it came from.
 *
 * What counts as a block: a timed event inside the window. All-day events (holidays, birthdays), events marked free
 * (`TRANSP:TRANSPARENT`) and cancelled ones are not time the person is busy, so they are left out. A recurring event is expanded
 * here, one item per occurrence, with its moved and cancelled occurrences applied (`RECURRENCE-ID`, `EXDATE`).
 */
export type IcalRead = { items: ExternalItem[]; events: number; skipped: number; calendarName: string };

/** Occurrences per recurring event, at most: a daily event over the window is ~70; anything beyond this is a runaway rule. */
const MAX_OCCURRENCES = 400;
/** Occurrences walked through before the window (a daily series from ten years ago is ~3,700). */
const MAX_WALK = 20_000;

const validZone = (zone: string) => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } };

/** The UTC instant of a wall-clock time in an IANA zone (two passes settle the offset across a DST change). */
function zonedToUtc(time: { year: number; month: number; day: number; hour: number; minute: number; second: number }, zone: string): Date {
  const guess = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const offset = (at: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - at;
  };
  let utc = guess - offset(guess);
  utc = guess - offset(utc);
  return new Date(utc);
}

/**
 * A time from the file as an instant. A zone the file defines (VTIMEZONE) or UTC is ical.js's own; a TZID the file names without
 * defining it is read as an IANA zone when it is one; a floating time is the person's own zone.
 */
function instant(time: ICAL.Time, tzid: string | undefined, personZone: string): Date {
  const zone = time.zone;
  if (zone && (zone === ICAL.Timezone.utcTimezone || (zone.tzid !== "floating" && ICAL.TimezoneService.has(zone.tzid)))) return time.toJSDate();
  const named = tzid && validZone(tzid) ? tzid : personZone;
  return zonedToUtc(time, named);
}

export function readIcal(text: string, options: { sourceId: string; from: Date; to: Date; timeZone: string }): IcalRead {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const zone of root.getAllSubcomponents("vtimezone")) {
    try { ICAL.TimezoneService.register(zone); } catch { /* a malformed zone falls back to the IANA reading below */ }
  }
  const calendarName = String(root.getFirstPropertyValue("x-wr-calname") ?? "");
  const vevents = root.getAllSubcomponents("vevent");
  // Moved or cancelled occurrences arrive as their own VEVENT with the master's UID and a RECURRENCE-ID.
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const component of vevents) {
    const event = new ICAL.Event(component);
    if (event.isRecurrenceException()) exceptions.push(event);
    else masters.set(event.uid, event);
  }
  for (const exception of exceptions) masters.get(exception.uid)?.relateException(exception);

  const items: ExternalItem[] = [];
  let skipped = 0;
  const from = options.from.getTime(), to = options.to.getTime();
  const push = (event: ICAL.Event, start: ICAL.Time, end: ICAL.Time, occurrence: string) => {
    const component = event.component;
    if (start.isDate) { skipped += 1; return; }
    if (String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") { skipped += 1; return; }
    if (String(component.getFirstPropertyValue("transp") ?? "").toUpperCase() === "TRANSPARENT") { skipped += 1; return; }
    const startTzid = component.getFirstProperty("dtstart")?.getParameter("tzid");
    const endTzid = component.getFirstProperty("dtend")?.getParameter("tzid") ?? startTzid;
    const startAt = instant(start, typeof startTzid === "string" ? startTzid : undefined, options.timeZone);
    const endAt = instant(end, typeof endTzid === "string" ? endTzid : undefined, options.timeZone);
    if (endAt.getTime() <= from || startAt.getTime() >= to) return;
    const uid = event.uid || `${event.summary}@${startAt.toISOString()}`;
    items.push({
      provider: "graph_calendar", externalId: `ical:${options.sourceId}:${uid}:${occurrence}`,
      // One per occurrence: occurrences share the UID, and the sync collapses items that share an iCalUid.
      iCalUid: `${uid}@${occurrence}`,
      title: event.summary || "（无标题）", start: startAt.toISOString(), end: endAt.toISOString(),
      ...(event.location?.trim() ? { location: event.location.trim().slice(0, 300) } : {})
    });
  };

  for (const event of masters.values()) {
    if (!event.isRecurring()) { push(event, event.startDate, event.endDate, event.startDate.toString()); continue; }
    // Expansion starts at the series' first day, which may be years back: occurrences before the window are walked past (bounded),
    // and only those inside it count towards the cap.
    const iterator = event.iterator();
    let inside = 0;
    for (let walked = 0; walked < MAX_WALK && inside < MAX_OCCURRENCES; walked += 1) {
      const next = iterator.next();
      if (!next) break;
      const at = instant(next, undefined, options.timeZone).getTime();
      if (at >= to) break;
      if (at < from - 86_400_000) continue;
      inside += 1;
      const details = event.getOccurrenceDetails(next);
      push(details.item, details.startDate, details.endDate, next.toString());
    }
  }
  return { items, events: vevents.length, skipped, calendarName };
}

/**
 * The address the person pasted, as the https address to read. `webcal://` is the same address with the scheme the calendar apps
 * use to say "subscribe"; anything that is not https after that is refused (the private link is a credential, never sent in clear).
 */
export function icalAddress(pasted: string): URL | undefined {
  const trimmed = pasted.trim().replace(/^webcals?:\/\//i, "https://");
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && url.hostname ? url : undefined;
  } catch { return undefined; }
}
