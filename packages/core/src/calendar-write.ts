import { CALENDAR_PUBLISH_FAILURE } from "./settings-keys";

/**
 * The four ways Crossline puts the person's confirmed events and work blocks on a calendar they already use (the owner's decision of
 * 2026-11-10, all four approved; docs/calendar-write-setup.md):
 *
 * - `ics`: a private subscription feed (`webcal://…/<token>.ics`) any calendar app can subscribe to. Read-only for the app; nothing is
 *   written anywhere by Crossline.
 * - `imip`: invitations mailed to the person's own address (iMIP, RFC 6047) from `calendar@mail.crossline.lol`; their mail app puts them on
 *   the calendar. Stable UIDs, SEQUENCE bumped on change, CANCEL on delete.
 * - `google`: the Google Calendar connector of the person's own ChatGPT login (the Codex runtime's apps), with the Graph writer's rules.
 *   This lifts the former rule 「Google Calendar is read-only」 for this one path.
 * - `graph`: the Crossline calendar in a Microsoft account (the original writer; needs `CROSSLINE_MS_CLIENT_ID` and a signed-in account).
 *
 * What every path writes is the same set — the person's confirmed fixed events and the plan's work blocks, titled 「主线 · 任务名」 — and
 * every path keeps the same boundary: only events Crossline made, never one the person changed, deletes only in the future, preview and
 * pencilled-in blocks never.
 */
export const CALENDAR_WRITE_PATHS = ["ics", "imip", "google", "graph"] as const;
export type CalendarWritePath = (typeof CALENDAR_WRITE_PATHS)[number];
export type CalendarWritePaths = Record<CalendarWritePath, boolean>;

/** Which paths the person turned on (`{ics, imip, google, graph}`). */
export const CALENDAR_WRITE_PATHS_SETTING = "calendar.write.paths";
/** The Microsoft account the Graph path writes with (device-code sign-in). */
export const CALENDAR_WRITE_ACCOUNT_SETTING = "calendar.write.account";
/** The feed's secret (path a); a new one invalidates every old link. */
export const CALENDAR_FEED_TOKEN_SETTING = "calendar.feed.token";
/** When the feed was last fetched (`{at}`): the only sign the feed path has that a calendar app reads it. */
export const CALENDAR_FEED_SEEN_SETTING = "calendar.feed.seen";
/** Where the invitations go (path b); the account's email when the person turned the path on, changeable. */
export const CALENDAR_IMIP_RECIPIENT_SETTING = "calendar.imip.recipient";
/** What was mailed for each event (`{[uid]: {sequence, hash, start, end, title}}`), so a change bumps SEQUENCE and a removal cancels. */
export const CALENDAR_IMIP_SENT_SETTING = "calendar.imip.sent";
/** The last good write of a path that keeps no event of its own (`{at, sent, cancelled}`). */
export const CALENDAR_IMIP_LAST_SETTING = "calendar.imip.last";
/** What the Google path wrote (`PublishLedger`-like, by block id), apart from Graph's `calendar.published`. */
export const CALENDAR_GOOGLE_LEDGER_SETTING = "calendar.published.google";
export const CALENDAR_GOOGLE_LAST_SETTING = "calendar.google.last";

/**
 * The paths that are on. Until the person chose, a workspace with a Microsoft account signed in for writing keeps writing there (the
 * only path that existed before 2026-11-10); every other path starts off.
 */
export function readWritePaths(raw: string | null | undefined, graphAccount: boolean): CalendarWritePaths {
  let stored: Partial<Record<CalendarWritePath, unknown>> = {};
  try { stored = raw ? JSON.parse(raw) as Partial<Record<CalendarWritePath, unknown>> : {}; } catch { stored = {}; }
  if (typeof stored !== "object" || stored === null) stored = {};
  return { ics: stored.ics === true, imip: stored.imip === true, google: stored.google === true,
    graph: typeof stored.graph === "boolean" ? stored.graph : graphAccount };
}

export const anyWritePathOn = (paths: CalendarWritePaths) => CALENDAR_WRITE_PATHS.some((path) => paths[path]);

/** Where each path keeps its last failure (`{code, message, at}`); Graph keeps the key it always had. */
export const calendarFailureKey = (path: CalendarWritePath) => path === "graph" ? CALENDAR_PUBLISH_FAILURE : `${CALENDAR_PUBLISH_FAILURE}.${path}`;

/** 「主线 · 任务名」: the title every path writes. No line, the task's name alone; a title that already says its line is not repeated. */
export function lineTitle(line: string | undefined, title: string): string {
  const name = title.trim();
  const label = line?.trim();
  if (!label || name.startsWith(`${label} · `)) return name;
  return `${label} · ${name}`;
}

/** A UID stable across runs for the same block or event, the same on every path that writes it (RFC 5545 §3.8.4.7: globally unique). */
export function calendarUid(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._:-]/g, "-")}@crossline.lol`;
}
