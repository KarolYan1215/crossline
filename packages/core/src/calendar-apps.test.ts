import { expect, test } from "vitest";
import { CALENDAR_APPS, calendarAppStatuses, safeInstallUrl } from "./calendar-apps";

// The calendar entries of the owner's `app/installed` answer (apps/worker/src/testing/fixtures/apps-installed.json), plus one other app.
const installed = [
  { id: "asdk_app_69c18c28f1188191bf5b8445c4ab0a2e", runtimeName: "Notion", enabled: true, callable: true },
  { id: "connector_947e0d954944416db111db556030eea6", runtimeName: "Google Calendar", enabled: true, callable: true },
  { id: "connector_e6a7394682e24467ac68c60696f275a4", runtimeName: "Microsoft Outlook Calendar", enabled: true, callable: true }
];

test("the probe's connected calendars read as connected, with the install address app/read gave", () => {
  const metadata = { apps: CALENDAR_APPS.map(({ connectorId, app }) => ({ id: connectorId, installUrl: `https://chatgpt.com/apps/${app.replace(/_/g, "-")}/${connectorId}` })) };
  const statuses = calendarAppStatuses({ apps: installed }, metadata);
  expect(statuses.map((item) => [item.app, item.connected])).toEqual([["google_calendar", true], ["microsoft_outlook_calendar", true]]);
  expect(statuses[0]!.installUrl).toBe("https://chatgpt.com/apps/google-calendar/connector_947e0d954944416db111db556030eea6");
});

test("an app the account has not connected is offered with its address; with no metadata there is no button", () => {
  const statuses = calendarAppStatuses({ apps: [] }, { apps: [{ id: CALENDAR_APPS[1].connectorId, installUrl: "https://chatgpt.com/apps/x/y" }] });
  expect(statuses).toEqual([
    { app: "google_calendar", label: "Google 日历", connected: false, callable: false, installUrl: null },
    { app: "microsoft_outlook_calendar", label: "Outlook 日历", connected: false, callable: false, installUrl: "https://chatgpt.com/apps/x/y" }
  ]);
});

test("a disabled entry is not connected, and only https chatgpt.com addresses are passed on", () => {
  const [google] = calendarAppStatuses({ apps: [{ id: CALENDAR_APPS[0].connectorId, enabled: false, callable: true }] }, undefined);
  expect(google).toMatchObject({ connected: false, callable: false });
  expect(safeInstallUrl("http://chatgpt.com/apps/a")).toBeNull();
  expect(safeInstallUrl("https://chatgpt.com.evil.example/apps/a")).toBeNull();
  expect(safeInstallUrl("javascript:alert(1)")).toBeNull();
});
