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
