/**
 * The calendars the local Codex runtime reads through ChatGPT's connectors (docs/loop-and-scout.md §13), and whether each is connected.
 *
 * Two runtime calls answer it, both measured on the owner's runtime on 2026-10-12: `app/installed` (what this account has connected)
 * and `app/read` (metadata by id, including the official `installUrl`). The directory call `app/list` meets a Cloudflare challenge
 * (403) on every attempt and is not used: the connector ids below are ChatGPT's own, the same for every account, so the page never
 * needs the directory to find them.
 */
export const CALENDAR_APPS = [
  { app: "google_calendar", connectorId: "connector_947e0d954944416db111db556030eea6", label: "Google 日历" },
  { app: "microsoft_outlook_calendar", connectorId: "connector_e6a7394682e24467ac68c60696f275a4", label: "Outlook 日历" }
] as const;

export type CalendarAppId = (typeof CALENDAR_APPS)[number]["app"];

export type CalendarAppStatus = {
  app: CalendarAppId;
  label: string;
  /** Connected in ChatGPT and enabled for this runtime. */
  connected: boolean;
  /** Connected and its tools are usable right now. */
  callable: boolean;
  /** Where the person connects it, in their own browser. Only a chatgpt.com address is ever passed on. */
  installUrl: string | null;
};

type InstalledApp = { id?: unknown; enabled?: unknown; callable?: unknown };
type AppMetadata = { id?: unknown; installUrl?: unknown };

/** The page opens this address, so anything not on chatgpt.com over https is dropped rather than shown as a button. */
export function safeInstallUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function calendarAppStatuses(installed: unknown, metadata: unknown): CalendarAppStatus[] {
  const installedApps = (installed as { apps?: InstalledApp[] } | undefined)?.apps ?? [];
  const read = (metadata as { apps?: AppMetadata[] } | undefined)?.apps ?? [];
  return CALENDAR_APPS.map(({ app, connectorId, label }) => {
    const entry = installedApps.find((item) => item.id === connectorId);
    const connected = entry?.enabled === true;
    return {
      app, label, connected,
      callable: connected && entry?.callable === true,
      installUrl: safeInstallUrl(read.find((item) => item.id === connectorId)?.installUrl)
    };
  });
}
