import "server-only";
import { wrapTimeOf, type AccessContext, type NudgeEnding } from "@crossline/core";
import { formatInTimeZone } from "date-fns-tz";
import { appNow, effectiveSchedulePreferences, getStore, planToday, readAvailability } from "./crossline";
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
export type WrapRow = { blockId: string; orderId: string; title: string; step: string; start: string; end: string; answered?: string };
export type WrapView = { day: string; at?: string; rows: WrapRow[]; open: number; done: boolean };

const keyOf = (day: string, blockId: string) => `wrap:${day}:${blockId}`;

type Seen = NudgeEnding & { began?: boolean };
function seenBlocks(ctx: AccessContext, day: string): Seen[] {
  try { return Object.values(JSON.parse(getStore().getSetting(ctx.workspaceId, seenBlocksKey(day)) ?? "{}") as Record<string, Seen>); } catch { return []; }
}

/**
 * Today's blocks that really happened (the nudge pass saw each under way, `nudge.blocks:<day>`), with any answer already given — through
 * the wrap-up or the block's own completion check, whose answer is keyed by its message.
 */
export function loadWrap(ctx: AccessContext, now = appNow()): WrapView {
  const store = getStore();
  const day = planToday(ctx, now);
  const answered = new Map<string, string>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "block.confirmed" })) {
    const payload = event.payload as { blockId?: string; day?: string; outcome?: string };
    if (payload.day === day && payload.blockId) answered.set(payload.blockId, String(payload.outcome ?? ""));
  }
  const orders = new Set(store.listWorkOrders(ctx.workspaceId).map((order) => order.id));
  const rows = seenBlocks(ctx, day).filter((block) => block.began && orders.has(block.orderId)).sort((a, b) => a.start.localeCompare(b.start))
    .map((block): WrapRow => ({ blockId: block.id, orderId: block.orderId, title: block.title, step: block.step, start: block.start, end: block.end,
      ...(answered.has(block.id) ? { answered: answered.get(block.id)! } : {}) }));
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const weekday = Number(formatInTimeZone(now, zone, "i")) % 7;
  const at = wrapTimeOf(readAvailability(ctx), weekday);
  const open = rows.filter((row) => !row.answered).length;
  return { day, ...(at ? { at } : {}), rows, open, done: Boolean(store.getSetting(ctx.workspaceId, WRAP_DONE(day))) };
}

/** One block's answer from the wrap-up. 完成 is 「按预估完成」; 部分 keeps the step open with half of it done; 没做 rolls forward. */
export function answerWrapBlock(ctx: AccessContext, blockId: string, outcome: WrapOutcome, now = appNow()): ConfirmOutcome {
  const day = planToday(ctx, now);
  const block = seenBlocks(ctx, day).find((item) => item.id === blockId && item.began);
  if (!block) return { ok: false, code: "CONFIRM_NOT_FOUND" };
  // Answered already, here or through the block's own completion check: not written twice.
  const already = blockAnswer(ctx, keyOf(day, blockId))?.outcome ?? loadWrap(ctx, now).rows.find((row) => row.blockId === blockId)?.answered;
  if (already) return { ok: true, done: already === "not_done" || already === "partial" ? already : "step", already: true };
  return confirmBlockAt(ctx, keyOf(day, blockId), { ...block, day: block.day || day },
    { kind: outcome === "done" ? "as_planned" : outcome }, now);
}

/** 「收工」: the day is wrapped up, so no wrap-up message comes tonight. */
export function finishWrap(ctx: AccessContext, now = appNow()): { ok: true } {
  getStore().setSetting(ctx.workspaceId, WRAP_DONE(planToday(ctx, now)), now.toISOString());
  return { ok: true };
}
