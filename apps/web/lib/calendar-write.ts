import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  anyWritePathOn, CALENDAR_FEED_SEEN_SETTING, CALENDAR_FEED_TOKEN_SETTING, CALENDAR_GOOGLE_LAST_SETTING, CALENDAR_IMIP_LAST_SETTING, CALENDAR_IMIP_RECIPIENT_SETTING,
  CALENDAR_IMIP_SENT_SETTING, CALENDAR_WRITE_ACCOUNT_SETTING, CALENDAR_WRITE_PATHS, CALENDAR_WRITE_PATHS_SETTING, calendarFailureKey, calendarUid, lineTitle, readWritePaths,
  type AccessContext, type CalendarWritePath, type CalendarWritePaths
} from "@crossline/core";
import { buildIcs, type IcsEvent } from "@crossline/connectors/ics-write";
import { getStore } from "./crossline";
import { blocksToPublish } from "./calendar-publish";
import { fixedEventsToPublish } from "./fixed-events";
import { identityLines } from "./lines";
import { tOf } from "./locale";

/**
 * The calendar paths of the owner's decision of 2026-11-10 (core `calendar-write.ts`): which are on, what each writes, and the two that
 * live in the web process — the private feed (a) and the mailed invitations (b). Google (c) and Microsoft (d) write from the worker.
 */
export function writePaths(workspaceId: string): CalendarWritePaths {
  const store = getStore();
  return readWritePaths(store.getSetting(workspaceId, CALENDAR_WRITE_PATHS_SETTING), Boolean(store.getSetting(workspaceId, CALENDAR_WRITE_ACCOUNT_SETTING)));
}
/** Whether anything Crossline puts on a calendar reaches one: any path on. 「创建」 on a fixed event is offered only then. */
export const calendarWriteOn = (ctx: AccessContext) => anyWritePathOn(writePaths(ctx.workspaceId));

export function setWritePaths(ctx: AccessContext, change: Partial<CalendarWritePaths>): CalendarWritePaths {
  const next = { ...writePaths(ctx.workspaceId), ...Object.fromEntries(Object.entries(change).filter(([key, value]) => (CALENDAR_WRITE_PATHS as readonly string[]).includes(key) && typeof value === "boolean")) };
  getStore().setSetting(ctx.workspaceId, CALENDAR_WRITE_PATHS_SETTING, JSON.stringify(next));
  return next;
}

/** One thing every path writes: a stable id and UID, 「主线 · 任务名」, the time, and a weekly series for a recurring fixed event. */
export type CalendarItem = { id: string; uid: string; title: string; start: string; end: string; reminderMinutes: number;
  series?: { weekdays: number[]; startDate: string; until: string; localStart: string; localEnd: string; timeZone: string; exceptions: string[];
    /** The same series in the shape the worker's writers read (Graph day names). */
    graph: { daysOfWeek: string[]; startDate: string; endDate: string; localStart: string; localEnd: string; timeZone: string; exceptions: string[] } } };

/**
 * The confirmed fixed events and the plan's work blocks — nothing else: no follow-up or deadline markers, no preview or pencilled-in
 * blocks (`blocksToPublish` takes `scheduled:` blocks only), no notes or materials. Titled 「主线 · 任务名」.
 */
export async function calendarItems(ctx: AccessContext, now = new Date(), options: { waitForOptimal?: boolean } = {}): Promise<{ items: CalendarItem[]; pending?: true }> {
  const store = getStore();
  const labels = new Map(identityLines(ctx).map((line) => [line.id, line.label]));
  const lineOfOrder = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.identityId]));
  const { blocks, pending } = await blocksToPublish(ctx, now, options);
  if (pending) return { items: [], pending };
  const work = blocks.filter((block) => block.id.startsWith("scheduled:")).map((block): CalendarItem => ({ id: block.id, uid: calendarUid(block.id),
    title: lineTitle(labels.get(lineOfOrder.get(block.id.split(":")[1] ?? "") ?? ""), block.title), start: block.start, end: block.end, reminderMinutes: block.reminderMinutes ?? 10 }));
  const fixed = fixedEventsToPublish(ctx, now).map((event): CalendarItem => ({ id: event.id, uid: calendarUid(event.id), title: lineTitle(labels.get(event.lineId), event.title),
    start: event.start, end: event.end, reminderMinutes: event.reminderMinutes,
    ...(event.recurrence ? { series: { weekdays: event.recurrence.weekdays, startDate: event.recurrence.startDate, until: event.recurrence.endDate,
      localStart: event.recurrence.localStart, localEnd: event.recurrence.localEnd, timeZone: event.recurrence.timeZone, exceptions: event.recurrence.exceptions,
      graph: { daysOfWeek: event.recurrence.daysOfWeek, startDate: event.recurrence.startDate, endDate: event.recurrence.endDate, localStart: event.recurrence.localStart,
        localEnd: event.recurrence.localEnd, timeZone: event.recurrence.timeZone, exceptions: event.recurrence.exceptions } } } : {}) }));
  return { items: [...fixed, ...work] };
}

const icsEvent = (item: CalendarItem, extra: Partial<IcsEvent> = {}): IcsEvent => ({ uid: item.uid, summary: item.title, start: item.start, end: item.end, alarmMinutes: item.reminderMinutes,
  ...(item.series ? { series: { weekdays: item.series.weekdays, startDate: item.series.startDate, until: item.series.until, localStart: item.series.localStart,
    localEnd: item.series.localEnd, timeZone: item.series.timeZone, exceptions: item.series.exceptions } } : {}), ...extra });

// ---------------------------------------------------------------------------------------------------------------- (a) the private feed

/** The feed's token, made on first use. 32 random bytes: the link is the only key, so it must not be guessable. */
export function feedToken(ctx: AccessContext): string {
  const store = getStore();
  const kept = store.getSetting(ctx.workspaceId, CALENDAR_FEED_TOKEN_SETTING);
  if (kept) return kept;
  return resetFeedToken(ctx);
}
/** A new token: every link given out before stops working at once. */
export function resetFeedToken(ctx: AccessContext): string {
  const token = randomBytes(32).toString("base64url");
  getStore().setSetting(ctx.workspaceId, CALENDAR_FEED_TOKEN_SETTING, token);
  return token;
}

/** The workspace whose feed this token opens, or undefined; compared in constant time. Only a workspace with the feed on answers. */
export function workspaceForFeedToken(token: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return undefined;
  const store = getStore();
  const wanted = Buffer.from(token);
  for (const workspace of store.listWorkspaces()) {
    const kept = store.getSetting(workspace.id, CALENDAR_FEED_TOKEN_SETTING);
    if (!kept) continue;
    const have = Buffer.from(kept);
    if (have.length === wanted.length && timingSafeEqual(have, wanted)) return writePaths(workspace.id).ics ? workspace.id : undefined;
  }
  return undefined;
}

/** The feed's text for a calendar app. Its fetch is the only sign the path works, so the time is kept for the settings card. */
export async function feedText(ctx: AccessContext, now = new Date()): Promise<string> {
  const { items } = await calendarItems(ctx, now);
  getStore().setSetting(ctx.workspaceId, CALENDAR_FEED_SEEN_SETTING, JSON.stringify({ at: now.toISOString(), events: items.length }));
  return buildIcs({ name: "Crossline", now, events: items.map((item) => icsEvent(item)) });
}

// ---------------------------------------------------------------------------------------------------------------- (b) mailed invitations

/** Work blocks are mailed this many days ahead: further ones still move with every re-plan, and each move would be another mail. */
export const IMIP_WORK_DAYS = 7;
/** At most this many mails a pass; the rest go with the next pass (ten minutes later). */
export const IMIP_PER_PASS = 20;
// i18n-ignore: a mail header display name, the same in every language
export const IMIP_FROM_DEFAULT = "Crossline 日历 <calendar@mail.crossline.lol>";

/** `cancelled`: a CANCEL went; the entry stays (until it is past) so a block that comes back is re-sent with a higher SEQUENCE than it. */
type SentEntry = { sequence: number; hash: string; start: string; end: string; title: string; until?: string; cancelled?: boolean };
export type InviteMail = { to: string; subject: string; text: string; method: "REQUEST" | "CANCEL"; ics: string };
export type InviteSender = (mail: InviteMail) => Promise<void>;

const readSent = (workspaceId: string): Record<string, SentEntry> => { try { return JSON.parse(getStore().getSetting(workspaceId, CALENDAR_IMIP_SENT_SETTING) ?? "{}") as Record<string, SentEntry>; } catch { return {}; } };
export const imipFrom = () => process.env.CROSSLINE_CALENDAR_FROM?.trim() || IMIP_FROM_DEFAULT;
const emailOf = (from: string) => /<([^>]+)>/.exec(from)?.[1] ?? from;

/**
 * Mails what changed since the last pass, one message per event (RFC 6047 allows one UID per object): a new or changed event as
 * `METHOD:REQUEST` with its SEQUENCE one higher than last time, an event gone from the set as `METHOD:CANCEL` — but only while it is
 * still to come (deletes only in the future). Nothing is mailed twice for the same content. A failure stops the pass and keeps what went.
 */
export async function imipPass(ctx: AccessContext, items: CalendarItem[], send: InviteSender, now = new Date()): Promise<{ sent: number; cancelled: number; left: number }> {
  const store = getStore();
  const to = store.getSetting(ctx.workspaceId, CALENDAR_IMIP_RECIPIENT_SETTING)?.trim();
  if (!to) throw Object.assign(new Error("CALENDAR_IMIP_NO_RECIPIENT"), { code: "CALENDAR_IMIP_NO_RECIPIENT" });
  const t = tOf(ctx);
  const horizon = now.getTime() + IMIP_WORK_DAYS * 86_400_000;
  const sent = readSent(ctx.workspaceId);
  // One already mailed keeps being updated wherever it moves (a re-plan past the horizon is an update, not a removal).
  const wanted = items.filter((item) => item.series || (Date.parse(item.end) > now.getTime()
    && (item.id.startsWith("fixed:") || Date.parse(item.start) < horizon || (sent[item.uid] && !sent[item.uid]!.cancelled))));
  const organizer = { email: emailOf(imipFrom()), name: "Crossline" };
  // A series is the same series whatever its next occurrence is (its first day moves forward every week): only its rule counts.
  const hashOf = (item: CalendarItem) => createHash("sha256").update(JSON.stringify(item.series
    ? [item.title, item.series.weekdays, item.series.until, item.series.localStart, item.series.localEnd, item.series.timeZone, item.series.exceptions]
    : [item.title, item.start, item.end])).digest("hex").slice(0, 24);
  type Job = { uid: string; method: "REQUEST" | "CANCEL"; item?: CalendarItem; entry?: SentEntry };
  const jobs: Job[] = [];
  for (const item of wanted) if (sent[item.uid]?.cancelled || sent[item.uid]?.hash !== hashOf(item)) jobs.push({ uid: item.uid, method: "REQUEST", item });
  // Removal is decided against the whole plan, not the mailed window: a block still on it is never cancelled.
  const present = new Set(items.map((item) => item.uid));
  for (const [uid, entry] of Object.entries(sent)) {
    if (present.has(uid)) continue;
    if (entry.cancelled) { if (Date.parse(entry.end) <= now.getTime() && !(entry.until && entry.until >= now.toISOString().slice(0, 10))) delete sent[uid]; continue; }
    // A series is still to come while its last day is; a one-off while its start is.
    if (Date.parse(entry.start) > now.getTime() || (entry.until && entry.until >= now.toISOString().slice(0, 10))) jobs.push({ uid, method: "CANCEL", entry });
    else delete sent[uid];
  }
  let done = 0, cancelled = 0;
  try {
    for (const job of jobs.slice(0, IMIP_PER_PASS)) {
      const previous = sent[job.uid];
      const sequence = previous ? previous.sequence + 1 : 0;
      if (job.method === "REQUEST" && job.item) {
        const item = job.item;
        await send({ to, method: "REQUEST", subject: item.title, text: t("Crossline 日历：{{title}}。在邮件应用里接受后出现在日历上；以后有变化会再发更新。", { title: item.title }),
          ics: buildIcs({ method: "REQUEST", now, events: [icsEvent(item, { sequence, organizer, attendees: [to] })] }) });
        sent[job.uid] = { sequence, hash: hashOf(item), start: item.start, end: item.end, title: item.title, ...(item.series ? { until: item.series.until } : {}) };
        done += 1;
      } else if (job.entry) {
        const entry = job.entry;
        await send({ to, method: "CANCEL", subject: t("已取消：{{title}}", { title: entry.title }), text: t("Crossline 日历：「{{title}}」已从计划中移除。", { title: entry.title }),
          ics: buildIcs({ method: "CANCEL", now, events: [{ uid: job.uid, summary: entry.title, start: entry.start, end: entry.end, sequence, organizer, attendees: [to] }] }) });
        sent[job.uid] = { ...entry, sequence, cancelled: true };
        cancelled += 1;
      }
    }
  } finally {
    store.setSetting(ctx.workspaceId, CALENDAR_IMIP_SENT_SETTING, JSON.stringify(sent));
  }
  store.setSetting(ctx.workspaceId, CALENDAR_IMIP_LAST_SETTING, JSON.stringify({ at: now.toISOString(), sent: done, cancelled }));
  return { sent: done, cancelled, left: Math.max(0, jobs.length - IMIP_PER_PASS) };
}

// ---------------------------------------------------------------------------------------------------------------- status

export function recordPathFailure(workspaceId: string, path: CalendarWritePath, failure: { code: string; message: string } | undefined, now = new Date()): void {
  try { getStore().setSetting(workspaceId, calendarFailureKey(path), failure ? JSON.stringify({ ...failure, at: now.toISOString() }) : ""); }
  catch { /* the write's own result is what matters */ }
}

export type PathStatus = { path: CalendarWritePath; on: boolean; last?: { at: string; text: string }; failure?: { at: string; code: string; message: string } };

/** Per path: on or off, the last good write in words, and the last failure (`calendar.publish.failure[.<path>]`) if it is newer. */
export function writePathStatuses(ctx: AccessContext): PathStatus[] {
  const store = getStore();
  const t = tOf(ctx);
  const paths = writePaths(ctx.workspaceId);
  const json = <T,>(key: string): T | undefined => { try { return JSON.parse(store.getSetting(ctx.workspaceId, key) || "null") ?? undefined; } catch { return undefined; } };
  const lastOf = (path: CalendarWritePath): PathStatus["last"] => {
    if (path === "ics") { const seen = json<{ at: string; events: number }>(CALENDAR_FEED_SEEN_SETTING); return seen ? { at: seen.at, text: t("日历应用最近一次读取，{{count}} 项", { count: seen.events }) } : undefined; }
    if (path === "imip") { const last = json<{ at: string; sent: number; cancelled: number }>(CALENDAR_IMIP_LAST_SETTING); return last ? { at: last.at, text: t("发出 {{sent}} 封邀请、{{cancelled}} 封取消", last) } : undefined; }
    if (path === "google") { const last = json<{ at: string; created: number; updated: number; deleted: number; calendar: string }>(CALENDAR_GOOGLE_LAST_SETTING);
      return last ? { at: last.at, text: t("新增 {{created}}、调整 {{updated}}、移除 {{deleted}}", last) } : undefined; }
    const event = store.listEvents(ctx.workspaceId, { type: "calendar.published" }).at(-1);
    const payload = event?.payload as { created?: number; updated?: number; deleted?: number } | undefined;
    return event ? { at: event.createdAt, text: t("新增 {{created}}、调整 {{updated}}、移除 {{deleted}}", { created: payload?.created ?? 0, updated: payload?.updated ?? 0, deleted: payload?.deleted ?? 0 }) } : undefined;
  };
  return CALENDAR_WRITE_PATHS.map((path) => {
    const last = lastOf(path);
    const failure = json<{ at: string; code: string; message: string }>(calendarFailureKey(path));
    const current = failure?.code && failure.at && (!last || failure.at > last.at) ? failure : undefined;
    return { path, on: paths[path], ...(last ? { last } : {}), ...(current ? { failure: current } : {}) };
  });
}
