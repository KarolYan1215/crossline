import { createHash } from "node:crypto";
import { zonedInstant } from "@crossline/connectors/ics-write";

/**
 * Path (c) of the calendar write (the owner's decision of 2026-11-10, docs/calendar-write-setup.md): the person's confirmed fixed events
 * and work blocks written to their Google Calendar through the Google Calendar connector of their own ChatGPT login, called
 * deterministically by the Codex runtime (`mcpServer/tool/call`, no model turn). This lifts the former rule 「Google Calendar is
 * read-only」 for this path only, under the Graph writer's rules:
 *
 * - only events this app made (the ledger `calendar.published.google` holds their ids; the connector has no private properties to mark
 *   them, so an event not in the ledger is never touched);
 * - an event the person changed (time or title differs from what was written) or deleted is theirs from then on: never changed, never
 *   created again; for a weekly series one occurrence moved, renamed or deleted is enough — the whole series is theirs from then on;
 * - a create names its own event id (`googleEventId`, from the block's id), and the ledger records the attempt before the call: a create
 *   that timed out after Google carried it out is found under that id on the next run (or answers 409 when asked again), never made twice;
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
/**
 * `series.recurrence` and `series.dtstart` (the start last written) let a run work out which occurrences Google should show, to notice one
 * the person moved or deleted; entries written before they existed get them on the next run that finds the series unchanged.
 * `unconfirmed`: the create was asked for and did not answer — Google may or may not have made it.
 */
type Entry = { eventId: string; title: string; start: string; end: string; series?: { until: string; hash: string; rule: string[]; recurrence?: GoogleBlock["recurrence"]; dtstart?: string };
  edited?: true; removedByPerson?: true; unconfirmed?: true };
/** `generations`: per block id, how many of its events have left the ledger — a block that comes back gets a fresh event id. */
export type GoogleLedger = { calendarId?: string; prefix?: string; events: Record<string, Entry>; generations?: Record<string, number> };
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
const seriesOf = (block: GoogleBlock): Pick<Entry, "series"> => block.recurrence
  ? { series: { until: block.recurrence.endDate, hash: seriesHash(block), rule: rrule(block), recurrence: block.recurrence, dtstart: block.start } } : {};

/**
 * The id a create asks Google to give the event: the same block (in the same generation) always asks for the same one, so a create
 * retried after a timeout cannot make a second event. Google takes 5–1024 characters of base32hex (0-9, a-v); a hex digest is a subset.
 */
export const googleEventId = (blockId: string, generation = 0) => `crossline${createHash("sha256").update(`${blockId}#${generation}`).digest("hex").slice(0, 40)}`;
/** Google's answer to a create under an id it already holds (HTTP 409 duplicate — deleted events keep their id), as the connector relays it. */
const isDuplicate = (error: unknown) => /\b409\b|duplicate|already exists/i.test(error instanceof Error ? error.message : String(error));

const DAY_INDEX: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
/** Where an occurrence of a series sat before anyone moved it: the connector's `original_start_time`, else the instance id's stamp. */
function originalStartOf(event: Record<string, unknown>): string | undefined {
  const raw = event.original_start_time;
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>).date_time ?? (raw as Record<string, unknown>).dateTime : raw;
  if (typeof value === "string" && value) return value;
  const stamp = /_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(event.id ?? ""));
  return stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z` : undefined;
}
/** The occurrences (start, end in ms) a written weekly series has between `from` and `to`, none before `notBefore` (its written start). */
function occurrences(series: NonNullable<GoogleBlock["recurrence"]>, from: number, to: number, notBefore: number): Array<[number, number]> {
  const days = new Set(series.daysOfWeek.map((day) => DAY_INDEX[day]));
  const skipped = new Set(series.exceptions ?? []);
  const last = Date.parse(`${series.endDate}T23:59:59Z`);
  const found: Array<[number, number]> = [];
  for (let at = Math.max(Date.parse(`${series.startDate}T00:00:00Z`), Math.floor(from / DAY_MS) * DAY_MS - 2 * DAY_MS); at <= Math.min(last, to + DAY_MS); at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (!days.has(new Date(at).getUTCDay()) || skipped.has(day)) continue;
    const start = zonedInstant(day, series.localStart, series.timeZone).getTime();
    const end = zonedInstant(day, series.localEnd, series.timeZone).getTime();
    // The RRULE's UNTIL is the end of its last day in UTC: an evening occurrence west of UTC on that day is not in the series.
    if (end > from && start < to && start >= notBefore && start <= last) found.push([start, end]);
  }
  return found;
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
  // What is on the calendar now, to tell the person's edits from ours: one windowed read, paged. A series is read to its last day, so an
  // occurrence the person moved or deleted weeks ahead is seen.
  const until = Math.min(now.getTime() + READ_DAYS * DAY_MS, Math.max(now.getTime() + DAY_MS,
    ...Object.values(ledger.events).map((entry) => entry.series ? Date.parse(`${entry.series.until}T23:59:59Z`) : Date.parse(entry.end)),
    ...wanted.map((block) => block.recurrence ? Date.parse(`${block.recurrence.endDate}T23:59:59Z`) : Date.parse(block.end))) + DAY_MS);
  const seen = new Map<string, { title: string; start: string; end: string }>();
  /** Per series id, its occurrences in the window as Google shows them (the connector lists a series as single occurrences). */
  const seriesSeen = new Map<string, Array<{ title: string; start: string; end: string; original?: string }>>();
  let token: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const answer = await tool("google_calendar.search_events", { calendar_id: calendarId, time_min: now.toISOString(), time_max: new Date(until).toISOString(),
      timezone_str: "UTC", max_results: 250, ...(token ? { next_page_token: token } : {}) });
    for (const event of listIn(answer, "events")) {
      const id = String(event.id ?? ""); if (!id) continue;
      const row = { title: String(event.summary ?? ""), start: String(event.start ?? ""), end: String(event.end ?? "") };
      seen.set(id, row);
      if (typeof event.recurring_event_id === "string") {
        const original = originalStartOf(event);
        seriesSeen.set(event.recurring_event_id, [...seriesSeen.get(event.recurring_event_id) ?? [], { ...row, ...(original ? { original } : {}) }]);
      }
    }
    token = typeof (answer as { next_page_token?: unknown })?.next_page_token === "string" ? (answer as { next_page_token: string }).next_page_token : undefined;
    if (!token) break;
  }
  const result: GooglePublishResult = { calendar: prefix ? "primary" : "crossline", created: 0, updated: 0, deleted: 0, unchanged: 0, keptAsEdited: 0 };
  const inWindow = (entry: Entry) => Date.parse(entry.start) < until;
  const shown = (eventId: string) => seen.has(eventId) || seriesSeen.has(eventId);
  /**
   * Whether one occurrence of a series was moved, renamed or deleted on its own: every occurrence Google shows must sit where the rule as
   * written puts it, and every occurrence the rule puts in the window must be shown. Entries from before the rule was kept are not checked.
   */
  const occurrenceChanged = (entry: Entry): boolean => {
    const recurrence = entry.series?.recurrence;
    const rows = seriesSeen.get(entry.eventId) ?? [];
    if (rows.some((row) => row.title !== entry.title)) return true;
    if (!recurrence) return false;
    const notBefore = Date.parse(entry.series?.dtstart ?? entry.start);
    const expected = new Map(occurrences(recurrence, now.getTime(), until, notBefore).map(([start, end]) => [start, end]));
    const originals = new Set<number>();
    for (const row of rows) {
      const original = Date.parse(row.original ?? row.start);
      if (original < notBefore) continue;
      originals.add(original);
      const end = expected.get(original);
      if (end === undefined || Date.parse(row.start) !== original || Date.parse(row.end) !== end) return true;
    }
    return [...expected.keys()].some((start) => !originals.has(start));
  };
  /** Whether the person has taken this event over: moved, renamed or deleted it (or, for a series, one of its occurrences) since it was written. */
  const takenOver = (entry: Entry): "edited" | "deleted" | undefined => {
    if (entry.edited) return "edited";
    if (entry.removedByPerson) return "deleted";
    if (entry.series) {
      if (entry.series.until < now.toISOString().slice(0, 10)) return undefined;
      if (!seriesSeen.has(entry.eventId)) return seen.has(entry.eventId) ? undefined : "deleted";
      return occurrenceChanged(entry) ? "edited" : undefined;
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
    let entry = ledger.events[block.id];
    const title = `${prefix}${block.title}`;
    // A create that never answered: on the calendar under its id, Google made it as asked and it is ours; not there, it is asked for again
    // under the same id below.
    if (entry?.unconfirmed) {
      const { unconfirmed: _unconfirmed, ...asked } = entry;
      entry = shown(asked.eventId) ? ledger.events[block.id] = asked : undefined;
    }
    if (entry) {
      const taken = takenOver(entry);
      if (taken === "edited") { ledger.events[block.id] = { ...entry, edited: true }; result.keptAsEdited += 1; continue; }
      if (taken === "deleted") { ledger.events[block.id] = { ...entry, removedByPerson: true }; result.keptAsEdited += 1; continue; }
      const same = block.recurrence ? entry.series?.hash === seriesHash(block) : entry.title === title && sameInstant(entry.start, block.start) && sameInstant(entry.end, block.end);
      if (same) {
        // A series written before its rule was kept gets it now (its next occurrence as the earliest one to check).
        if (block.recurrence && entry.series && !entry.series.recurrence) ledger.events[block.id] = { ...entry, series: { ...entry.series, recurrence: block.recurrence, dtstart: block.start } };
        result.unchanged += 1; continue;
      }
      await tool("google_calendar.update_event", { event_id: entry.eventId, calendar_id: calendarId, ...write(block), ...(block.recurrence ? { update_scope: "entire_series" } : {}) });
      // A series keeps its first occurrence as its start: the block's start is the next occurrence, and a later removal reading that as
      // 「not begun yet」 deleted the whole series, past occurrences included (deletes only in the future).
      const start = block.recurrence && entry.series && Date.parse(entry.start) < Date.parse(block.start) ? entry.start : block.start;
      ledger.events[block.id] = { eventId: entry.eventId, title, start, end: block.end, ...seriesOf(block) };
      result.updated += 1;
      continue;
    }
    const eventId = googleEventId(block.id, ledger.generations?.[block.id] ?? 0);
    const asked: Entry = { eventId, title, start: block.start, end: block.end, ...seriesOf(block) };
    // Recorded before the call: if it times out after Google made the event, the next run finds it under this id instead of making another.
    ledger.events[block.id] = { ...asked, unconfirmed: true };
    const create = (withId: boolean) => tool("google_calendar.create_event", { calendar_id: calendarId, ...(withId ? { event_id: eventId } : {}), attendees: [], self_attendance: "omit",
      add_google_meet: false, ...write(block) });
    try {
      // A connector that refuses the id argument itself still gets the event made, without the retry guarantee (as before ids were asked for).
      const created = await create(true).catch((error: unknown) => {
        if (isDuplicate(error) || !/event_id/.test(error instanceof Error ? error.message : String(error))) throw error;
        return create(false);
      });
      const madeId = idIn(created);
      if (!madeId) throw new Error("GOOGLE_CREATE_NO_ID");
      ledger.events[block.id] = { ...asked, eventId: madeId };
      result.created += 1;
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      // Google already holds an event under this id: an earlier create of ours went through. Shown as asked, it is ours; shown otherwise, or
      // not shown inside the read window (deleted events keep their id), the person has had it since — never overwritten, never made again.
      const taken = takenOver(asked);
      ledger.events[block.id] = taken === "edited" ? { ...asked, edited: true } : taken === "deleted" ? { ...asked, removedByPerson: true } : asked;
      if (taken) result.keptAsEdited += 1; else result.unchanged += 1;
    }
  }
  // Gone from the plan: deleted while still to come and still ours; a past or taken-over one only leaves the record.
  const present = new Set(wanted.map((block) => block.id));
  /** The record goes; the block's next event (if it comes back) asks for a new id, since Google keeps a deleted event's id. */
  const forget = (id: string) => { delete ledger.events[id]; ledger.generations = { ...ledger.generations, [id]: (ledger.generations?.[id] ?? 0) + 1 }; };
  for (const [id, entry] of Object.entries(ledger.events)) {
    if (present.has(id)) continue;
    const today = now.toISOString().slice(0, 10);
    // A create that never answered and is not on the calendar: inside the window there is nothing to delete; beyond it, it may exist.
    if (entry.unconfirmed && !shown(entry.eventId)) {
      if (!inWindow(entry) && Date.parse(entry.start) > now.getTime()) await tool("google_calendar.delete_event", { event_id: entry.eventId, calendar_id: calendarId }).catch(() => undefined);
      forget(id);
      continue;
    }
    const ours = !takenOver(entry);
    if (ours && Date.parse(entry.start) > now.getTime()) { await tool("google_calendar.delete_event", { event_id: entry.eventId, calendar_id: calendarId }); result.deleted += 1; }
    else if (ours && entry.series && entry.series.until >= today && entry.series.rule.length) {
      // A series already under way ends today instead of being deleted: its past occurrences stay (deletes only in the future).
      const end = `${today.replace(/-/g, "")}T000000Z`;
      await tool("google_calendar.update_event", { event_id: entry.eventId, calendar_id: calendarId, update_scope: "entire_series",
        recurrence: entry.series.rule.map((line) => line.startsWith("RRULE:") ? line.replace(/UNTIL=[0-9TZ]+/, `UNTIL=${end}`) : line) });
      result.deleted += 1;
    }
    forget(id);
  }
  return { result, ledger };
}
