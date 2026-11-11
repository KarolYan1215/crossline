import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { CALENDAR_GOOGLE_LEDGER_SETTING } from "@crossline/core";
import { GOOGLE_PREFIX, GoogleInterruptedError, googleEventId, publishToGoogle, type GoogleBlock, type GoogleLedger } from "./google-calendar-writer";
import { publishGoogleCalendar } from "./google-calendar-publish";

const NOW = new Date("2026-11-10T12:00:00Z");

/** A Google calendar behind the connector's tools: events by id, and every call recorded. */
function fakeGoogle(calendars: Array<{ id: string; summary: string; access_role?: string }> = [{ id: "primary", summary: "me@gmail.com", access_role: "owner" }]) {
  const events = new Map<string, { calendar: string; summary: string; start: string; end: string; recurrence?: string[] }>();
  /** Ids Google has handed out, deleted ones included: like Google, a create under one of them answers 409. */
  const used = new Set<string>();
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let next = 1;
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const calendar = String(args.calendar_id ?? "primary");
    if (tool === "google_calendar.list_calendars") return { calendars };
    if (tool === "google_calendar.search_events") return { events: [...events.entries()].filter(([, event]) => event.calendar === calendar).map(([id, event]) => ({ id, summary: event.summary, start: event.start, end: event.end, recurring_event_id: null })) };
    if (tool === "google_calendar.create_event") {
      const id = typeof args.event_id === "string" ? args.event_id : `ev${next++}`;
      if (used.has(id)) throw new Error("GOOGLE_TOOL_FAILED:google_calendar.create_event:HttpError 409: The requested identifier already exists. (duplicate)");
      used.add(id);
      events.set(id, { calendar, summary: String(args.title), start: String(args.start_time), end: String(args.end_time), ...(args.recurrence ? { recurrence: args.recurrence as string[] } : {}) });
      return { event: { id } };
    }
    if (tool === "google_calendar.update_event") { const event = events.get(String(args.event_id))!; Object.assign(event, args.title ? { summary: args.title } : {}, args.start_time ? { start: args.start_time, end: args.end_time } : {}, args.recurrence ? { recurrence: args.recurrence } : {}); return { event: { id: args.event_id } }; }
    if (tool === "google_calendar.delete_event") { events.delete(String(args.event_id)); return { ok: true }; }
    throw new Error(`unexpected ${tool}`);
  };
  return { events, calls, call };
}

const block = (id: string, title: string, start: string, end: string): GoogleBlock => ({ id, title, start, end, reminderMinutes: 10 });

test("with no Crossline calendar it writes the primary calendar with a prefix, creates, updates, and deletes only its own future events", async () => {
  const google = fakeGoogle();
  google.events.set("mine", { calendar: "primary", summary: "Dentist", start: "2026-11-11T15:00:00Z", end: "2026-11-11T16:00:00Z" });
  const first = await publishToGoogle(google.call, [block("scheduled:o1", "科研 · 写论文", "2026-11-11T14:00:00Z", "2026-11-11T15:00:00Z"),
    block("fixed:mail-abc", "科研 · 组会", "2026-11-12T20:00:00Z", "2026-11-12T21:00:00Z"),
    // A pencilled-in block is never written, whatever reaches the writer.
    block("optional:o2:1", "预排", "2026-11-11T23:00:00Z", "2026-11-11T23:30:00Z")], { events: {} }, NOW);
  expect(first.result).toMatchObject({ calendar: "primary", created: 2, updated: 0, deleted: 0 });
  expect([...google.events.values()].map((event) => event.summary).sort()).toEqual(["Crossline · 科研 · 写论文", "Crossline · 科研 · 组会", "Dentist"]);
  const create = google.calls.find((item) => item.tool === "google_calendar.create_event")!.args;
  expect(create).toMatchObject({ attendees: [], add_google_meet: false, transparency: "transparent", reminders: { use_default: false, overrides: [{ method: "popup", minutes: 10 }] } });
  // The block moved and the fixed event was removed from the plan: one update, one delete; the person's own event is never touched.
  const second = await publishToGoogle(google.call, [block("scheduled:o1", "科研 · 写论文", "2026-11-11T16:00:00Z", "2026-11-11T17:00:00Z")], first.ledger, NOW);
  expect(second.result).toMatchObject({ created: 0, updated: 1, deleted: 1 });
  expect(google.events.get("mine")).toBeDefined();
  expect(google.calls.filter((item) => ["google_calendar.update_event", "google_calendar.delete_event"].includes(item.tool)).map((item) => item.args.event_id)).not.toContain("mine");
  expect(Object.keys(second.ledger.events)).toEqual(["scheduled:o1"]);
});

test("an event the person moved, renamed or deleted is theirs: never changed again and never created again", async () => {
  const google = fakeGoogle([{ id: "cal-crossline", summary: "Crossline", access_role: "owner" }]);
  const blocks = [block("scheduled:a", "A", "2026-11-11T14:00:00Z", "2026-11-11T15:00:00Z"), block("scheduled:b", "B", "2026-11-11T16:00:00Z", "2026-11-11T17:00:00Z")];
  const first = await publishToGoogle(google.call, blocks, { events: {} }, NOW);
  expect(first.ledger.calendarId).toBe("cal-crossline");
  expect([...google.events.values()].map((event) => event.summary)).toEqual(["A", "B"]);
  const [a, b] = [first.ledger.events["scheduled:a"]!.eventId, first.ledger.events["scheduled:b"]!.eventId];
  google.events.get(a)!.start = "2026-11-11T18:00:00Z"; google.events.get(a)!.end = "2026-11-11T19:00:00Z";
  google.events.delete(b);
  const moved = [block("scheduled:a", "A", "2026-11-11T13:00:00Z", "2026-11-11T14:00:00Z"), ...blocks.slice(1)];
  const second = await publishToGoogle(google.call, moved, first.ledger, NOW);
  expect(second.result).toMatchObject({ created: 0, updated: 0, keptAsEdited: 2 });
  expect(google.events.get(a)!.start).toBe("2026-11-11T18:00:00Z");
  expect(google.events.size).toBe(1);
  // Gone from the plan later: the edited one is not deleted either.
  const third = await publishToGoogle(google.call, [], second.ledger, NOW);
  expect(third.result.deleted).toBe(0);
  expect(google.events.has(a)).toBe(true);
});

test("past events are never deleted; a series under way ends today instead; a weekly series is one event with its RRULE", async () => {
  const google = fakeGoogle();
  const series: GoogleBlock = { id: "fixed:class", title: "研究 · 组会", start: "2026-11-12T20:00:00Z", end: "2026-11-12T21:00:00Z", reminderMinutes: 10,
    recurrence: { daysOfWeek: ["thursday"], startDate: "2026-11-12", endDate: "2026-12-17", localStart: "14:00", localEnd: "15:00", timeZone: "America/Chicago", exceptions: ["2026-11-26"] } };
  const first = await publishToGoogle(google.call, [series, block("scheduled:past", "P", "2026-11-11T14:00:00Z", "2026-11-11T15:00:00Z")], { events: {} }, NOW);
  const created = google.calls.find((item) => item.tool === "google_calendar.create_event" && item.args.recurrence)!.args;
  expect(created).toMatchObject({ timezone_str: "America/Chicago", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261217T235959Z", "EXDATE;TZID=America/Chicago:20261126T140000"] });
  // A day later both are under way or past: removing them deletes nothing; the series is cut at today.
  const later = new Date("2026-11-20T12:00:00Z");
  google.calls.length = 0;
  const second = await publishToGoogle(google.call, [], first.ledger, later);
  expect(google.calls.filter((item) => item.tool === "google_calendar.delete_event")).toEqual([]);
  expect(google.calls.find((item) => item.tool === "google_calendar.update_event")!.args).toMatchObject({ update_scope: "entire_series", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261120T000000Z", "EXDATE;TZID=America/Chicago:20261126T140000"] });
  expect(second.ledger.events).toEqual({});
});

test("a series changed after it began and then removed is cut at today, never deleted with its past occurrences", async () => {
  const google = fakeGoogle();
  const recurrence = { daysOfWeek: ["thursday"], startDate: "2026-11-12", endDate: "2026-12-17", localStart: "14:00", localEnd: "15:00", timeZone: "America/Chicago", exceptions: [] as string[] };
  const series: GoogleBlock = { id: "fixed:class", title: "研究 · 组会", start: "2026-11-12T20:00:00Z", end: "2026-11-12T21:00:00Z", reminderMinutes: 10, recurrence };
  const first = await publishToGoogle(google.call, [series], { events: {} }, NOW);
  // A week on, one Thursday is skipped: the plan hands the series with its next occurrence as the block's start.
  const changed: GoogleBlock = { ...series, start: "2026-11-26T20:00:00Z", end: "2026-11-26T21:00:00Z", recurrence: { ...recurrence, exceptions: ["2026-12-03"] } };
  const second = await publishToGoogle(google.call, [changed], first.ledger, new Date("2026-11-20T12:00:00Z"));
  google.calls.length = 0;
  await publishToGoogle(google.call, [], second.ledger, new Date("2026-11-21T12:00:00Z"));
  expect(google.calls.filter((item) => item.tool === "google_calendar.delete_event")).toEqual([]);
  expect(google.calls.find((item) => item.tool === "google_calendar.update_event")!.args).toMatchObject({ update_scope: "entire_series" });
});

test("only the allowlisted tools are called, and an interrupted run keeps what it wrote", async () => {
  const google = fakeGoogle();
  let creates = 0;
  const failing = async (tool: string, args: Record<string, unknown>) => { if (tool === "google_calendar.create_event" && ++creates === 2) throw new Error("boom"); return google.call(tool, args); };
  const error = await publishToGoogle(failing, [block("scheduled:a", "A", "2026-11-11T14:00:00Z", "2026-11-11T15:00:00Z"), block("scheduled:b", "B", "2026-11-11T16:00:00Z", "2026-11-11T17:00:00Z")],
    { events: {} }, NOW).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(GoogleInterruptedError);
  // The failed create stays recorded as asked for, so the next run looks for it under its id before asking again.
  expect(Object.keys((error as GoogleInterruptedError).ledger.events)).toEqual(["scheduled:a", "scheduled:b"]);
  expect((error as GoogleInterruptedError).ledger.events["scheduled:b"]).toMatchObject({ unconfirmed: true });
  const tools = new Set(google.calls.map((item) => item.tool));
  for (const tool of tools) expect(tool).toMatch(/^google_calendar\.(list_calendars|search_events|create_event|update_event|delete_event)$/);
});

test("a create that timed out after Google made the event is not made twice: found under its own id, or adopted on 409", async () => {
  const google = fakeGoogle();
  const a = block("scheduled:a", "A", "2026-11-11T14:00:00Z", "2026-11-11T15:00:00Z");
  // Google carries the create out, but the answer never arrives.
  const timingOut = async (tool: string, args: Record<string, unknown>) => { const answer = await google.call(tool, args); if (tool === "google_calendar.create_event") throw new Error("timeout"); return answer; };
  const error = await publishToGoogle(timingOut, [a], { events: {} }, NOW).catch((caught: unknown) => caught) as GoogleInterruptedError;
  expect(error).toBeInstanceOf(GoogleInterruptedError);
  expect(google.calls.find((item) => item.tool === "google_calendar.create_event")!.args.event_id).toBe(googleEventId("scheduled:a"));
  expect(googleEventId("scheduled:a")).toMatch(/^[a-v0-9]{5,1024}$/);
  // The next run finds it on the calendar under the id it asked for: no second create.
  const next = await publishToGoogle(google.call, [a], error.ledger, NOW);
  expect(next.result).toMatchObject({ created: 0, unchanged: 1 });
  expect(google.events.size).toBe(1);
  expect(next.ledger.events["scheduled:a"]).toEqual({ eventId: googleEventId("scheduled:a"), title: "Crossline · A", start: a.start, end: a.end });
  // Even with the record lost, asking again under the same id answers 409 and the event is adopted, not duplicated.
  const lost = await publishToGoogle(google.call, [a], { calendarId: "primary", prefix: GOOGLE_PREFIX, events: {} }, NOW);
  expect(lost.result).toMatchObject({ created: 0, unchanged: 1 });
  expect(google.events.size).toBe(1);
  expect(lost.ledger.events["scheduled:a"]?.edited).toBeUndefined();
});

test("a connector that refuses the event id argument still gets the event made", async () => {
  const google = fakeGoogle();
  const strict = async (tool: string, args: Record<string, unknown>) => {
    if (tool === "google_calendar.create_event" && "event_id" in args) throw new Error("GOOGLE_TOOL_FAILED:google_calendar.create_event:unexpected argument event_id");
    return google.call(tool, args);
  };
  const done = await publishToGoogle(strict, [block("scheduled:a", "A", "2026-11-11T14:00:00Z", "2026-11-11T15:00:00Z")], { events: {} }, NOW);
  expect(done.result.created).toBe(1);
  expect(done.ledger.events["scheduled:a"]).toMatchObject({ eventId: "ev1" });
  expect(done.ledger.events["scheduled:a"]?.unconfirmed).toBeUndefined();
});

test("after a timed-out create the person's delete or edit still wins; a block that comes back after removal gets a new event", async () => {
  const google = fakeGoogle();
  const a = block("scheduled:a", "A", "2026-11-11T14:00:00Z", "2026-11-11T15:00:00Z");
  const timingOut = async (tool: string, args: Record<string, unknown>) => { const answer = await google.call(tool, args); if (tool === "google_calendar.create_event") throw new Error("timeout"); return answer; };
  const error = await publishToGoogle(timingOut, [a], { events: {} }, NOW).catch((caught: unknown) => caught) as GoogleInterruptedError;
  // The person deleted it before the next run: asked again, Google answers 409 (it keeps the id) and nothing is made again.
  google.events.delete(googleEventId("scheduled:a"));
  const next = await publishToGoogle(google.call, [a], error.ledger, NOW);
  expect(next.result).toMatchObject({ created: 0, keptAsEdited: 1 });
  expect(next.ledger.events["scheduled:a"]).toMatchObject({ removedByPerson: true });
  expect(google.events.size).toBe(0);
  // Removed from the plan and later back: a fresh id, so it is created rather than taken for the person's.
  const b = block("scheduled:b", "B", "2026-11-12T14:00:00Z", "2026-11-12T15:00:00Z");
  const made = await publishToGoogle(google.call, [b], { events: {} }, NOW);
  const gone = await publishToGoogle(google.call, [], made.ledger, NOW);
  expect(gone.result.deleted).toBe(1);
  const back = await publishToGoogle(google.call, [b], gone.ledger, NOW);
  expect(back.result).toMatchObject({ created: 1, keptAsEdited: 0 });
  expect(back.ledger.events["scheduled:b"]!.eventId).toBe(googleEventId("scheduled:b", 1));
});

test("one occurrence of a series moved or deleted by the person makes the series theirs: never updated or cut again", async () => {
  const google = fakeGoogle();
  const recurrence = { daysOfWeek: ["thursday"], startDate: "2026-11-12", endDate: "2026-12-17", localStart: "14:00", localEnd: "15:00", timeZone: "America/Chicago", exceptions: [] as string[] };
  const series: GoogleBlock = { id: "fixed:class", title: "研究 · 组会", start: "2026-11-12T20:00:00Z", end: "2026-11-12T21:00:00Z", reminderMinutes: 10, recurrence };
  // Google lists a series as its single occurrences (Thursdays 14:00 Chicago = 20:00Z), each with its series id and original start.
  let instances: Array<{ id: string; summary: string; start: string; end: string; recurring_event_id: string; original_start_time: string }> = [];
  const listing = async (tool: string, args: Record<string, unknown>) => tool === "google_calendar.search_events"
    ? { events: instances.filter((row) => Date.parse(row.end) > Date.parse(String(args.time_min)) && Date.parse(row.start) < Date.parse(String(args.time_max))) } : google.call(tool, args);
  const first = await publishToGoogle(listing, [series], { events: {} }, NOW);
  const id = first.ledger.events["fixed:class"]!.eventId;
  const fresh = () => ["12", "19", "26"].map((day) => `2026-11-${day}`).concat(["2026-12-03", "2026-12-10", "2026-12-17"]).map((day) => {
    const start = `${day}T20:00:00Z`;
    return { id: `${id}_${day.replace(/-/g, "")}T200000Z`, summary: "Crossline · 研究 · 组会", start, end: `${day}T21:00:00Z`, recurring_event_id: id, original_start_time: start };
  });
  instances = fresh();
  // Untouched: nothing taken for the person's.
  const changed: GoogleBlock = { ...series, recurrence: { ...recurrence, exceptions: ["2026-12-10"] } };
  google.calls.length = 0;
  const second = await publishToGoogle(listing, [series], first.ledger, NOW);
  expect(second.result).toMatchObject({ unchanged: 1, keptAsEdited: 0 });
  // The person moves one class an hour later: the plan's change to the series is not written over it.
  instances = fresh().map((row, index) => index === 2 ? { ...row, start: "2026-11-26T21:00:00Z", end: "2026-11-26T22:00:00Z" } : row);
  const moved = await publishToGoogle(listing, [changed], second.ledger, NOW);
  expect(moved.result).toMatchObject({ updated: 0, keptAsEdited: 1 });
  expect(moved.ledger.events["fixed:class"]).toMatchObject({ edited: true });
  expect(google.calls.filter((item) => item.tool === "google_calendar.update_event")).toEqual([]);
  // The person deletes one class instead: the same; and removed from the plan later, the series is neither deleted nor cut.
  instances = fresh().filter((_, index) => index !== 1);
  const deleted = await publishToGoogle(listing, [changed], second.ledger, NOW);
  expect(deleted.result).toMatchObject({ updated: 0, keptAsEdited: 1 });
  google.calls.length = 0;
  await publishToGoogle(listing, [], second.ledger, NOW);
  expect(google.calls.filter((item) => ["google_calendar.update_event", "google_calendar.delete_event"].includes(item.tool))).toEqual([]);
});

test("the worker writes only through a connected Google app on the workspace's own runtime, and keeps the ledger", async () => {
  const store = new CrosslineStore(":memory:");
  const workspaceId = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  const google = fakeGoogle();
  const requests: string[] = [];
  const runtime = (connected: boolean) => ({ request: async (method: string, params: unknown) => {
    requests.push(method);
    if (method === "app/installed") return { apps: connected ? [{ id: "connector_947e0d954944416db111db556030eea6", enabled: true, callable: true }] : [] };
    if (method === "thread/start") return { thread: { id: "t1" } };
    if (method === "thread/unsubscribe") return {};
    const call = params as { tool: string; arguments: Record<string, unknown>; server: string };
    expect(call.server).toBe("codex_apps");
    return { structuredContent: await google.call(call.tool, call.arguments) };
  } });
  expect(await publishGoogleCalendar(store, workspaceId, runtime(false), [], () => NOW)).toMatchObject({ state: "blocked", code: "CALENDAR_GOOGLE_NOT_CONNECTED" });
  const done = await publishGoogleCalendar(store, workspaceId, runtime(true), [block("scheduled:a", "A", "2026-11-11T14:00:00Z", "2026-11-11T15:00:00Z")], () => NOW);
  expect(done).toMatchObject({ state: "published", result: { created: 1 } });
  expect((JSON.parse(store.getSetting(workspaceId, CALENDAR_GOOGLE_LEDGER_SETTING)!) as GoogleLedger).events["scheduled:a"]).toBeDefined();
  expect(requests).toContain("thread/unsubscribe");
  expect(GOOGLE_PREFIX).toBe("Crossline · ");
});
