import "server-only";
import { wrapTimeOf, type AccessContext, type NudgeEnding } from "@crossline/core";
import { formatInTimeZone } from "date-fns-tz";
import { appNow, effectiveSchedulePreferences, getStore, planToday, readAvailability, toZonedInstant } from "./crossline";
import { blockAnswer, confirmBlockAt, type ConfirmOutcome } from "./confirm";

/** The nudge pass's record of today's blocks (`seenBlocksKey` in `lib/nudges.ts`, which imports this file). */
const seenBlocksKey = (day: string) => `nudge.blocks:${day}`;

/**
 * The evening wrap-up (the owner's decision of 2026-10-28; docs/rituals.md): at the end of the person's last available hours, or when they
 * press 「收工」, today's blocks one tap each — 完成 / 部分 / 没做 — written as the completion check writes them (`block.confirmed`), what was
 * not done rolling forward as it already does, and the day's decisions with a safe default settled in the same place (`lib/answer-all.ts`).
 */
export const WRAP_DONE = (day: string) => `wrap.done:${day}`;
export type WrapOutcome = "done" | "partial" | "not_done";
export type WrapRow = { blockId: string; orderId: string; title: string; step: string; start: string; end: string; answered?: string;
  /** The task's line, for its tag. */
  line?: string;
  /** Minutes the timer ran for this task inside the block's own times (0: not timed). */
  timedMinutes: number };
export type WrapView = { day: string; at?: string; rows: WrapRow[]; open: number; done: boolean;
  /** Whether `day` is today: an earlier day (`/wrap?day=`) is caught up on, not wrapped up. */
  today: boolean;
  /** Minutes the timer ran that day, every task; blocks answered done. */
  timedMinutes: number; doneBlocks: number };

/** How far back `/wrap?day=` reaches: the last seven days (the nudge pass keeps a day's blocks for 28). */
export const WRAP_DAYS_BACK = 7;

/**
 * The day a wrap-up is for: today, or an earlier day the person asked for (`/wrap?day=YYYY-MM-DD`, Today's 「昨天没开始 → 逐个处理」)
 * when it lies within the last `WRAP_DAYS_BACK` days. Anything else (a future day, a bad date, too long ago) is today.
 */
export function wrapDayOf(ctx: AccessContext, requested: unknown, now = appNow()): string {
  const today = planToday(ctx, now);
  if (typeof requested !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(requested) || Number.isNaN(Date.parse(`${requested}T12:00:00Z`))) return today;
  const back = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${requested}T12:00:00Z`)) / 86_400_000);
  return back >= 0 && back <= WRAP_DAYS_BACK ? requested : today;
}

const keyOf = (day: string, blockId: string) => `wrap:${day}:${blockId}`;

type Seen = NudgeEnding & { began?: boolean };
function seenBlocks(ctx: AccessContext, day: string): Seen[] {
  try { return Object.values(JSON.parse(getStore().getSetting(ctx.workspaceId, seenBlocksKey(day)) ?? "{}") as Record<string, Seen>); } catch { return []; }
}

/**
 * A day's blocks that really happened (the nudge pass saw each under way, `nudge.blocks:<day>`), with any answer already given — through
 * the wrap-up or the block's own completion check, whose answer is keyed by its message. `day` defaults to today; `wrapDayOf` bounds it.
 */
export function loadWrap(ctx: AccessContext, now = appNow(), requestedDay?: string): WrapView {
  const store = getStore();
  const today = planToday(ctx, now);
  const day = requestedDay ? wrapDayOf(ctx, requestedDay, now) : today;
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const answered = new Map<string, string>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "block.confirmed" })) {
    const payload = event.payload as { blockId?: string; day?: string; outcome?: string };
    if (payload.day === day && payload.blockId) answered.set(payload.blockId, String(payload.outcome ?? ""));
  }
  const lineOf = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.identityId]));
  // Every timer of the day as an interval (one still running ends now), for the day's total and each block's share of it.
  const spans = store.listExecutions(ctx.workspaceId).map((execution) => ({ orderId: execution.workOrderId, from: Date.parse(execution.startedAt),
    to: Math.min(execution.endedAt ? Date.parse(execution.endedAt) : now.getTime(), now.getTime()), pause: execution.pauseMinutes }))
    .filter((span) => span.to > span.from);
  const dayFrom = Date.parse(toZonedInstant(day, "00:00", zone)), dayTo = dayFrom + 86_400_000;
  const overlap = (span: { from: number; to: number }, from: number, to: number) => Math.max(0, Math.min(span.to, to) - Math.max(span.from, from)) / 60_000;
  const timedMinutes = Math.round(spans.reduce((sum, span) => {
    const inDay = overlap(span, dayFrom, dayTo);
    const whole = (span.to - span.from) / 60_000;
    // Paused minutes are taken off in proportion to the part of the timer that fell on this day.
    return sum + Math.max(0, inDay - (whole ? span.pause * inDay / whole : 0));
  }, 0));
  const rows = seenBlocks(ctx, day).filter((block) => block.began && lineOf.has(block.orderId)).sort((a, b) => a.start.localeCompare(b.start))
    .map((block): WrapRow => {
      const from = Date.parse(toZonedInstant(day, block.start, zone)), to = Date.parse(toZonedInstant(day, block.end, zone));
      const timed = Math.round(spans.filter((span) => span.orderId === block.orderId).reduce((sum, span) => sum + overlap(span, from, to), 0));
      const line = lineOf.get(block.orderId);
      return { blockId: block.id, orderId: block.orderId, title: block.title, step: block.step, start: block.start, end: block.end, timedMinutes: timed,
        ...(line ? { line } : {}), ...(answered.has(block.id) ? { answered: answered.get(block.id)! } : {}) };
    });
  const weekday = Number(formatInTimeZone(now, zone, "i")) % 7;
  const at = day === today ? wrapTimeOf(readAvailability(ctx), weekday) : undefined;
  const open = rows.filter((row) => !row.answered).length;
  const doneBlocks = rows.filter((row) => row.answered && row.answered !== "not_done" && row.answered !== "partial").length;
  return { day, ...(at ? { at } : {}), rows, open, done: Boolean(store.getSetting(ctx.workspaceId, WRAP_DONE(day))), today: day === today, timedMinutes, doneBlocks };
}

/**
 * One block's answer from the wrap-up. 完成 is 「按预估完成」; 部分 keeps the step open with half of it done; 没做 rolls forward. `day`
 * is an earlier day within `WRAP_DAYS_BACK` (`/wrap?day=`), written the same way, keyed `wrap:<that day>:<block>`.
 */
export function answerWrapBlock(ctx: AccessContext, blockId: string, outcome: WrapOutcome, now = appNow(), requestedDay?: string): ConfirmOutcome {
  const day = requestedDay ? wrapDayOf(ctx, requestedDay, now) : planToday(ctx, now);
  const block = seenBlocks(ctx, day).find((item) => item.id === blockId && item.began);
  if (!block) return { ok: false, code: "CONFIRM_NOT_FOUND" };
  // Answered already, here or through the block's own completion check: not written twice.
  const already = blockAnswer(ctx, keyOf(day, blockId))?.outcome ?? loadWrap(ctx, now, day).rows.find((row) => row.blockId === blockId)?.answered;
  if (already) return { ok: true, done: already === "not_done" || already === "partial" ? already : "step", already: true };
  return confirmBlockAt(ctx, keyOf(day, blockId), { ...block, day: block.day || day },
    { kind: outcome === "done" ? "as_planned" : outcome }, now);
}

/** 「收工」: the day is wrapped up, so no wrap-up message comes tonight. */
export function finishWrap(ctx: AccessContext, now = appNow()): { ok: true } {
  getStore().setSetting(ctx.workspaceId, WRAP_DONE(planToday(ctx, now)), now.toISOString());
  return { ok: true };
}
