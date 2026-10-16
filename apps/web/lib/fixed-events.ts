import "server-only";
import { createHash } from "node:crypto";
import {
  EVENT_DECISIONS, FIXED_EVENTS, fixedEventBlocks, graphWeekdays, importedTitle, inCalendar, itemProjectResolver, occurrences, validFixedEvent,
  type AccessContext, type FixedEvent
} from "@crossline/core";
import { effectiveSchedulePreferences, getStore, planToday, toZonedInstant, type PersistedScheduleBlock } from "./crossline";
import { requestCodexSupervisor } from "./codex-runtime";
import { interviewStatus } from "./interview-status";
import { localeFor } from "./locale";

type Decision = "create" | "exists" | "skip";
const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const span = (from: string, count: number) => Array.from({ length: count }, (_, index) => addDays(from, index));
const json = <T,>(ctx: AccessContext, key: string, fallback: T): T => { try { return JSON.parse(getStore().getSetting(ctx.workspaceId, key) ?? "null") ?? fallback; } catch { return fallback; } };

/** Events the person asked for through the input box (or anywhere else that adds one), kept in the ledger. */
export const inputEvents = (ctx: AccessContext): FixedEvent[] => json<FixedEvent[]>(ctx, FIXED_EVENTS, []).filter(validFixedEvent);
export const eventDecisions = (ctx: AccessContext): Record<string, Decision> => json<Record<string, Decision>>(ctx, EVENT_DECISIONS, {});

/**
 * The timed fixed arrangements the person confirmed from files or said in the interview (a confirmed batch of dates): weekly meetings as
 * recurring events, timed dated items as one-offs, each named with its course (`importedTitle`).
 */
export function confirmedEvents(ctx: AccessContext): FixedEvent[] {
  const store = getStore();
  const projects = store.listProjects(ctx.workspaceId).map((project) => ({ id: project.id, name: project.name, identityId: project.identityId }));
  const projectOf = itemProjectResolver(projects, store.listSourceDocuments(ctx.workspaceId));
  const lineOf = (project: string | undefined) => projects.find((item) => item.name === project || item.id === project)?.identityId ?? "";
  const decided = new Map(store.listEvents(ctx.workspaceId, { type: "dates.decided" }).map((event) => [event.entityId, event.payload as { superseded?: boolean; included?: string[] }]));
  type Row = { id: string; title: string; project?: string; sourceRef?: string; location?: string; startTime?: string; endTime?: string;
    date?: string; weekdays?: number[]; from?: string; to?: string; exceptions?: string[] };
  const out: FixedEvent[] = [];
  for (const event of store.listEvents(ctx.workspaceId, { type: "dates.extracted" })) {
    const decision = decided.get(event.entityId);
    if (!decision || decision.superseded) continue;
    const included = new Set(decision.included ?? []);
    const payload = event.payload as { dates?: Row[]; recurring?: Row[] };
    const base = (row: Row) => {
      const project = projectOf(row) ?? row.project;
      return { id: `batch:${event.entityId}:${row.id}`, lineId: lineOf(project), location: row.location ?? "",
        source: (row.sourceRef ?? "").startsWith("reply-") ? "interview" as const : "file" as const,
        title: importedTitle(`import:${event.entityId}:${row.id}`, row.title, new Map(project ? [[`${event.entityId}:${row.id}`, project]] : [])) };
    };
    for (const row of (payload.recurring ?? []).filter((item) => included.has(item.id))) {
      out.push({ ...base(row), repeat: { weekdays: row.weekdays ?? [], from: row.from ?? "", until: row.to ?? "", exceptions: row.exceptions ?? [] },
        date: row.from ?? "", start: row.startTime ?? "", end: row.endTime ?? "" });
    }
    for (const row of (payload.dates ?? []).filter((item) => included.has(item.id) && item.startTime)) {
      out.push({ ...base(row), repeat: null, date: row.date ?? "", start: row.startTime ?? "", end: row.endTime || row.startTime || "" });
    }
  }
  return out.filter(validFixedEvent);
}

/** The person's synced calendars as they stand on the plan: what a proposal is checked against before it is made. */
function calendarBlocks(ctx: AccessContext): Array<{ title: string; day: string; start: string; end: string }> {
  const plan = getStore().listPlanVersions(ctx.workspaceId)[0];
  return (((plan?.payload as { blocks?: PersistedScheduleBlock[] } | undefined)?.blocks) ?? [])
    .filter((block) => block.id.startsWith("graph_calendar:") && block.day).map((block) => ({ title: block.title, day: block.day!, start: block.start, end: block.end }));
}

/**
 * Fixed arrangements to offer for the calendar (decided 2026-10-08): once the interview is done or its portrait report exists, every
 * confirmed one that still happens, that the person has not answered about, and that their own calendar does not already hold.
 */
export function eventProposals(ctx: AccessContext): FixedEvent[] {
  const store = getStore();
  if (!store.getSetting(ctx.workspaceId, "portrait.report") && !interviewStatus(ctx).complete) return [];
  const today = planToday(ctx);
  const ahead = span(today, 60), check = span(today, 28);
  const decided = eventDecisions(ctx);
  const calendar = calendarBlocks(ctx);
  return confirmedEvents(ctx).filter((event) => !decided[event.id] && occurrences(event, ahead).length > 0 && !inCalendar(event, calendar, check));
}

export function decideEvent(ctx: AccessContext, id: string, decision: Decision): { ok: true } {
  getStore().setSetting(ctx.workspaceId, EVENT_DECISIONS, JSON.stringify({ ...eventDecisions(ctx), [id]: decision }));
  return { ok: true };
}

/** Adds an event the person asked for; a recurring one is one series. */
export function addInputEvent(ctx: AccessContext, event: FixedEvent): { ok: true; id: string } | { ok: false; code: string } {
  if (!validFixedEvent(event)) return { ok: false, code: "EVENT_INVALID" };
  getStore().setSetting(ctx.workspaceId, FIXED_EVENTS, JSON.stringify([...inputEvents(ctx).filter((item) => item.id !== event.id), event]));
  return { ok: true, id: event.id };
}

/** The input-box events on these days, as plan blocks: busy time the scheduler places work around. File events are already on the plan. */
export const eventBlocks = (ctx: AccessContext, days: string[]): PersistedScheduleBlock[] => fixedEventBlocks(inputEvents(ctx), days, localeFor(ctx));

/**
 * What goes to the Crossline calendar as the person's fixed events: input-box events, and confirmed arrangements the person chose to
 * create. A recurring one is a weekly series starting at its next occurrence; a one-off is one event.
 */
export function fixedEventsToPublish(ctx: AccessContext, now = new Date()): Array<{ id: string; title: string; start: string; end: string; reminderMinutes: number;
  recurrence?: { daysOfWeek: string[]; startDate: string; endDate: string; localStart: string; localEnd: string; timeZone: string } }> {
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const today = planToday(ctx, now);
  const decided = eventDecisions(ctx);
  const chosen = [...inputEvents(ctx), ...confirmedEvents(ctx).filter((event) => decided[event.id] === "create")];
  return chosen.flatMap((event) => {
    try {
      if (!event.repeat) {
        const start = toZonedInstant(event.date, event.start, zone), end = toZonedInstant(event.date, event.end, zone);
        return Date.parse(end) > now.getTime() ? [{ id: `fixed:${event.id}`, title: event.title, start, end, reminderMinutes: 10 }] : [];
      }
      const first = occurrences(event, span(today, 400)).find((day) => day >= today);
      if (!first) return [];
      return [{ id: `fixed:${event.id}`, title: event.title, start: toZonedInstant(first, event.start, zone), end: toZonedInstant(first, event.end, zone), reminderMinutes: 10,
        recurrence: { daysOfWeek: graphWeekdays(event.repeat.weekdays), startDate: first, endDate: event.repeat.until, localStart: event.start, localEnd: event.end, timeZone: zone } }];
    } catch { return []; }
  });
}

const FIXED_HASH = "calendar.fixed.hash";
/** Writes the fixed events to the Crossline calendar when they changed — apart from the plan's work blocks, and without waiting for a plan approval. */
export async function publishFixedEvents(ctx: AccessContext, now = new Date()): Promise<{ state: string }> {
  const store = getStore();
  if (!store.getSetting(ctx.workspaceId, "calendar.write.account")) return { state: "not_connected" };
  const blocks = fixedEventsToPublish(ctx, now);
  const hash = createHash("sha256").update(JSON.stringify(blocks)).digest("hex").slice(0, 32);
  if (store.getSetting(ctx.workspaceId, FIXED_HASH) === hash) return { state: "unchanged" };
  const result = await requestCodexSupervisor<{ state?: string }>(ctx, "/v1/calendar/publish", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks, scope: "fixed" }), signal: AbortSignal.timeout(120_000) });
  if (result.state === "published") store.setSetting(ctx.workspaceId, FIXED_HASH, hash);
  return { state: result.state ?? "unknown" };
}
