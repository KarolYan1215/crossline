import { afterEach, beforeEach, expect, test } from "vitest";
import { CALENDAR_SUBSCRIPTIONS_SETTING, readSubscriptions } from "@crossline/core";
import { createMemorySecretStore } from "@crossline/connectors";
import { CrosslineStore } from "@crossline/db";
import { addSubscription, removeSubscription, subscriptionSources } from "./calendar-subscriptions";
import { createGraphSync } from "./graph-sync";

const LINK = "webcal://p01-caldav.icloud.com/published/2/SECRET-TOKEN";
const calendar = (summary: string) => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Home",
  "BEGIN:VEVENT", "UID:a@example.com", `SUMMARY:${summary}`, "DTSTART:20261014T150000Z", "DTEND:20261014T160000Z", "END:VEVENT",
  "END:VCALENDAR", ""].join("\r\n");

let store: CrosslineStore;
let workspaceId: string;
let served: { body: string; type: string };
const fetched: string[] = [];
const deps = () => ({
  secrets, now: () => new Date("2026-10-14T12:00:00Z"),
  fetch: { isPublicHost: async () => true, fetchImpl: (async (url: string) => {
    fetched.push(url);
    return new Response(served.body, { status: 200, headers: { "content-type": served.type } });
  }) as typeof fetch }
});
let secrets = createMemorySecretStore();

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  secrets = createMemorySecretStore();
  served = { body: calendar("Dentist"), type: "text/calendar; charset=utf-8" };
  fetched.length = 0;
  store.savePlanVersion({ id: "plan-1", ownerId: "user-1", workspaceId, version: 1, status: "current", payload: { blocks: [] } });
});
afterEach(() => store.close());

test("a link is read once before it is kept; the ledger holds the label and host, the secret store the link", async () => {
  const added = await addSubscription(store, workspaceId, deps(), { link: LINK, label: "", timeZone: "America/Chicago" });
  expect(added).toMatchObject({ state: "added", events: 1, subscription: { label: "Home", host: "p01-caldav.icloud.com", lastEvents: 1 } });
  expect(fetched).toEqual(["https://p01-caldav.icloud.com/published/2/SECRET-TOKEN"]);
  const raw = store.getSetting(workspaceId, CALENDAR_SUBSCRIPTIONS_SETTING) ?? "";
  expect(raw).not.toContain("SECRET-TOKEN");
  const id = readSubscriptions(raw)[0]!.id;
  expect(await secrets.read(workspaceId, `ical-${id}`)).toBe("https://p01-caldav.icloud.com/published/2/SECRET-TOKEN");
});

test("a link that is not https, or that opens something other than a calendar, is refused and nothing is kept", async () => {
  expect(await addSubscription(store, workspaceId, deps(), { link: "http://example.com/a.ics", label: "", timeZone: "UTC" })).toMatchObject({ state: "blocked", code: "ICAL_LINK_INVALID" });
  served = { body: "<html>login</html>", type: "text/plain" };
  expect(await addSubscription(store, workspaceId, deps(), { link: LINK, label: "", timeZone: "UTC" })).toMatchObject({ state: "blocked", code: "ICAL_READ_FAILED" });
  served = { body: "x", type: "text/html" };
  expect(await addSubscription(store, workspaceId, deps(), { link: LINK, label: "", timeZone: "UTC" })).toMatchObject({ state: "blocked", code: "ICAL_READ_FAILED" });
  expect(store.getSetting(workspaceId, CALENDAR_SUBSCRIPTIONS_SETTING)).toBeUndefined();
});

test("a subscription's events reach the plan through the ordinary sync, follow the calendar, and leave when it is removed", async () => {
  await addSubscription(store, workspaceId, deps(), { link: LINK, label: "家里的日历", timeZone: "America/Chicago" });
  const sync = createGraphSync(store, workspaceId, { sources: () => subscriptionSources(store, workspaceId, deps(), () => "America/Chicago"),
    timeZone: "America/Chicago", now: () => new Date("2026-10-14T12:00:00Z") });
  const blocks = () => (store.listPlanVersions(workspaceId)[0]!.payload as { blocks: Array<{ title: string; start: string; source: string; sourceKey?: string }> }).blocks;
  expect(await sync()).toMatchObject({ state: "synced", changes: 1 });
  expect(blocks()).toEqual([expect.objectContaining({ title: "Dentist", start: "10:00", source: "家里的日历" })]);
  // Every read is the whole calendar: a renamed event replaces the old one rather than piling up beside it.
  served = { body: calendar("Dentist (moved room)"), type: "text/calendar" };
  await sync();
  expect(blocks().map((block) => block.title)).toEqual(["Dentist (moved room)"]);
  const id = readSubscriptions(store.getSetting(workspaceId, CALENDAR_SUBSCRIPTIONS_SETTING))[0]!.id;
  expect(removeSubscription(store, workspaceId, secrets, id)).toBe(true);
  expect(blocks()).toEqual([]);
  expect(await secrets.read(workspaceId, `ical-${id}`)).toBeUndefined();
});

test("a link that stops opening keeps its events in the plan and says why on the subscription", async () => {
  await addSubscription(store, workspaceId, deps(), { link: LINK, label: "", timeZone: "UTC" });
  const sync = createGraphSync(store, workspaceId, { sources: () => subscriptionSources(store, workspaceId, deps(), () => "UTC"),
    timeZone: "UTC", now: () => new Date("2026-10-14T12:00:00Z") });
  await sync();
  served = { body: "gone", type: "text/html" };
  expect(await sync()).toMatchObject({ state: "blocked", code: "ICAL_READ_FAILED" });
  expect((store.listPlanVersions(workspaceId)[0]!.payload as { blocks: unknown[] }).blocks).toHaveLength(1);
  expect(readSubscriptions(store.getSetting(workspaceId, CALENDAR_SUBSCRIPTIONS_SETTING))[0]!.lastError).toContain("读不到这个链接");
});
