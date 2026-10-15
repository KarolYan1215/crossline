import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createCalendarPublisher, readPublishLedger, WRITE_ACCOUNT_SETTING } from "./calendar-publish";

let store: CrosslineStore;
let ws: string;
beforeEach(() => { store = new CrosslineStore(":memory:"); ws = store.createPrincipalWithWorkspace("u", "w").workspace.id; });
afterEach(() => store.close());

const block = { id: "scheduled:a:1", title: "整理笔记", start: "2099-01-01T14:00:00Z", end: "2099-01-01T15:00:00Z" };
const credentialFor = () => ({ getAccessToken: async () => "token" });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
/** A Graph with a Crossline calendar that has no events yet; it makes whatever it is asked to. */
const graph = (log: string[]) => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  log.push(`${method} ${decodeURIComponent(url.pathname)}`);
  if (url.pathname.endsWith("/me/calendars") && method === "GET") return json({ value: [{ id: "main", name: "Calendar", isDefaultCalendar: true }, { id: "xl", name: "Crossline", isDefaultCalendar: false }] });
  if (url.pathname.endsWith("/events") && method === "GET") return json({ value: [] });
  if (url.pathname.endsWith("/events") && method === "POST") return json({ id: "ev-1" }, 201);
  return json({}, 404);
}) as typeof fetch;

test("with no account chosen for writing, nothing is written and the way to choose one is named", async () => {
  const log: string[] = [];
  const outcome = await createCalendarPublisher(store, ws, { credentialFor, fetchImpl: graph(log) })([block]);
  expect(outcome).toMatchObject({ state: "blocked", code: "CALENDAR_WRITE_NOT_AUTHORIZED", message: expect.stringContaining("登录") });
  expect(log).toEqual([]);
});

test("once an account is chosen, the blocks are written to the Crossline calendar, what was written is remembered, and the ledger gets provenance only", async () => {
  store.setSetting(ws, WRITE_ACCOUNT_SETTING, "acct-1");
  const log: string[] = [];
  const outcome = await createCalendarPublisher(store, ws, { credentialFor, fetchImpl: graph(log), now: () => new Date("2098-12-31T00:00:00Z") })([block]);
  expect(outcome).toMatchObject({ state: "published", account: "acct-1", result: { created: 1 } });
  expect(log.filter((line) => !line.startsWith("GET"))).toEqual(["POST /v1.0/me/calendars/xl/events"]);
  expect(readPublishLedger(store, ws)["scheduled:a:1"]).toMatchObject({ eventId: "ev-1" });
  const event = store.listEvents(ws, { type: "calendar.published" })[0]!;
  expect(event.payload).toMatchObject({ created: 1, keptAsEdited: 0 });
  expect(JSON.stringify(event.payload)).not.toContain("整理笔记");
});

test("a permission Microsoft has not granted is reported as the same missing authorisation, with the other calendars untouched", async () => {
  store.setSetting(ws, WRITE_ACCOUNT_SETTING, "acct-1");
  const refuse = (async () => new Response("", { status: 403 })) as typeof fetch;
  expect(await createCalendarPublisher(store, ws, { credentialFor, fetchImpl: refuse })([block])).toMatchObject({ state: "blocked", code: "CALENDAR_WRITE_NOT_AUTHORIZED" });
});

test("a work block the person dragged on their calendar is locked at the new time", async () => {
  store.setSetting(ws, WRITE_ACCOUNT_SETTING, "acct-1");
  store.setSetting(ws, "calendar.published", JSON.stringify({ "scheduled:a:1": { eventId: "ev-1", title: "整理笔记", start: block.start, end: block.end, reminder: null } }));
  const dragged = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/me/calendars") && method === "GET") return json({ value: [{ id: "xl", name: "Crossline", isDefaultCalendar: false }] });
    if (url.pathname.endsWith("/events") && method === "GET") return json({ value: [{ id: "ev-1", subject: "整理笔记",
      start: { dateTime: "2099-01-01T18:00:00.0000000" }, end: { dateTime: "2099-01-01T19:00:00.0000000" },
      singleValueExtendedProperties: [{ id: "String {7b6f8f0a-3c1d-4a53-9a5e-2f4d6c1b9e11} Name crosslineBlockId", value: "scheduled:a:1" }] }] });
    return json({}, 404);
  }) as typeof fetch;
  const outcome = await createCalendarPublisher(store, ws, { credentialFor, fetchImpl: dragged, now: () => new Date("2098-12-31T00:00:00Z") })([block]);
  expect(outcome).toMatchObject({ state: "published", result: { keptAsEdited: ["scheduled:a:1"] } });
  expect(JSON.parse(store.getSetting(ws, "schedule.frozen")!)).toEqual([{ blockId: "scheduled:a:1", reason: "locked", via: "calendar",
    start: "2099-01-01T18:00:00.000Z", end: "2099-01-01T19:00:00.000Z" }]);
});

/** A Graph that keeps what it is asked to write and answers each request a moment later, so two runs in flight would interleave. */
function slowGraph() {
  const events: Array<{ id: string; subject: string; start: { dateTime: string }; end: { dateTime: string }; blockId: string }> = [];
  let ids = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    if (url.pathname.endsWith("/me/calendars")) return json({ value: [{ id: "xl", name: "Crossline", isDefaultCalendar: false }] });
    if (url.pathname.endsWith("/events") && method === "GET") return json({ value: events.map((event) => ({ ...event,
      singleValueExtendedProperties: [{ id: "String {7b6f8f0a-3c1d-4a53-9a5e-2f4d6c1b9e11} Name crosslineBlockId", value: event.blockId }] })) });
    if (url.pathname.endsWith("/events") && method === "POST") {
      const made = { id: `ev-${(ids += 1)}`, subject: body.subject, start: { dateTime: body.start.dateTime }, end: { dateTime: body.end.dateTime }, blockId: body.singleValueExtendedProperties[0].value };
      events.push(made);
      return json({ id: made.id }, 201);
    }
    const event = events.find((item) => url.pathname.endsWith(`/${item.id}`));
    if (!event) return json({}, 404);
    if (method === "PATCH") { if (body.start) event.start = { dateTime: body.start.dateTime }; if (body.end) event.end = { dateTime: body.end.dateTime }; return json({ id: event.id }); }
    if (method === "DELETE") { events.splice(events.indexOf(event), 1); return new Response(null, { status: 204 }); }
    return json({}, 405);
  }) as typeof fetch;
  return { fetchImpl, events };
}

test("publishes that come together run one after another, so neither takes the other's writes for the person's", async () => {
  store.setSetting(ws, WRITE_ACCOUNT_SETTING, "acct-1");
  const graph = slowGraph();
  const publish = createCalendarPublisher(store, ws, { credentialFor, fetchImpl: graph.fetchImpl, now: () => new Date("2098-12-31T00:00:00Z") });
  const at = (hour: number, id: string) => ({ id, title: id, start: `2099-01-01T${hour}:00:00.000Z`, end: `2099-01-01T${hour}:30:00.000Z` });
  await publish([at(10, "scheduled:a:1"), at(11, "scheduled:b:1")]);
  // The ten-minute pass and the optimal plan landing, at once, with the blocks moved.
  // The second starts while the first is between moving the events and writing down that it did.
  const first = publish([at(14, "scheduled:a:1"), at(15, "scheduled:b:1")]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const [one, two] = await Promise.all([first, publish([at(14, "scheduled:a:1"), at(15, "scheduled:b:1"), at(16, "scheduled:c:1")])]);
  expect(one).toMatchObject({ state: "published", result: { keptAsEdited: [] } });
  expect(two).toMatchObject({ state: "published", result: { created: 1, keptAsEdited: [] } });
  expect(store.getSetting(ws, "schedule.frozen")).toBeFalsy();
  expect(graph.events.map((event) => event.blockId).sort()).toEqual(["scheduled:a:1", "scheduled:b:1", "scheduled:c:1"]);
  expect(Object.keys(readPublishLedger(store, ws)).sort()).toEqual(["scheduled:a:1", "scheduled:b:1", "scheduled:c:1"]);
});
