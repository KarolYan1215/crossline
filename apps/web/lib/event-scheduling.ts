import "server-only";
import { randomUUID } from "node:crypto";
import { availableSlots, matchesItem, occurrences, type AccessContext, type FixedEvent, type TimedItem } from "@crossline/core";
import { keepBlocks, loadCurrentPlan, planToday, readAvailability, type PersistedScheduleBlock } from "./crossline";
import { addInputEvent, publishFixedEvents } from "./fixed-events";
import { tOf } from "./locale";
import { daysFrom, fixedTimedItems, MERGE_LOOKAHEAD_DAYS } from "./event-merges";

export type EventRequest = { title: string; lineId: string; date: string; weekdays: number[]; startTime: string; endTime: string; until: string; minutes: number; location?: string };
/**
 * `merged`: what was already there and taken as the same thing (2026-11-03); `created: false` when nothing new was made because the
 * person's calendar, a file's dates or an event they added already holds every occurrence.
 */
export type EventOutcome = { ok: true; event: FixedEvent; moved: number; placedBySystem: boolean; created: boolean; merged: TimedItem[] } | { ok: false; code: string; message: string };

const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const toMinutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) => a.start < b.end && b.start < a.end;
const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

/**
 * Puts an event the person asked for on the plan (and on the Crossline calendar), then re-plans **locally** (decided 2026-10-08): every
 * work block of the coming week that the event does not touch is kept where it was, and only the blocks it lands on are placed again.
 * With no time given, the system picks one: the first free stretch of the person's hours on that day (or in the coming week) long enough,
 * preferring time no work is planned in, and only then time work would have to move out of.
 *
 * A time the person named that is already there — on their calendar, in a file's dates, or an event they added before — is merged into
 * instead of made twice (2026-11-03, `alreadyThere`); a weekly event keeps only the weekdays nothing already holds.
 */
export async function scheduleEvent(ctx: AccessContext, request: EventRequest, now = new Date()): Promise<EventOutcome> {
  const today = planToday(ctx, now);
  const t = tOf(ctx);
  const before = await loadCurrentPlan(ctx);
  const week = Array.from({ length: 7 }, (_, index) => addDays(today, index));
  const recurring = request.weekdays.length > 0;
  let start = request.startTime, end = request.endTime;
  let date = request.date || (recurring ? today : "");
  let placedBySystem = false;
  if (!start || !end) {
    if (recurring) return { ok: false, code: "EVENT_TIME_REQUIRED", message: t("周期性日程需要写明时间（例如「每周二 10:00–11:00」）。") };
    const days = date ? [date] : week;
    const fixed = before.blocks.filter((block) => block.day && !block.id.startsWith("scheduled:") && !block.id.startsWith("optional:") && !block.id.startsWith("proposed:"))
      .map((block) => ({ day: block.day!, start: block.start, end: block.end }));
    const work = before.blocks.filter((block) => block.day && block.id.startsWith("scheduled:")).map((block) => ({ day: block.day!, start: block.start, end: block.end }));
    const fits = (busy: Array<{ day: string; start: string; end: string }>) => availableSlots(readAvailability(ctx), days, busy)
      .find((slot) => toMinutes(slot.end) - toMinutes(slot.start) >= request.minutes && (slot.day > today || toMinutes(slot.end) - request.minutes >= now.getHours() * 60));
    const slot = fits([...fixed, ...work]) ?? fits(fixed);
    if (!slot) return { ok: false, code: "EVENT_NO_ROOM", message: date ? t("{{day}}的可用时段里没有 {{minutes}} 分钟的空档；写明时间即可直接放入。", { day: date, minutes: request.minutes })
      : t("未来一周的可用时段里没有 {{minutes}} 分钟的空档；写明时间即可直接放入。", { minutes: request.minutes }) };
    date = slot.day; start = slot.start; end = clock(toMinutes(slot.start) + request.minutes); placedBySystem = true;
  }
  let event: FixedEvent = { id: `ev-${randomUUID()}`, title: request.title, lineId: request.lineId, location: request.location ?? "", source: "input",
    repeat: recurring ? { weekdays: request.weekdays, from: date || today, until: request.until, exceptions: [] } : null,
    date: date || today, start, end };
  let merged: TimedItem[] = [];
  if (!placedBySystem) {
    const found = alreadyThere(ctx, event, now);
    merged = found.merged;
    if (found.covered.length && (!event.repeat || found.covered.length === event.repeat.weekdays.length))
      return { ok: true, event, moved: 0, placedBySystem, created: false, merged };
    if (event.repeat && found.covered.length) event = { ...event, repeat: { ...event.repeat, weekdays: event.repeat.weekdays.filter((day) => !found.covered.includes(day)) } };
  }
  // The work the event does not touch stays put; what it lands on is placed again by the scheduler.
  const hit = (block: { day?: string | undefined; start: string; end: string }) => Boolean(block.day) && occurrences(event, [block.day!]).length > 0 && overlaps(block, event);
  const scheduled = before.blocks.filter((block: PersistedScheduleBlock) => block.id.startsWith("scheduled:") && block.day && block.day >= today);
  const added = addInputEvent(ctx, event);
  if (!added.ok) return { ok: false, code: added.code, message: t("日程信息不完整，未加入。") };
  keepBlocks(ctx, scheduled.filter((block) => !hit(block)).map((block) => ({ blockId: block.id, day: block.day!, start: block.start, end: block.end })), now);
  void publishFixedEvents(ctx, now).catch(() => undefined);
  return { ok: true, event, moved: scheduled.filter(hit).length, placedBySystem, created: true, merged };
}

/**
 * Which of the event's weekdays (a one-off: its own weekday) something already there holds, and those items. A weekday is held when every
 * occurrence matches an item (`matchesItem`: same day, starts within 15 minutes, titles alike) — counting, for a weekly event, only days
 * the plan has calendar or file data for: a calendar read one week ahead says nothing about the week after.
 */
export function alreadyThere(ctx: AccessContext, event: FixedEvent, now = new Date()): { covered: number[]; merged: TimedItem[] } {
  const today = planToday(ctx, now);
  const days = event.repeat ? daysFrom(event.repeat.from > today ? event.repeat.from : today, MERGE_LOOKAHEAD_DAYS) : [event.date];
  const items = fixedTimedItems(ctx, now, days);
  const known = items.filter((item) => item.kind !== "event").map((item) => item.day).sort().at(-1) ?? "";
  const covered: number[] = [];
  const merged = new Map<string, TimedItem>();
  for (const weekday of event.repeat ? event.repeat.weekdays : [weekdayOf(event.date)]) {
    const found = occurrences(event, days).filter((day) => weekdayOf(day) === weekday)
      .map((day) => ({ day, hit: items.find((item) => matchesItem({ title: event.title, day, start: event.start }, item)) }))
      .filter(({ day, hit }) => hit || !event.repeat || day <= known);
    const hits = found.map(({ hit }) => hit);
    if (!found.length || hits.some((hit) => !hit)) continue;
    covered.push(weekday);
    for (const hit of hits) if (hit && !merged.has(`${hit.kind}|${hit.title}`)) merged.set(`${hit.kind}|${hit.title}`, hit);
  }
  return { covered, merged: [...merged.values()] };
}
