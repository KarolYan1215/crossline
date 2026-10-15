import { describe, expect, test } from "vitest";
import { CROSSLINE_CALENDAR_NAME, CrosslineCalendarWriter, eventHash, OWNER_PROPERTY_ID, PublishInterruptedError, type PublishBlock, type PublishLedger } from "./crossline-calendar";

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

  test("an event of ours they dragged elsewhere is left where they put it and reported as moved, so the caller can lock it there", async () => {
    const graph = fakeGraph(human());
    const first = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {});
    const event = crossline(graph).events[0]!;
    event.start = { dateTime: "2026-10-13T18:00:00.0000000" };
    event.end = { dateTime: "2026-10-13T19:00:00.0000000" };
    const second = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], first.ledger);
    expect(second.edits.moved).toEqual([{ blockId: "b1", start: "2026-10-13T18:00:00.000Z", end: "2026-10-13T19:00:00.000Z" }]);
    expect(second.result).toMatchObject({ updated: 0, keptAsEdited: ["b1"] });
    expect(event.start.dateTime).toContain("2026-10-13T18:00");
    // Once the plan follows (the block is locked at the new time), nothing is reported or rewritten.
    const third = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T18:00:00Z", "2026-10-13T19:00:00Z")], second.ledger);
    expect(third.edits).toEqual({ moved: [], retitled: [], removed: [] });
    expect(third.result).toMatchObject({ updated: 0, unchanged: 1 });
  });

  test("an event of ours they only renamed keeps their title while its time keeps following the plan", async () => {
    const graph = fakeGraph(human());
    const first = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {});
    const event = crossline(graph).events[0]!;
    event.subject = "改成我自己的名字";
    const second = await writer(graph).publish([block("b1", "整理笔记（新）", "2026-10-13T16:00:00Z", "2026-10-13T17:00:00Z")], first.ledger);
    expect(second.edits.retitled).toEqual([{ blockId: "b1", title: "改成我自己的名字" }]);
    expect(second.result).toMatchObject({ updated: 1, keptAsEdited: [] });
    expect(event.subject).toBe("改成我自己的名字");
    expect(event.start.dateTime).toContain("2026-10-13T16:00");
  });

  test("an event of ours they deleted is not made again; a finished task's leftover is removed even if they changed it", async () => {
    const graph = fakeGraph(human());
    const first = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z"),
      block("b2", "画图", "2026-10-14T14:00:00Z", "2026-10-14T15:00:00Z")], {});
    crossline(graph).events.splice(0, 1);
    crossline(graph).events[0]!.subject = "画图（我的）";
    const second = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], first.ledger,
      { forceRemove: (id) => id === "b2" });
    expect(second.edits.removed).toEqual(["b1"]);
    expect(second.result).toMatchObject({ created: 0, deleted: 1 });
    expect(crossline(graph).events).toHaveLength(0);
    const third = await writer(graph).publish([block("b1", "整理笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], second.ledger);
    expect(third.result.created).toBe(0);
  });

  test("an orphan — our marker, no record at all — is removed when it lies ahead and written afresh if the plan still has it; a past one stays", async () => {
    // The owner's decision (2026-10-15): nobody can have changed an event relative to a record that never existed.
    const graph = fakeGraph(human());
    await writer(graph).publish([block("b1", "x", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z"), block("gone", "y", "2026-10-14T14:00:00Z", "2026-10-14T15:00:00Z"),
      block("past", "z", "2026-10-12T11:00:00Z", "2026-10-12T13:00:00Z")], {});
    const lost: PublishLedger = {};
    const again = await writer(graph).publish([block("b1", "x2", "2026-10-13T18:00:00Z", "2026-10-13T19:00:00Z")], lost);
    expect(again.result).toMatchObject({ created: 1, updated: 0, deleted: 2, keptAsEdited: [] });
    expect(crossline(graph).events.map((event) => [event.subject, event.start.dateTime.slice(0, 16)]).sort())
      .toEqual([["x2", "2026-10-13T18:00"], ["z", "2026-10-12T11:00"]]);
    expect(Object.keys(again.ledger)).toEqual(["b1"]);
    // Only the Crossline calendar's own events were touched.
    expect(graph.calendars.find((calendar) => calendar.id === "main")!.events.map((event) => event.id)).toEqual(["h1"]);
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
    // A record from before titles and times were kept apart: only the event and a hash of what was written.
    const written = crossline(graph).events[0]!;
    const legacy: PublishLedger = { "scheduled:a:1": { eventId: written.id, hash: eventHash(written.subject, written.start.dateTime, written.end.dateTime), title: "", start: "", end: "" } };
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

describe("records that must not be lost (the real account, 2026-10-15)", () => {
  test("two writes that overlapped read each other's work as the person's — the reason the caller runs them one at a time", async () => {
    const graph = fakeGraph(human());
    const first = await writer(graph).publish([block("b1", "x", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")], {});
    // One run moves the block; another, started from the record before that run wrote back, sees the event at the new time.
    await writer(graph).publish([block("b1", "x", "2026-10-13T16:00:00Z", "2026-10-13T17:00:00Z")], first.ledger);
    const stale = await writer(graph).publish([block("b1", "x", "2026-10-13T16:00:00Z", "2026-10-13T17:00:00Z")], first.ledger);
    expect(stale.edits.moved.map((item) => item.blockId)).toEqual(["b1"]);
  });

  test("a run that stops part way hands back what it already wrote, so the next run does not take it for the person's", async () => {
    const graph = fakeGraph(human(), { forbid: 5 });
    const blocks = ["b1", "b2", "b3"].map((id, index) => block(id, id, `2026-10-13T1${index + 4}:00:00Z`, `2026-10-13T1${index + 4}:30:00Z`));
    const failed = await writer(graph).publish(blocks, {}).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(PublishInterruptedError);
    expect((failed as PublishInterruptedError).message).toMatch(/^CALENDAR_WRITE_NOT_AUTHORIZED/);
    const kept = (failed as PublishInterruptedError).ledger;
    expect(Object.keys(kept)).toEqual(["b1"]);
    const retry = await writer(fakeGraphFrom(graph)).publish(blocks, kept);
    expect(retry.result).toMatchObject({ created: 2, unchanged: 1, keptAsEdited: [] });
    expect(retry.edits.moved).toEqual([]);
  });

  test("a second event for one block that is an exact copy of what was written is removed; one that differs is left alone", async () => {
    const graph = fakeGraph(human());
    const b1 = block("b1", "整理笔记", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z");
    const first = await writer(graph).publish([b1], {});
    const original = crossline(graph).events[0]!;
    crossline(graph).events.push({ ...original, id: "dup-same" }, { ...original, id: "dup-moved", start: { dateTime: "2026-10-13T18:00:00.0000000" }, end: { dateTime: "2026-10-13T19:00:00.0000000" } });
    const again = await writer(graph).publish([b1], first.ledger);
    expect(crossline(graph).events.map((event) => event.id).sort()).toEqual([original.id, "dup-moved"].sort());
    expect(again.result).toMatchObject({ deleted: 1, unchanged: 1, keptAsEdited: ["b1"] });
    expect(again.ledger["b1"]!.eventId).toBe(original.id);
  });
});

/** The same calendars, without the forbidding. */
function fakeGraphFrom(graph: ReturnType<typeof fakeGraph>) { return fakeGraph(graph.calendars); }
