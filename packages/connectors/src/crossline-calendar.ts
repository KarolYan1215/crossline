import { createHash } from "node:crypto";
import { tFor, type Locale } from "@crossline/i18n";
import { classifyCalendarEdits, type CalendarEdits, type PublishedEntry, type ReadBack } from "./calendar-edits";

/**
 * Writes the plan's own work blocks to one calendar named 「Crossline」 and nowhere else.
 *
 * The person's calendars are hard constraints the plan is built around: their meetings, classes and anything they placed by hand.
 * This writer is built so it cannot touch them, rather than so that it is careful not to. Every request that is not a read passes
 * `#assertWritable`, which allows exactly three things: creating the calendar named Crossline, creating an event in that calendar's
 * own events, and changing or deleting an event in it whose id was just read back **carrying this writer's marker**. An event
 * without the marker — one the person put in the Crossline calendar by hand, or anything in any other calendar — has no way past it.
 * What the person did to one of its events is judged by `classifyCalendarEdits` (moved = locked at the new time, renamed = their title
 * from now on, deleted = never written again), the same for any calendar.
 */
export const CROSSLINE_CALENDAR_NAME = "Crossline";
/** The extended property that says an event was made by this writer; its value is the plan block's id. */
export const OWNER_PROPERTY_ID = "String {7b6f8f0a-3c1d-4a53-9a5e-2f4d6c1b9e11} Name crosslineBlockId";

export type PublishBlock = {
  id: string; title: string;
  /** ISO instants. */
  start: string; end: string;
  note?: string;
  /** Minutes before the start to remind; absent or null means no reminder. Outlook and the phone deliver it. */
  reminderMinutes?: number | null;
  /**
   * A repeating series (a class every Monday and Friday) written as **one** event with a weekly recurrence, not one copy per week.
   * `start`/`end` are then the first occurrence's instants; the series itself is written in the person's local time and zone, so it
   * keeps its clock time across a daylight-saving change.
   */
  recurrence?: { daysOfWeek: string[]; startDate: string; endDate: string; localStart: string; localEnd: string; timeZone: string };
};
/**
 * What was last written for each block, kept by the caller between runs: the event, its title and instants as written, the reminder
 * it was given, the person's own title and whether they deleted it. An entry with only a `hash` is from before titles and times were
 * kept apart; `reminder` absent means one from before reminders existed, when every event was written with none.
 */
export type PublishLedger = Record<string, PublishedEntry>;
export type PublishResult = {
  calendarId: string; created: number; updated: number; deleted: number; unchanged: number;
  /** Blocks whose event the person has changed since; left exactly as they made it. */
  keptAsEdited: string[];
};

export type PublishOptions = {
  /** Which of this writer's events this call is responsible for (work blocks, or the person's fixed events); others are left as they are. */
  manages?: (blockId: string) => boolean;
  /** Blocks whose task is finished: their leftover future events go even if the person changed them. */
  forceRemove?: (blockId: string) => boolean;
};
/** A publish that stopped part way. `ledger` holds what was written before it stopped, for the caller to keep; the message keeps the cause's code. */
export class PublishInterruptedError extends Error {
  readonly ledger: PublishLedger;
  readonly original: unknown;
  constructor(original: unknown, ledger: PublishLedger) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "PublishInterruptedError";
    this.ledger = ledger;
    this.original = original;
  }
}

type Credential = { getAccessToken(): Promise<string | undefined> };
type GraphEvent = {
  id?: string; subject?: string; start?: { dateTime?: string }; end?: { dateTime?: string };
  isReminderOn?: boolean; reminderMinutesBeforeStart?: number;
  singleValueExtendedProperties?: Array<{ id?: string; value?: string }>;
};

const BASE = "https://graph.microsoft.com/v1.0";
const minute = (instant: string) => new Date(Date.parse(instant.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(instant) ? instant : `${instant}Z`)).toISOString().slice(0, 16);
/** What identifies an event's content for the purpose of noticing a hand edit: its title and its two instants, to the minute. */
export const eventHash = (title: string, start: string, end: string) =>
  createHash("sha256").update(`${title}\n${minute(start)}\n${minute(end)}`).digest("hex").slice(0, 16);
const asGraphTime = (instant: string) => ({ dateTime: new Date(instant).toISOString().replace("Z", ""), timeZone: "UTC" });
/** Graph's own names for the zones people here live in; anything else is passed through as the IANA name. */
const WINDOWS_ZONE: Record<string, string> = { "America/Chicago": "Central Standard Time", "America/New_York": "Eastern Standard Time",
  "America/Los_Angeles": "Pacific Standard Time", "America/Denver": "Mountain Standard Time", "Asia/Shanghai": "China Standard Time",
  "Asia/Hong_Kong": "China Standard Time", "Asia/Taipei": "Taipei Standard Time", "Europe/London": "GMT Standard Time", UTC: "UTC" };
const recurrenceKey = (recurrence: PublishBlock["recurrence"]) => recurrence
  ? `${recurrence.daysOfWeek.join(",")}|${recurrence.startDate}|${recurrence.endDate}|${recurrence.localStart}|${recurrence.localEnd}` : "";
/** A series' start, end and weekly pattern as Graph takes them. */
function seriesFields(recurrence: NonNullable<PublishBlock["recurrence"]>) {
  const timeZone = WINDOWS_ZONE[recurrence.timeZone] ?? recurrence.timeZone;
  return {
    start: { dateTime: `${recurrence.startDate}T${recurrence.localStart}:00`, timeZone },
    end: { dateTime: `${recurrence.startDate}T${recurrence.localEnd}:00`, timeZone },
    recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: recurrence.daysOfWeek, firstDayOfWeek: "monday" },
      range: { type: "endDate", startDate: recurrence.startDate, endDate: recurrence.endDate } }
  };
}

export class CrosslineCalendarWriter {
  readonly #credential: Credential;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #calendarId = "";
  #owned = new Set<string>();

  /** The language of the note this writer puts in an event it makes (the workspace's). */
  readonly #locale: Locale | undefined;

  constructor(config: { credential: Credential; fetchImpl?: typeof fetch; now?: () => Date; locale?: Locale }) {
    this.#locale = config.locale;
    this.#credential = config.credential;
    this.#fetch = config.fetchImpl ?? fetch;
    this.#now = config.now ?? (() => new Date());
  }

  /** The single gate every non-read request goes through. */
  #assertWritable(method: string, path: string, body?: Record<string, unknown>): void {
    if (method === "GET") return;
    if (method === "POST" && path === "/me/calendars") {
      if (body?.name !== CROSSLINE_CALENDAR_NAME) throw new Error("CALENDAR_WRITE_FORBIDDEN");
      return;
    }
    const events = this.#calendarId ? `/me/calendars/${encodeURIComponent(this.#calendarId)}/events` : "";
    if (method === "POST" && events && path === events) return;
    if (events && (method === "PATCH" || method === "DELETE") && path.startsWith(`${events}/`)) {
      const eventId = decodeURIComponent(path.slice(events.length + 1));
      if (this.#owned.has(eventId)) return;
    }
    throw new Error("CALENDAR_WRITE_FORBIDDEN");
  }

  async #call(method: string, pathOrUrl: string, body?: Record<string, unknown>): Promise<Response> {
    const path = pathOrUrl.startsWith(BASE) ? pathOrUrl.slice(BASE.length) : pathOrUrl;
    const route = path.split("?")[0]!;
    this.#assertWritable(method, route, body);
    const token = await this.#credential.getAccessToken().catch((error: unknown) => {
      // A sign-in that has lapsed (MSAL asks for interaction) is the person's to renew, not a failure to retry.
      const { name, errorCode } = (error ?? {}) as { name?: string; errorCode?: string };
      if (name === "InteractionRequiredAuthError" || ["invalid_grant", "interaction_required", "login_required", "consent_required"].includes(errorCode ?? ""))
        throw new Error("CALENDAR_WRITE_NOT_AUTHORIZED");
      throw error;
    });
    if (!token) throw new Error("CALENDAR_WRITE_NOT_AUTHORIZED");
    const response = await this.#fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"', ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.status === 401 || response.status === 403) throw new Error("CALENDAR_WRITE_NOT_AUTHORIZED");
    return response;
  }

  /** The Crossline calendar: found by exact name among calendars that are not the default one, or made. */
  async ensureCalendar(): Promise<string> {
    if (this.#calendarId) return this.#calendarId;
    const response = await this.#call("GET", "/me/calendars?$select=id,name,isDefaultCalendar&$top=100");
    if (!response.ok) throw new Error(`CALENDAR_LIST_FAILED:${response.status}`);
    const rows = ((await response.json()) as { value?: Array<{ id?: string; name?: string; isDefaultCalendar?: boolean }> }).value ?? [];
    const found = rows.find((row) => row.name === CROSSLINE_CALENDAR_NAME && row.isDefaultCalendar !== true && row.id);
    if (found?.id) { this.#calendarId = found.id; return found.id; }
    const created = await this.#call("POST", "/me/calendars", { name: CROSSLINE_CALENDAR_NAME });
    const made = created.ok ? await created.json() as { id?: string; name?: string } : undefined;
    // What came back must be the calendar that was asked for; anything else is not written to.
    if (!made?.id || made.name !== CROSSLINE_CALENDAR_NAME) throw new Error(`CALENDAR_CREATE_FAILED:${created.status}`);
    this.#calendarId = made.id;
    return made.id;
  }

  /**
   * The events in the Crossline calendar that this writer made, by block id — every copy, since two writes that once overlapped could
   * each have made one for the same block. Everything else in there is the person's.
   */
  async #ownedEvents(calendarId: string): Promise<Map<string, Array<GraphEvent & { id: string }>>> {
    const owned = new Map<string, Array<GraphEvent & { id: string }>>();
    const filter = encodeURIComponent(`id eq '${OWNER_PROPERTY_ID}'`);
    let url: string | undefined = `/me/calendars/${encodeURIComponent(calendarId)}/events?$top=100&$select=id,subject,start,end,isReminderOn,reminderMinutesBeforeStart&$expand=singleValueExtendedProperties($filter=${filter})`;
    for (let pages = 0; url && pages < 30; pages += 1) {
      const response = await this.#call("GET", url);
      if (!response.ok) throw new Error(`CALENDAR_EVENTS_FAILED:${response.status}`);
      const body = await response.json() as { value?: GraphEvent[]; "@odata.nextLink"?: string };
      for (const event of body.value ?? []) {
        const marker = event.singleValueExtendedProperties?.find((property) => property.id?.toLowerCase() === OWNER_PROPERTY_ID.toLowerCase());
        if (event.id && marker?.value) { owned.set(marker.value, [...owned.get(marker.value) ?? [], event as GraphEvent & { id: string }]); this.#owned.add(event.id); }
      }
      url = body["@odata.nextLink"];
    }
    return owned;
  }

  /**
   * Brings the calendar in line with `blocks`: makes the missing, moves the changed, removes the ones the plan dropped — in the
   * future only, and only events it made. What the person did since the last write comes back as `edits`: a moved event is left
   * where they put it (the caller locks that block there), a renamed one keeps their title while its time follows the plan, a deleted
   * one is not made again.
   */
  async publish(blocks: PublishBlock[], ledger: PublishLedger, options: PublishOptions = {}): Promise<{ result: PublishResult; ledger: PublishLedger; edits: CalendarEdits }> {
    // The record is updated in place as each event is written, so a failure part way hands back what was already done
    // (`PublishInterruptedError`). A record that forgot an event it had moved, made or removed read that as the person's doing next
    // time: a move became a lock, a made event became the person's for good, a removal became 「deleted by the person」.
    const next: PublishLedger = { ...ledger };
    try {
      return await this.#publishInto(blocks, ledger, options, next);
    } catch (error) {
      throw new PublishInterruptedError(error, next);
    }
  }

  async #publishInto(blocks: PublishBlock[], ledger: PublishLedger, options: PublishOptions, next: PublishLedger): Promise<{ result: PublishResult; ledger: PublishLedger; edits: CalendarEdits }> {
    const manages = options.manages ?? (() => true);
    const calendarId = await this.ensureCalendar();
    const copies = await this.#ownedEvents(calendarId);
    // One event per block: the one the record names, else the first. Any other is a copy, settled below.
    const owned = new Map<string, GraphEvent & { id: string }>();
    const extras: Array<{ blockId: string; event: GraphEvent & { id: string } }> = [];
    for (const [blockId, events] of copies) {
      const primary = events.find((event) => event.id === ledger[blockId]?.eventId) ?? events[0]!;
      owned.set(blockId, primary);
      for (const event of events) if (event !== primary) extras.push({ blockId, event });
    }
    const now = this.#now().getTime();
    const result: PublishResult = { calendarId, created: 0, updated: 0, deleted: 0, unchanged: 0, keptAsEdited: [] };
    const events = `/me/calendars/${encodeURIComponent(calendarId)}/events`;
    const instant = (dateTime: string | undefined) => dateTime ? new Date(`${minute(dateTime)}:00Z`).toISOString() : "";

    // A record from before titles and times were kept apart is upgraded when the event is still as written; otherwise the old rule holds.
    const legacyEdited = new Set<string>();
    for (const [blockId, entry] of Object.entries(ledger)) {
      if (!manages(blockId) || !entry.hash || entry.start) continue;
      const event = owned.get(blockId);
      if (!event) continue;
      if (event.id === entry.eventId && entry.hash === eventHash(event.subject ?? "", event.start?.dateTime ?? "", event.end?.dateTime ?? ""))
        next[blockId] = { eventId: event.id, title: event.subject ?? "", start: instant(event.start?.dateTime), end: instant(event.end?.dateTime),
          reminder: entry.reminder ?? null, ...(entry.recurrence ? { recurrence: entry.recurrence } : {}) };
      else legacyEdited.add(blockId);
    }
    const judged = Object.fromEntries(Object.entries(next).filter(([blockId, entry]) => manages(blockId) && entry.start && !entry.recurrence));
    const readBack: ReadBack[] = Object.entries(judged).flatMap(([blockId, entry]) => {
      const event = owned.get(blockId);
      return event && event.id === entry.eventId ? [{ blockId, eventId: event.id, title: event.subject ?? "", start: instant(event.start?.dateTime), end: instant(event.end?.dateTime) }] : [];
    });
    const edits = classifyCalendarEdits(judged, readBack, this.#now());
    const moved = new Set(edits.moved.map((item) => item.blockId));
    for (const item of edits.moved) next[item.blockId] = { ...next[item.blockId]!, start: item.start, end: item.end };
    for (const item of edits.retitled) next[item.blockId] = { ...next[item.blockId]!, personTitle: item.title };
    for (const blockId of edits.removed) next[blockId] = { ...next[blockId]!, removedByPerson: true };

    // A second event for one block, left by two writes that once overlapped. An exact copy of what was recorded for that block is this
    // writer's own and goes (future only); one that differs from the record may have been changed by the person and is left alone.
    // An event that carries this writer's marker but has no record at all is an orphan: made by a run whose record was then lost, so
    // nobody could have changed it relative to a record. The owner decided (2026-10-15) that a future orphan goes; a past one stays.
    const futureStart = (event: GraphEvent) => { const at = Date.parse(instant(event.start?.dateTime)); return Number.isFinite(at) && at > now; };
    const deleteEvent = async (event: GraphEvent & { id: string }) => {
      const response = await this.#call("DELETE", `${events}/${encodeURIComponent(event.id)}`);
      if (!response.ok && response.status !== 404) throw new Error(`CALENDAR_EVENT_DELETE_FAILED:${response.status}`);
      result.deleted += 1;
    };
    for (const { blockId, event } of extras) {
      if (!manages(blockId)) continue;
      if (!futureStart(event)) continue;
      const entry = ledger[blockId];
      if (!entry && !next[blockId]) { await deleteEvent(event); continue; }
      const copy = Boolean(entry?.start) && !entry!.recurrence && (event.subject ?? "") === (entry!.personTitle ?? entry!.title)
        && minute(event.start?.dateTime ?? "") === minute(entry!.start) && minute(event.end?.dateTime ?? "") === minute(entry!.end);
      if (!copy) { result.keptAsEdited.push(blockId); continue; }
      await deleteEvent(event);
    }

    const wanted = new Set<string>();
    for (const block of blocks) {
      // A series counts while its last day is ahead; a single event while it has not ended.
      if (block.recurrence ? block.recurrence.endDate < new Date(now).toISOString().slice(0, 10) : Date.parse(block.end) <= now) continue;
      wanted.add(block.id);
      const entry = next[block.id];
      if (entry?.removedByPerson) continue;
      const reminder = block.reminderMinutes ?? null;
      const reminderFields = reminder === null ? { isReminderOn: false } : { isReminderOn: true, reminderMinutesBeforeStart: reminder };
      const series = block.recurrence ? { recurrence: recurrenceKey(block.recurrence) } : {};
      let existing = owned.get(block.id);
      // A future orphan for a block the plan still has: removed and written afresh, so it is on record from now on.
      if (existing && !entry && futureStart(existing)) { await deleteEvent(existing); owned.delete(block.id); existing = undefined; }
      if (!existing) {
        const response = await this.#call("POST", events, {
          subject: block.title, start: asGraphTime(block.start), end: asGraphTime(block.end), categories: [CROSSLINE_CALENDAR_NAME], showAs: "free", ...reminderFields,
          ...(block.recurrence ? { ...seriesFields(block.recurrence), showAs: "busy" } : {}),
          body: { contentType: "text", content: block.note ?? tFor(this.#locale)("由 Crossline 排入。在 Crossline 里改计划，这里会跟着变；在这里拖到别的时间，Crossline 会把它锁定在那里；删掉它，Crossline 不会再放回来。") },
          singleValueExtendedProperties: [{ id: OWNER_PROPERTY_ID, value: block.id }]
        });
        const made = response.ok ? await response.json() as { id?: string } : undefined;
        if (!made?.id) throw new Error(`CALENDAR_EVENT_CREATE_FAILED:${response.status}`);
        this.#owned.add(made.id);
        next[block.id] = { eventId: made.id, title: block.title, start: block.start, end: block.end, reminder, ...series };
        result.created += 1;
        continue;
      }
      // Not what this writer left there, or the record of what was written is gone: the person's now, left exactly as it is.
      if (legacyEdited.has(block.id) || !entry || entry.eventId !== existing.id || moved.has(block.id)) {
        result.keptAsEdited.push(block.id);
        continue;
      }
      const subject = entry.personTitle ?? block.title;
      const timeChange = minute(existing.start?.dateTime ?? "") !== minute(block.start) || minute(existing.end?.dateTime ?? "") !== minute(block.end);
      const titleChange = (existing.subject ?? "") !== subject;
      // The reminder is the person's too once they change it: compared with what was last written (none, for an
      // entry from before reminders), and left alone when it differs — only the content keeps following the plan.
      const currentReminder = existing.isReminderOn ? existing.reminderMinutesBeforeStart ?? 0 : null;
      const reminderTheirs = currentReminder !== (entry.reminder ?? null);
      const reminderChange = !reminderTheirs && currentReminder !== reminder;
      const seriesChange = recurrenceKey(block.recurrence) !== (entry.recurrence ?? "");
      const written = { eventId: existing.id, title: block.title, ...(entry.personTitle ? { personTitle: entry.personTitle } : {}), start: block.start, end: block.end, ...series };
      if (!timeChange && !titleChange && !reminderChange && !seriesChange) {
        result.unchanged += 1;
        next[block.id] = { ...written, reminder: reminderTheirs ? entry.reminder ?? null : reminder };
        continue;
      }
      const response = await this.#call("PATCH", `${events}/${encodeURIComponent(existing.id)}`, {
        ...(timeChange || titleChange || seriesChange ? block.recurrence ? { subject, ...seriesFields(block.recurrence) } : { subject, start: asGraphTime(block.start), end: asGraphTime(block.end) } : {}),
        ...(reminderChange ? reminderFields : {}) });
      if (!response.ok) throw new Error(`CALENDAR_EVENT_UPDATE_FAILED:${response.status}`);
      next[block.id] = { ...written, reminder: reminderChange ? reminder : entry.reminder ?? null };
      result.updated += 1;
    }

    // What the plan no longer has: removed only if it is still in the future and the person has not made it theirs — unless its task is
    // finished, when a leftover event is only clutter.
    for (const [blockId, event] of owned) {
      if (wanted.has(blockId) || !manages(blockId)) continue;
      const entry = next[blockId];
      const start = Date.parse(event.start?.dateTime ? minute(event.start.dateTime) + ":00Z" : "");
      if (!Number.isFinite(start) || start <= now) continue;
      // No record at all: an orphan (above), removed. A record naming another event, a move or a title of theirs: the person's.
      const theirs = Boolean(entry) && (legacyEdited.has(blockId) || entry!.eventId !== event.id || moved.has(blockId) || Boolean(entry!.personTitle));
      if (theirs && !options.forceRemove?.(blockId)) {
        result.keptAsEdited.push(blockId);
        continue;
      }
      const response = await this.#call("DELETE", `${events}/${encodeURIComponent(event.id)}`);
      if (!response.ok && response.status !== 404) throw new Error(`CALENDAR_EVENT_DELETE_FAILED:${response.status}`);
      delete next[blockId];
      result.deleted += 1;
    }
    return { result, ledger: next, edits };
  }
}
