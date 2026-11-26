import "server-only";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { AccessContext } from "@crossline/core";
import { readSchedulePreferences } from "./schedule-settings";

/**
 * The local day the plan is centred on. One definition, so B, A and the sync cannot disagree.
 *
 * `ctx` is optional: this stays callable from places that only need a plausible "today" and have no
 * request context to hand (a pure date-format test, a default parameter). With `ctx`, "today" follows
 * the caller's own workspace time zone preference; without it, only the process-wide env var default.
 */
export function planToday(ctx?: AccessContext,
  now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()): string {
  return dayFormatter((ctx && readSchedulePreferences(ctx)?.timeZone) ?? process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago").format(now);
}

/**
 * Formatters are kept per zone (2026-10-26): building an `Intl.DateTimeFormat` costs far more than using one, and one page asked for
 * today's day several hundred times. A zone the runtime does not know throws on first use, as before, and is not kept.
 */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-CA", { timeZone }); dayFormatters.set(timeZone, formatter); }
  return formatter;
}

/** Days the plan covers: today plus the sync window, so the A lens and the scheduler agree. */
export function planDays(today: string, days = Number(process.env.CROSSLINE_PLAN_WINDOW_DAYS ?? 7)): string[] {
  return Array.from({ length: days }, (_, offset) => {
    const date = new Date(`${today}T00:00:00`);
    date.setDate(date.getDate() + offset);
    return new Intl.DateTimeFormat("en-CA").format(date);
  });
}

/**
 * The same local time in the same zone always gives the same instant (or the same refusal), and building a schedule asks for the same
 * few hundred again and again: kept, bounded (2026-10-26).
 */
const zonedInstants = new Map<string, string | Error>();
export function toZonedInstant(day: string, time: string, zone: string): string {
  const key = `${day} ${time} ${zone}`;
  let kept = zonedInstants.get(key);
  if (kept === undefined) {
    try { kept = computeZonedInstant(day, time, zone); } catch (error) { kept = error instanceof Error ? error : new Error(String(error)); }
    if (zonedInstants.size >= 20_000) zonedInstants.clear();
    zonedInstants.set(key, kept);
  }
  if (kept instanceof Error) throw kept;
  return kept;
}

function computeZonedInstant(day: string, time: string, zone: string): string {
  const instant = fromZonedTime(`${day}T${time}:00`, zone);
  const local = `${day} ${time}`;
  if (!Number.isFinite(instant.getTime()) || formatInTimeZone(instant, zone, "yyyy-MM-dd HH:mm") !== local) {
    throw new Error("AVAILABILITY_LOCAL_TIME_INVALID");
  }
  if ([30, 60, 90, 120].some((minutes) => [-1, 1].some((direction) =>
    formatInTimeZone(new Date(instant.getTime() + direction * minutes * 60_000), zone,
      "yyyy-MM-dd HH:mm") === local))) throw new Error("AVAILABILITY_LOCAL_TIME_AMBIGUOUS");
  return instant.toISOString();
}
/** The app's notion of now: `CROSSLINE_FIXED_NOW` when pinned (tests, e2e), else the clock. */
export const appNow = () => process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const dayOf = (iso: string) => iso.slice(0, 10);
