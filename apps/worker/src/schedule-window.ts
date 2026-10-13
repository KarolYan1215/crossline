import type { CrosslineStore } from "@crossline/db";

/** Written by the web (`schedule-memory.ts`): each work order's earliest block start this week, as an instant. */
export const ORDER_STARTS_SETTING = "schedule.orderStarts";
/** Preparation is made just in time (docs/review-2026-10-13.md §6.1, the person's decision): for work starting within this many hours. */
export const PREPARE_WINDOW_HOURS = 48;

/**
 * The work orders whose next block starts within the window (or began in the last hour). The schedule is derived in the web process, so
 * the worker reads what the web last recorded; with nothing recorded, nothing is in the window — preparing for work nobody has a time
 * for is what spent half a week's tokens on manuals never opened.
 */
export function startingWithin(store: CrosslineStore, workspaceId: string, now: Date, hours = PREPARE_WINDOW_HOURS): Set<string> {
  let starts: Record<string, string> = {};
  try { starts = JSON.parse(store.getSetting(workspaceId, ORDER_STARTS_SETTING) ?? "{}") as Record<string, string>; } catch { return new Set(); }
  const from = now.getTime() - 3_600_000, to = now.getTime() + hours * 3_600_000;
  return new Set(Object.entries(starts).filter(([, at]) => { const time = Date.parse(at); return time >= from && time <= to; }).map(([orderId]) => orderId));
}
