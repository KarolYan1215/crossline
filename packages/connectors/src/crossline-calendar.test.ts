import { describe, expect, test } from "vitest";
import { CROSSLINE_CALENDAR_NAME, CrosslineCalendarWriter, eventHash, OWNER_PROPERTY_ID, type PublishBlock, type PublishLedger } from "./crossline-calendar";

type Event = { id: string; subject: string; start: { dateTime: string }; end: { dateTime: string }; isReminderOn?: boolean; reminderMinutesBeforeStart?: number; singleValueExtendedProperties?: Array<{ id: string; value: string }> };
type Calendar = { id: string; name: string; isDefaultCalendar: boolean; events: Event[] };

/** The way Graph writes a time back: seven fractional digits, no zone. */
const spell = (value: string) => `${value.replace(/\.\d+$/, "")}.0000000`;

/** A small Graph: the person's calendars with their own events, whatever the writer is allowed to add, and a record of every request. */
function fakeGraph(seed: Calendar[], options: { forbid?: number } = {}) {
  const calendars = seed;
  const requests: Array<{ method: string; path: string }> = [];
  let ids = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname.replace("/v1.0", ""));
    requests.push({ method, path });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (options.forbid && requests.length === options.forbid) return new Response("", { status: 403 });
    if (method === "GET" && path === "/me/calendars") return json({ value: calendars.map(({ id, name, isDefaultCalendar }) => ({ id, name, isDefaultCalendar })) });
    if (method === "POST" && path === "/me/calendars") { const made = { id: `cal-${(ids += 1)}`, name: body.name, isDefaultCalendar: false, events: [] }; calendars.push(made); return json({ id: made.id, name: made.name }, 201); }
    const match = /^\/me\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (!match) return json({}, 404);
    const calendar = calendars.find((item) => item.id === match[1]);
    if (!calendar) return json({}, 404);
    if (method === "GET") {
      return json({ value: calendar.events.map((event) => ({ ...event, singleValueExtendedProperties: event.singleValueExtendedProperties?.filter((p) => p.id === OWNER_PROPERTY_ID) })) });
    }
    if (method === "POST") {
      const made: Event = { id: `ev-${(ids += 1)}`, subject: body.subject, start: { dateTime: spell(body.start.dateTime) }, end: { dateTime: spell(body.end.dateTime) },
        isReminderOn: body.isReminderOn, ...(body.reminderMinutesBeforeStart !== undefined ? { reminderMinutesBeforeStart: body.reminderMinutesBeforeStart } : {}),
        singleValueExtendedProperties: body.singleValueExtendedProperties };
      calendar.events.push(made);
      return json({ id: made.id }, 201);
    }
    const event = calendar.events.find((item) => item.id === match[2]);
    if (!event) return json({}, 404);
    if (method === "PATCH") { if (body.subject) event.subject = body.subject; if (body.start) event.start = { dateTime: spell(body.start.dateTime) }; if (body.end) event.end = { dateTime: spell(body.end.dateTime) };
      if (body.isReminderOn !== undefined) event.isReminderOn = body.isReminderOn; if (body.reminderMinutesBeforeStart !== undefined) event.reminderMinutesBeforeStart = body.reminderMinutesBeforeStart;
      return json({ id: event.id }); }
    if (method === "DELETE") { calendar.events.splice(calendar.events.indexOf(event), 1); return new Response(null, { status: 204 }); }
    return json({}, 405);
  }) as typeof fetch;
  return { fetchImpl, calendars, requests };
}

const NOW = new Date("2026-10-12T12:00:00.000Z");
const human = (): Calendar[] => [
  { id: "main", name: "Calendar", isDefaultCalendar: true, events: [{ id: "h1", subject: "组会", start: { dateTime: "2026-10-13T15:00:00.0000000" }, end: { dateTime: "2026-10-13T16:00:00.0000000" } }] },
  { id: "classes", name: "课程", isDefaultCalendar: false, events: [{ id: "h2", subject: "ECE 555", start: { dateTime: "2026-10-14T19:30:00.0000000" }, end: { dateTime: "2026-10-14T20:45:00.0000000" } }] }
];
const block = (id: string, title: string, start: string, end: string): PublishBlock => ({ id, title, start, end });
const writer = (graph: ReturnType<typeof fakeGraph>) => new CrosslineCalendarWriter({ credential: { getAccessToken: async () => "token" }, fetchImpl: graph.fetchImpl, now: () => NOW });
const crossline = (graph: ReturnType<typeof fakeGraph>) => graph.calendars.find((calendar) => calendar.name === CROSSLINE_CALENDAR_NAME)!;
const writes = (graph: ReturnType<typeof fakeGraph>) => graph.requests.filter((request) => request.method !== "GET");

describe("publishing the plan's blocks", () => {
  test("makes the Crossline calendar when there is none, puts the blocks in it, and touches no other calendar", async () => {
    const graph = fakeGraph(human());
    const { result, ledger } = await writer(graph).publish([block("scheduled:a:1", "整理 SRAM 笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {});
    expect(result).toMatchObject({ created: 1, updated: 0, deleted: 0 });
    expect(crossline(graph).events).toHaveLength(1);
    expect(crossline(graph).events[0]!.singleValueExtendedProperties).toEqual([{ id: OWNER_PROPERTY_ID, value: "scheduled:a:1" }]);
    expect(ledger["scheduled:a:1"]).toBeDefined();
    // The person's own calendars are exactly as they were.
    expect(graph.calendars.find((calendar) => calendar.id === "main")!.events.map((event) => event.id)).toEqual(["h1"]);
    expect(graph.calendars.find((calendar) => calendar.id === "classes")!.events.map((event) => event.id)).toEqual(["h2"]);
    for (const request of writes(graph)) expect(request.path === "/me/calendars" || request.path.startsWith(`/me/calendars/${crossline(graph).id}/events`), JSON.stringify(request)).toBe(true);
  });

  test("an existing Crossline calendar is used; a calendar merely called Crossline that is the default one is not", async () => {
    const withIt = human().concat([{ id: "xl", name: "Crossline", isDefaultCalendar: false, events: [] }]);
    const graph = fakeGraph(withIt);
    await writer(graph).publish([block("b1", "x", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {});
    expect(graph.calendars.filter((calendar) => calendar.name === "Crossline")).toHaveLength(1);
    expect(graph.calendars.find((calendar) => calendar.id === "xl")!.events).toHaveLength(1);
    const trap = fakeGraph([{ id: "main", name: "Crossline", isDefaultCalendar: true, events: [] }]);
    await writer(trap).publish([block("b1", "x", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {});
    expect(trap.calendars.find((calendar) => calendar.id === "main")!.events).toHaveLength(0);
    expect(trap.calendars).toHaveLength(2);
  });

  test("running it again changes nothing, and a moved block moves its event", async () => {
    const graph = fakeGraph(human());
    const first = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {});
    const again = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], first.ledger);
    expect(again.result).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const moved = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T16:00:00Z", "2026-10-13T17:00:00Z")], again.ledger);
    expect(moved.result).toMatchObject({ updated: 1 });
    expect(crossline(graph).events[0]!.start.dateTime).toContain("2026-10-13T16:00");
  });

  test("a block the plan dropped is removed if it is in the future and untouched, and kept if it already happened", async () => {
    const graph = fakeGraph(human());
    const blocks = [block("future", "之后", "2026-10-14T14:00:00Z", "2026-10-14T15:00:00Z"), block("soon", "马上", "2026-10-12T13:00:00Z", "2026-10-12T14:00:00Z")];
    const first = await writer(graph).publish(blocks, {});
    const later = new CrosslineCalendarWriter({ credential: { getAccessToken: async () => "t" }, fetchImpl: graph.fetchImpl, now: () => new Date("2026-10-12T13:30:00Z") });
    const second = await later.publish([], first.ledger);
    expect(second.result.deleted).toBe(1);
    expect(crossline(graph).events.map((event) => event.subject)).toEqual(["马上"]);
  });
});

describe("what is the person's is never touched", () => {
  test("an event they put in the Crossline calendar by hand is neither changed nor removed", async () => {
    const seeded = human().concat([{ id: "xl", name: "Crossline", isDefaultCalendar: false, events: [{ id: "mine", subject: "我手动加的", start: { dateTime: "2026-10-15T10:00:00.0000000" }, end: { dateTime: "2026-10-15T11:00:00.0000000" } }] }]);
    const graph = fakeGraph(seeded);
    const first = await writer(graph).publish([block("b1", "x", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {});
    await writer(graph).publish([], first.ledger);
    expect(crossline(graph).events.map((event) => event.id)).toEqual(["mine"]);
    expect(writes(graph).some((request) => request.path.endsWith("/mine"))).toBe(false);
  });

  test("an event of ours that they moved or renamed is left exactly as they made it, and reported", async () => {
    const graph = fakeGraph(human());
    const first = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {});
    const event = crossline(graph).events[0]!;
    event.subject = "改成我自己的名字";
    const second = await writer(graph).publish([block("b1", "整理笔记（新）", "2026-10-13T16:00:00Z", "2026-10-13T17:00:00Z")], first.ledger);
    expect(second.result).toMatchObject({ updated: 0, keptAsEdited: ["b1"] });
    expect(event.subject).toBe("改成我自己的名字");
    const dropped = await writer(graph).publish([], first.ledger);
    expect(dropped.result).toMatchObject({ deleted: 0, keptAsEdited: ["b1"] });
    expect(crossline(graph).events).toHaveLength(1);
  });

  test("with the record of what was written lost, nothing already there is overwritten", async () => {
    const graph = fakeGraph(human());
    await writer(graph).publish([block("b1", "x", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {});
    const lost: PublishLedger = {};
    const again = await writer(graph).publish([block("b1", "x2", "2026-10-13T18:00:00Z", "2026-10-13T19:00:00Z")], lost);
    expect(again.result).toMatchObject({ created: 0, updated: 0, keptAsEdited: ["b1"] });
  });

  test("across any sequence of publishes, every write names the Crossline calendar's own events and nothing of the person's", async () => {
    const spy = fakeGraph(human());
    const first = await writer(spy).publish([block("b1", "x", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z"), block("b2", "y", "2026-10-14T14:00:00Z", "2026-10-14T15:00:00Z")], {});
    await writer(spy).publish([block("b1", "x", "2026-10-13T16:00:00Z", "2026-10-13T17:00:00Z")], first.ledger);
    const target = crossline(spy).id;
    expect(writes(spy).length).toBeGreaterThan(0);
    for (const request of writes(spy)) {
      expect(request.path === "/me/calendars" || new RegExp(`^/me/calendars/${target}/events(/ev-\\d+)?$`).test(request.path), `${request.method} ${request.path}`).toBe(true);
    }
    expect(spy.calendars.find((calendar) => calendar.id === "main")!.events).toHaveLength(1);
    expect(spy.calendars.find((calendar) => calendar.id === "classes")!.events).toHaveLength(1);
  });
});

describe("failure", () => {
  test("a missing write permission is reported as such, not as a crash", async () => {
    const graph = fakeGraph(human(), { forbid: 3 });
    await expect(writer(graph).publish([block("b1", "x", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {})).rejects.toThrow("CALENDAR_WRITE_NOT_AUTHORIZED");
    const noToken = new CrosslineCalendarWriter({ credential: { getAccessToken: async () => undefined }, fetchImpl: graph.fetchImpl });
    await expect(noToken.publish([], {})).rejects.toThrow("CALENDAR_WRITE_NOT_AUTHORIZED");
  });

  test("the content hash is stable across the way Graph spells a time", () => {
    expect(eventHash("x", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")).toBe(eventHash("x", "2026-10-13T14:00:00.0000000", "2026-10-13T15:00:00.0000000"));
  });
});

describe("reminders", () => {
  const remind = (minutes: number | null): PublishBlock => ({ ...block("scheduled:a:1", "整理 SRAM 笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z"), reminderMinutes: minutes });

  test("a new event carries its reminder; the ledger remembers it", async () => {
    const graph = fakeGraph(human());
    const { ledger } = await writer(graph).publish([remind(10)], {});
    expect(crossline(graph).events[0]).toMatchObject({ isReminderOn: true, reminderMinutesBeforeStart: 10 });
    expect(ledger["scheduled:a:1"]!.reminder).toBe(10);
  });

  test("an event written before reminders existed is given its reminder, and nothing else changes", async () => {
    const graph = fakeGraph(human());
    const first = await writer(graph).publish([remind(null)], {});
    const legacy: PublishLedger = { "scheduled:a:1": { eventId: first.ledger["scheduled:a:1"]!.eventId, hash: first.ledger["scheduled:a:1"]!.hash } };
    const { result } = await writer(graph).publish([remind(10)], legacy);
    expect(result).toMatchObject({ updated: 1, keptAsEdited: [] });
    expect(crossline(graph).events[0]).toMatchObject({ subject: "整理 SRAM 笔记", isReminderOn: true, reminderMinutesBeforeStart: 10 });
  });

  test("a reminder the person changed by hand is theirs: the content still follows the plan, the reminder does not", async () => {
    const graph = fakeGraph(human());
    const first = await writer(graph).publish([remind(10)], {});
    crossline(graph).events[0]!.reminderMinutesBeforeStart = 30;
    const { result } = await writer(graph).publish([{ ...remind(10), title: "整理 SRAM 笔记（改）" }], first.ledger);
    expect(result.updated).toBe(1);
    expect(crossline(graph).events[0]).toMatchObject({ subject: "整理 SRAM 笔记（改）", reminderMinutesBeforeStart: 30 });
  });
});
