/**
 * Path (c) of the calendar write (the owner's decision of 2026-11-10, docs/calendar-write-setup.md): the person's confirmed fixed events
 * and work blocks written to their Google Calendar through the Google Calendar connector of their own ChatGPT login, called
 * deterministically by the Codex runtime (`mcpServer/tool/call`, no model turn). This lifts the former rule 「Google Calendar is
 * read-only」 for this path only, under the Graph writer's rules:
 *
 * - only events this app made (the ledger `calendar.published.google` holds their ids; the connector has no private properties to mark
 *   them, so an event not in the ledger is never touched);
 * - an event the person changed (time or title differs from what was written) or deleted is theirs from then on: never changed, never
 *   created again;
 * - deletes only in the future; preview and pencilled-in blocks never (only `scheduled:` and `fixed:` ids are accepted);
 * - a calendar named 「Crossline」 if the person has one (the connector has no tool to create a calendar — probed 2026-11-10 with
 *   `scripts/apps-calendar-tools.ts`), otherwise the primary calendar with every title prefixed 「Crossline · 」.
 *
 * Tool names are an allowlist: anything else throws before reaching the runtime.
 */
export const GOOGLE_TOOLS = new Set([
  "google_calendar.list_calendars", "google_calendar.search_events",
  "google_calendar.create_event", "google_calendar.update_event", "google_calendar.delete_event"
]);
export const GOOGLE_PREFIX = "Crossline · ";
const DAY_MS = 86_400_000;
/** How far ahead the calendar is read to recognise the person's edits; events further out are left as written. */
const READ_DAYS = 120;

export type ToolCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
export type GoogleBlock = { id: string; title: string; start: string; end: string; reminderMinutes?: number;
  recurrence?: { daysOfWeek: string[]; startDate: string; endDate: string; localStart: string; localEnd: string; timeZone: string; exceptions?: string[] } };
type Entry = { eventId: string; title: string; start: string; end: string; series?: { until: string; hash: string; rule: string[] }; edited?: true; removedByPerson?: true };
export type GoogleLedger = { calendarId?: string; prefix?: string; events: Record<string, Entry> };
export type GooglePublishResult = { calendar: "crossline" | "primary"; created: number; updated: number; deleted: number; unchanged: number; keptAsEdited: number };

const BYDAY: Record<string, string> = { sunday: "SU", monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA" };

/** The connector answers with objects of its own shape; this finds the first array of objects under any key. */
const listIn = (value: unknown, key: string): Array<Record<string, unknown>> => {
  if (!value || typeof value !== "object") return [];
  const own = (value as Record<string, unknown>)[key];
  if (Array.isArray(own)) return own.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  for (const inner of Object.values(value as Record<string, unknown>)) { const found = listIn(inner, key); if (found.length) return found; }
  return [];
};
const idIn = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id === "string" && row.id) return row.id;
  for (const inner of Object.values(row)) { const found = idIn(inner); if (found) return found; }
  return undefined;
};
const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);
const seriesHash = (block: GoogleBlock) => JSON.stringify([block.title, block.recurrence?.daysOfWeek, block.recurrence?.endDate, block.recurrence?.localStart, block.recurrence?.localEnd,
  block.recurrence?.timeZone, block.recurrence?.exceptions ?? []]);

function rrule(block: GoogleBlock): string[] {
  const series = block.recurrence!;
  const until = `${series.endDate.replace(/-/g, "")}T235959Z`;
  const days = series.daysOfWeek.map((day) => BYDAY[day]).filter(Boolean).join(",");
  const exdates = (series.exceptions ?? []).filter((day) => day >= series.startDate && day <= series.endDate)
    .map((day) => `EXDATE;TZID=${series.timeZone}:${day.replace(/-/g, "")}T${series.localStart.replace(":", "")}00`);
  return [`RRULE:FREQ=WEEKLY;BYDAY=${days};UNTIL=${until}`, ...exdates];
}

/** A publish that stopped part way: what it wrote is in `ledger`, so the next run does not take its own events for the person's or write them twice. */
export class GoogleInterruptedError extends Error {
  constructor(reason: unknown, readonly ledger: GoogleLedger) { super(reason instanceof Error ? reason.message : String(reason)); }
}

export async function publishToGoogle(call: ToolCall, blocks: GoogleBlock[], previous: GoogleLedger, now: Date):
  Promise<{ result: GooglePublishResult; ledger: GoogleLedger }> {
  const ledger: GoogleLedger = { ...previous, events: { ...previous.events } };
  try { return await publishInto(call, blocks, ledger, now); } catch (error) { throw new GoogleInterruptedError(error, ledger); }
}

async function publishInto(call: ToolCall, blocks: GoogleBlock[], ledger: GoogleLedger, now: Date): Promise<{ result: GooglePublishResult; ledger: GoogleLedger }> {
  const tool = (name: string, args: Record<string, unknown>) => {
    if (!GOOGLE_TOOLS.has(name)) throw new Error(`GOOGLE_TOOL_NOT_ALLOWED:${name}`);
    return call(name, args);
  };
  // The calendar: kept once chosen, so events are never split across two calendars.
  if (!ledger.calendarId) {
    const calendars = listIn(await tool("google_calendar.list_calendars", { max_results: 250 }), "calendars");
    const own = calendars.find((item) => String(item.summary ?? item.name ?? item.title ?? "").trim() === "Crossline"
      && ["owner", "writer", undefined].includes(item.access_role as string | undefined ?? item.accessRole as string | undefined));
    const ownId = own ? idIn({ id: own.id }) : undefined;
    ledger.calendarId = ownId ?? "primary";
    ledger.prefix = ownId ? "" : GOOGLE_PREFIX;
  }
  const calendarId = ledger.calendarId;
  const prefix = ledger.prefix ?? "";
  const wanted = blocks.filter((block) => /^(scheduled|fixed):/.test(block.id));
  // What is on the calendar now, to tell the person's edits from ours: one windowed read, paged.
  const until = Math.min(now.getTime() + READ_DAYS * DAY_MS, Math.max(now.getTime() + DAY_MS,
    ...Object.values(ledger.events).map((entry) => Date.parse(entry.end)), ...wanted.map((block) => Date.parse(block.end))) + DAY_MS);
  const seen = new Map<string, { title: string; start: string; end: string }>();
  const seriesSeen = new Map<string, string>();
  let token: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const answer = await tool("google_calendar.search_events", { calendar_id: calendarId, time_min: now.toISOString(), time_max: new Date(until).toISOString(),
      timezone_str: "UTC", max_results: 250, ...(token ? { next_page_token: token } : {}) });
    for (const event of listIn(answer, "events")) {
      const id = String(event.id ?? ""); if (!id) continue;
      const row = { title: String(event.summary ?? ""), start: String(event.start ?? ""), end: String(event.end ?? "") };
      seen.set(id, row);
      if (typeof event.recurring_event_id === "string" && !seriesSeen.has(event.recurring_event_id)) seriesSeen.set(event.recurring_event_id, row.title);
    }
    token = typeof (answer as { next_page_token?: unknown })?.next_page_token === "string" ? (answer as { next_page_token: string }).next_page_token : undefined;
    if (!token) break;
  }
  const result: GooglePublishResult = { calendar: prefix ? "primary" : "crossline", created: 0, updated: 0, deleted: 0, unchanged: 0, keptAsEdited: 0 };
  const inWindow = (entry: Entry) => Date.parse(entry.start) < until;
  /** Whether the person has taken this event over: moved, renamed or deleted it since it was written. */
  const takenOver = (entry: Entry): "edited" | "deleted" | undefined => {
    if (entry.edited) return "edited";
    if (entry.removedByPerson) return "deleted";
    if (entry.series) {
      if (entry.series.until < now.toISOString().slice(0, 10)) return undefined;
      const title = seriesSeen.get(entry.eventId);
      if (title === undefined) return seen.has(entry.eventId) ? undefined : "deleted";
      return title === entry.title ? undefined : "edited";
    }
    if (Date.parse(entry.end) <= now.getTime() || !inWindow(entry)) return undefined;
    const current = seen.get(entry.eventId);
    if (!current) return "deleted";
    return current.title === entry.title && sameInstant(current.start, entry.start) && sameInstant(current.end, entry.end) ? undefined : "edited";
  };
  const write = (block: GoogleBlock) => {
    const reminders = block.reminderMinutes !== undefined ? { reminders: { use_default: false, overrides: [{ method: "popup", minutes: block.reminderMinutes }] } } : {};
    const time = block.recurrence ? { start_time: block.start, end_time: block.end, timezone_str: block.recurrence.timeZone, recurrence: rrule(block) }
      : { start_time: block.start, end_time: block.end, timezone_str: "UTC" };
    return { title: `${prefix}${block.title}`, ...time, ...reminders, transparency: "transparent" };
  };
  for (const block of wanted) {
    const entry = ledger.events[block.id];
    const title = `${prefix}${block.title}`;
    if (entry) {
      const taken = takenOver(entry);
      if (taken === "edited") { ledger.events[block.id] = { ...entry, edited: true }; result.keptAsEdited += 1; continue; }
      if (taken === "deleted") { ledger.events[block.id] = { ...entry, removedByPerson: true }; result.keptAsEdited += 1; continue; }
      const same = block.recurrence ? entry.series?.hash === seriesHash(block) : entry.title === title && sameInstant(entry.start, block.start) && sameInstant(entry.end, block.end);
      if (same) { result.unchanged += 1; continue; }
      await tool("google_calendar.update_event", { event_id: entry.eventId, calendar_id: calendarId, ...write(block), ...(block.recurrence ? { update_scope: "entire_series" } : {}) });
      ledger.events[block.id] = { eventId: entry.eventId, title, start: block.start, end: block.end, ...(block.recurrence ? { series: { until: block.recurrence.endDate, hash: seriesHash(block), rule: rrule(block) } } : {}) };
      result.updated += 1;
      continue;
    }
    const created = await tool("google_calendar.create_event", { calendar_id: calendarId, attendees: [], self_attendance: "omit", add_google_meet: false, ...write(block) });
    const eventId = idIn(created);
    if (!eventId) throw new Error("GOOGLE_CREATE_NO_ID");
    ledger.events[block.id] = { eventId, title, start: block.start, end: block.end, ...(block.recurrence ? { series: { until: block.recurrence.endDate, hash: seriesHash(block), rule: rrule(block) } } : {}) };
    result.created += 1;
  }
  // Gone from the plan: deleted while still to come and still ours; a past or taken-over one only leaves the record.
  const present = new Set(wanted.map((block) => block.id));
  for (const [id, entry] of Object.entries(ledger.events)) {
    if (present.has(id)) continue;
    const today = now.toISOString().slice(0, 10);
    const ours = !takenOver(entry);
    if (ours && Date.parse(entry.start) > now.getTime()) { await tool("google_calendar.delete_event", { event_id: entry.eventId, calendar_id: calendarId }); result.deleted += 1; }
    else if (ours && entry.series && entry.series.until >= today && entry.series.rule.length) {
      // A series already under way ends today instead of being deleted: its past occurrences stay (deletes only in the future).
      const end = `${today.replace(/-/g, "")}T000000Z`;
      await tool("google_calendar.update_event", { event_id: entry.eventId, calendar_id: calendarId, update_scope: "entire_series",
        recurrence: entry.series.rule.map((line) => line.startsWith("RRULE:") ? line.replace(/UNTIL=[0-9TZ]+/, `UNTIL=${end}`) : line) });
      result.deleted += 1;
    }
    delete ledger.events[id];
  }
  return { result, ledger };
}
