import { createHash } from "node:crypto";

/**
 * Writes the plan's own work blocks to one calendar named 「Crossline」 and nowhere else.
 *
 * The person's calendars are hard constraints the plan is built around: their meetings, classes and anything they placed by hand.
 * This writer is built so it cannot touch them, rather than so that it is careful not to. Every request that is not a read passes
 * `#assertWritable`, which allows exactly three things: creating the calendar named Crossline, creating an event in that calendar's
 * own events, and changing or deleting an event in it whose id was just read back **carrying this writer's marker**. An event
 * without the marker — one the person put in the Crossline calendar by hand, or anything in any other calendar — has no way past it.
 * An event that carries the marker but no longer matches what this writer last wrote has been edited by the person, and is theirs
 * from then on: it is neither updated nor deleted, and the result says so.
 */
export const CROSSLINE_CALENDAR_NAME = "Crossline";
/** The extended property that says an event was made by this writer; its value is the plan block's id. */
export const OWNER_PROPERTY_ID = "String {7b6f8f0a-3c1d-4a53-9a5e-2f4d6c1b9e11} Name crosslineBlockId";

export type PublishBlock = {
  id: string; title: string;
  /** ISO instants. */
  start: string; end: string;
  note?: string;
};
/** What was last written for each block, kept by the caller between runs: the event, and a hash of its content as written. */
export type PublishLedger = Record<string, { eventId: string; hash: string }>;
export type PublishResult = {
  calendarId: string; created: number; updated: number; deleted: number; unchanged: number;
  /** Blocks whose event the person has changed since; left exactly as they made it. */
  keptAsEdited: string[];
};

type Credential = { getAccessToken(): Promise<string | undefined> };
type GraphEvent = {
  id?: string; subject?: string; start?: { dateTime?: string }; end?: { dateTime?: string };
  singleValueExtendedProperties?: Array<{ id?: string; value?: string }>;
};

const BASE = "https://graph.microsoft.com/v1.0";
const minute = (instant: string) => new Date(Date.parse(instant.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(instant) ? instant : `${instant}Z`)).toISOString().slice(0, 16);
/** What identifies an event's content for the purpose of noticing a hand edit: its title and its two instants, to the minute. */
export const eventHash = (title: string, start: string, end: string) =>
  createHash("sha256").update(`${title}\n${minute(start)}\n${minute(end)}`).digest("hex").slice(0, 16);
const asGraphTime = (instant: string) => ({ dateTime: new Date(instant).toISOString().replace("Z", ""), timeZone: "UTC" });

export class CrosslineCalendarWriter {
  readonly #credential: Credential;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #calendarId = "";
  #owned = new Set<string>();

  constructor(config: { credential: Credential; fetchImpl?: typeof fetch; now?: () => Date }) {
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
    const token = await this.#credential.getAccessToken();
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

  /** The events in the Crossline calendar that this writer made, by block id. Everything else in there is the person's. */
  async #ownedEvents(calendarId: string): Promise<Map<string, GraphEvent & { id: string }>> {
    const owned = new Map<string, GraphEvent & { id: string }>();
    const filter = encodeURIComponent(`id eq '${OWNER_PROPERTY_ID}'`);
    let url: string | undefined = `/me/calendars/${encodeURIComponent(calendarId)}/events?$top=100&$select=id,subject,start,end&$expand=singleValueExtendedProperties($filter=${filter})`;
    for (let pages = 0; url && pages < 30; pages += 1) {
      const response = await this.#call("GET", url);
      if (!response.ok) throw new Error(`CALENDAR_EVENTS_FAILED:${response.status}`);
      const body = await response.json() as { value?: GraphEvent[]; "@odata.nextLink"?: string };
      for (const event of body.value ?? []) {
        const marker = event.singleValueExtendedProperties?.find((property) => property.id?.toLowerCase() === OWNER_PROPERTY_ID.toLowerCase());
        if (event.id && marker?.value) { owned.set(marker.value, event as GraphEvent & { id: string }); this.#owned.add(event.id); }
      }
      url = body["@odata.nextLink"];
    }
    return owned;
  }

  /**
   * Brings the calendar in line with `blocks`: makes the missing, moves the changed, removes the ones the plan dropped — in the
   * future only, and only events it made and the person has not touched.
   */
  async publish(blocks: PublishBlock[], ledger: PublishLedger): Promise<{ result: PublishResult; ledger: PublishLedger }> {
    const calendarId = await this.ensureCalendar();
    const owned = await this.#ownedEvents(calendarId);
    const now = this.#now().getTime();
    const next: PublishLedger = { ...ledger };
    const result: PublishResult = { calendarId, created: 0, updated: 0, deleted: 0, unchanged: 0, keptAsEdited: [] };
    const events = `/me/calendars/${encodeURIComponent(calendarId)}/events`;
    const wanted = new Set<string>();

    for (const block of blocks) {
      if (Date.parse(block.end) <= now) continue;
      wanted.add(block.id);
      const subject = block.title;
      const hash = eventHash(subject, block.start, block.end);
      const existing = owned.get(block.id);
      if (!existing) {
        const response = await this.#call("POST", events, {
          subject, start: asGraphTime(block.start), end: asGraphTime(block.end), categories: [CROSSLINE_CALENDAR_NAME], showAs: "free", isReminderOn: false,
          body: { contentType: "text", content: block.note ?? "由 Crossline 排入。在 Crossline 里改计划，这里会跟着变；在这里手动改过的，Crossline 之后不会再动它。" },
          singleValueExtendedProperties: [{ id: OWNER_PROPERTY_ID, value: block.id }]
        });
        const made = response.ok ? await response.json() as { id?: string } : undefined;
        if (!made?.id) throw new Error(`CALENDAR_EVENT_CREATE_FAILED:${response.status}`);
        this.#owned.add(made.id);
        next[block.id] = { eventId: made.id, hash };
        result.created += 1;
        continue;
      }
      const current = eventHash(existing.subject ?? "", existing.start?.dateTime ?? "", existing.end?.dateTime ?? "");
      const lastWritten = ledger[block.id];
      if (!lastWritten || lastWritten.eventId !== existing.id || lastWritten.hash !== current) {
        // Not what this writer left there: the person changed it (or the record of what was written is gone). Theirs now.
        result.keptAsEdited.push(block.id);
        continue;
      }
      if (current === hash) { result.unchanged += 1; continue; }
      const response = await this.#call("PATCH", `${events}/${encodeURIComponent(existing.id)}`, { subject, start: asGraphTime(block.start), end: asGraphTime(block.end) });
      if (!response.ok) throw new Error(`CALENDAR_EVENT_UPDATE_FAILED:${response.status}`);
      next[block.id] = { eventId: existing.id, hash };
      result.updated += 1;
    }

    // What the plan no longer has: removed only if it is still in the future and still exactly as written.
    for (const [blockId, event] of owned) {
      if (wanted.has(blockId)) continue;
      const lastWritten = ledger[blockId];
      const start = Date.parse(event.start?.dateTime ? minute(event.start.dateTime) + ":00Z" : "");
      if (!Number.isFinite(start) || start <= now) continue;
      if (!lastWritten || lastWritten.eventId !== event.id || lastWritten.hash !== eventHash(event.subject ?? "", event.start?.dateTime ?? "", event.end?.dateTime ?? "")) {
        result.keptAsEdited.push(blockId);
        continue;
      }
      const response = await this.#call("DELETE", `${events}/${encodeURIComponent(event.id)}`);
      if (!response.ok && response.status !== 404) throw new Error(`CALENDAR_EVENT_DELETE_FAILED:${response.status}`);
      delete next[blockId];
      result.deleted += 1;
    }
    return { result, ledger: next };
  }
}
