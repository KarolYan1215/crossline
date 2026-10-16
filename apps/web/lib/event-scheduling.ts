import "server-only";
import { randomUUID } from "node:crypto";
import { availableSlots, occurrences, type AccessContext, type FixedEvent } from "@crossline/core";
import { keepBlocks, loadCurrentPlan, planToday, readAvailability } from "./crossline";
import { addInputEvent, publishFixedEvents } from "./fixed-events";
import { tOf } from "./locale";

export type EventRequest = { title: string; lineId: string; date: string; weekdays: number[]; startTime: string; endTime: string; until: string; minutes: number; location?: string };
export type EventOutcome = { ok: true; event: FixedEvent; moved: number; placedBySystem: boolean } | { ok: false; code: string; message: string };

const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const toMinutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) => a.start < b.end && b.start < a.end;

/**
 * Puts an event the person asked for on the plan (and on the Crossline calendar), then re-plans **locally** (decided 2026-10-08): every
 * work block of the coming week that the event does not touch is kept where it was, and only the blocks it lands on are placed again.
 * With no time given, the system picks one: the first free stretch of the person's hours on that day (or in the coming week) long enough,
 * preferring time no work is planned in, and only then time work would have to move out of.
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
  const event: FixedEvent = { id: `ev-${randomUUID()}`, title: request.title, lineId: request.lineId, location: request.location ?? "", source: "input",
    repeat: recurring ? { weekdays: request.weekdays, from: date || today, until: request.until, exceptions: [] } : null,
    date: date || today, start, end };
  // The work the event does not touch stays put; what it lands on is placed again by the scheduler.
  const hit = (block: { day?: string | undefined; start: string; end: string }) => Boolean(block.day) && occurrences(event, [block.day!]).length > 0 && overlaps(block, event);
  const scheduled = before.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day && block.day >= today);
  const added = addInputEvent(ctx, event);
  if (!added.ok) return { ok: false, code: added.code, message: t("日程信息不完整，未加入。") };
  keepBlocks(ctx, scheduled.filter((block) => !hit(block)).map((block) => ({ blockId: block.id, day: block.day!, start: block.start, end: block.end })), now);
  void publishFixedEvents(ctx, now).catch(() => undefined);
  return { ok: true, event, moved: scheduled.filter(hit).length, placedBySystem };
}
