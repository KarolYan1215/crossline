import "server-only";
import type { AccessContext } from "@crossline/core";
import { getStore, loadCurrentPlan, planToday } from "./crossline";

/** The setting that remembers which work was given a time on a day: `schedule.day:<YYYY-MM-DD>` → `{ [orderId]: "HH:MM" }`. */
export const scheduledDayKey = (day: string) => `schedule.day:${day}`;
export type ScheduledDay = Record<string, string>;
/** Order ids with a scheduled block in the next seven days, rewritten on the web's timer. */
export const UPCOMING_SETTING = "schedule.upcoming";

export function readScheduledDay(ctx: AccessContext, day: string): ScheduledDay {
  try { return JSON.parse(getStore().getSetting(ctx.workspaceId, scheduledDayKey(day)) || "{}") as ScheduledDay; } catch { return {}; }
}

/**
 * Remembers which work the plan gave a time today. The schedule is derived on read and never stored (so it cannot drift from the
 * work orders), which also meant nothing could say tomorrow what had been meant to happen today — so nothing could ask about it.
 * Kept as a union over the day (work placed this morning and moved this afternoon still counts as placed today), earliest start kept.
 */
export async function recordScheduledToday(ctx: AccessContext, now = new Date()): Promise<ScheduledDay> {
  const today = planToday(ctx, now);
  const plan = await loadCurrentPlan(ctx);
  const seen = readScheduledDay(ctx, today);
  for (const block of plan.blocks) {
    if (!block.id.startsWith("scheduled:") || block.day !== today) continue;
    const orderId = block.id.split(":")[1]!;
    if (!seen[orderId] || block.start < seen[orderId]!) seen[orderId] = block.start;
  }
  getStore().setSetting(ctx.workspaceId, scheduledDayKey(today), JSON.stringify(seen));
  // The work with a time in the next seven days: the worker builds tutorials for these (it cannot derive the schedule itself).
  const weekEnd = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const upcoming = [...new Set(plan.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day && block.day >= today && block.day < weekEnd)
    .map((block) => block.id.split(":")[1]!))];
  getStore().setSetting(ctx.workspaceId, UPCOMING_SETTING, JSON.stringify(upcoming));
  return seen;
}
