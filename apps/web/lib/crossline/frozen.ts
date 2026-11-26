import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { taskTitleOf, type AccessContext, DELAY_SETTING, FROZEN_SETTING, SHIFT_MINUTES, parseFrozen, settleFrozen, shiftFrozen, withFrozen, withoutFrozen, type FrozenBlock } from "@crossline/core";
import { tOf } from "../locale";
import { getStore } from "./store";
import { effectiveSchedulePreferences } from "./schedule-settings";
import { appNow, toZonedInstant } from "./clock";
import { previewScope } from "./preview";
import { type PersistedScheduleBlock, committedBlocks } from "./schedule";

/**
 * Block ids: `scheduled:<task>` for a task placed whole, `scheduled:<task>:<step>` for one of its steps, each with `:<n>` for its n-th
 * block when a piece is split. Everything that only needs the task reads segment 1, so step blocks need no change there. Step ids are
 * `v<version>s<n>` (packages/db `saveStepPlan`), which is what tells a step segment from a block index.
 */
export const stepTaskId = (orderId: string, stepId: string) => `${orderId}#${stepId}`;
const STEP_ID = /^v\d+s\d+$/;
export function scheduledBlockId(plannerTaskId: string, index: number): string {
  const [orderId, stepId] = plannerTaskId.split("#");
  return `scheduled:${orderId}${stepId ? `:${stepId}` : ""}${index > 1 ? `:${index}` : ""}`;
}
/**
 * The schedule's frozen blocks (`schedule.frozen`, `packages/core/src/schedule-frozen.ts`): started, locked, kept by a local re-plan
 * or inside the commit window. The two settings it replaced (`schedule.pins` from starting a pencilled-in block, `schedule.keep` from
 * inserting an event) are taken over the first time they are seen and then deleted; their blocks had no segment number, so they
 * become segment 1 of their task or step, the only id that can be inferred.
 */
const LEGACY_PINS = "schedule.pins";
const LEGACY_KEEP = "schedule.keep";
type LegacyPin = { taskId: string; day: string; start: string; end: string };
export function readFrozen(ctx: AccessContext, now: Date): FrozenBlock[] {
  const store = getStore();
  const pinsRaw = store.getSetting(ctx.workspaceId, LEGACY_PINS);
  const keepRaw = store.getSetting(ctx.workspaceId, LEGACY_KEEP);
  if (pinsRaw || keepRaw) {
    const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
    const instant = (pin: LegacyPin) => { try { return { start: toZonedInstant(pin.day, pin.start, zone), end: toZonedInstant(pin.day, pin.end, zone) }; } catch { return undefined; } };
    let list = parseFrozen(store.getSetting(ctx.workspaceId, FROZEN_SETTING), now);
    try { for (const pin of JSON.parse(pinsRaw ?? "[]") as LegacyPin[]) { const at = instant(pin); if (at) list = withFrozen(list, { blockId: scheduledBlockId(pin.taskId, 1), ...at, reason: "pinned" }); } } catch { /* unreadable: dropped */ }
    try {
      const kept = JSON.parse(keepRaw ?? "null") as { until?: string; blocks?: LegacyPin[] } | null;
      for (const pin of kept?.blocks ?? []) { const at = instant(pin); if (at && kept?.until) list = withFrozen(list, { blockId: scheduledBlockId(pin.taskId, 1), ...at, reason: "keep", until: kept.until }); }
    } catch { /* unreadable: dropped */ }
    writeFrozen(ctx, parseFrozen(JSON.stringify(list), now));
    store.deleteSetting(ctx.workspaceId, LEGACY_PINS);
    store.deleteSetting(ctx.workspaceId, LEGACY_KEEP);
  }
  const list = parseFrozen(store.getSetting(ctx.workspaceId, FROZEN_SETTING), now);
  // Inside an impact preview of 「改时间」: the held block as if already locked at its new time.
  const lock = previewScope.getStore()?.lock;
  if (!lock) return list;
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  try {
    return withFrozen(list, { blockId: lock.blockId.replace(/^optional:/, "scheduled:"), start: toZonedInstant(lock.day, lock.start, zone),
      end: toZonedInstant(lock.day, lock.end, zone), reason: "locked" });
  } catch { return list; }
}
export function writeFrozen(ctx: AccessContext, list: FrozenBlock[]): void {
  getStore().setSetting(ctx.workspaceId, FROZEN_SETTING, JSON.stringify(list));
}
/**
 * Local re-planning (decided 2026-10-08): when an event is added, the work blocks it does not touch stay where they were for a week
 * and only the ones it lands on move. A change that should re-plan everything (availability, packing numbers, importance, shares)
 * clears the kept blocks, never what the person started or locked.
 */
export function keepBlocks(ctx: AccessContext, blocks: Array<{ blockId: string; day: string; start: string; end: string }>, now: Date): void {
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const until = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  let list = readFrozen(ctx, now).filter((item) => item.reason !== "keep");
  for (const block of blocks) {
    try { if (!list.some((item) => item.blockId === block.blockId))
      list = withFrozen(list, { blockId: block.blockId, start: toZonedInstant(block.day, block.start, zone), end: toZonedInstant(block.day, block.end, zone), reason: "keep", until }); }
    catch { /* a clock change: not kept */ }
  }
  writeFrozen(ctx, list);
}
/** How soon before its start a scheduled block stops moving (docs/loop-and-scout.md §2, the commit window). */
export const COMMIT_WINDOW_MINUTES = 15;
/**
 * How long a work block's time stays held after it ends (the owner, 2026-10-26: 「时间已过有可能是这项任务还在做，过 1h 重排」): until then
 * its work is not placed again; after it, the work is re-planned and the block stays on its day as 「未完成」 until 04:00 the next morning
 * (`missedItems` in `lib/timeline.ts`).
 */
export const COMMIT_GRACE_MINUTES = 60;
/**
 * The commit window: a work block under way or starting within fifteen minutes keeps its time until an hour after it ends, so the
 * background optimal plan landing a minute later never moves what the person is about to start, and work running over is not moved
 * away while it is being done. A block already started or locked keeps that reason. Writes only when something new enters the window.
 */
export function commitSoon(ctx: AccessContext, blocks: Array<{ id: string; day?: string; start: string; end: string }>, now: Date): number {
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  let list = readFrozen(ctx, now);
  let added = 0;
  for (const block of blocks) {
    if (!block.id.startsWith("scheduled:") || !block.day || list.some((item) => item.blockId === block.id)) continue;
    let start: string, end: string;
    try { start = toZonedInstant(block.day, block.start, zone); end = toZonedInstant(block.day, block.end, zone); } catch { continue; }
    if (Date.parse(start) - now.getTime() > COMMIT_WINDOW_MINUTES * 60_000 || Date.parse(end) <= now.getTime()) continue;
    list = withFrozen(list, { blockId: block.id, start, end, reason: "commit", until: new Date(Date.parse(end) + COMMIT_GRACE_MINUTES * 60_000).toISOString() });
    added += 1;
  }
  if (added) writeFrozen(ctx, list);
  return added;
}
/**
 * 「后面都推 10 分钟」 (`schedule.shift`, docs/energy-and-ecosystem.md §6): today's committed and kept blocks move later by `minutes`
 * (`shiftFrozen`; started and locked ones stay), and the time from now until `now + minutes` is busy (`schedule.delayUntil`, read by
 * `planningInputFor`), so the rest of the day is re-planned to start after it. Both are `schedule.` settings, so the input box's undo
 * restores them.
 */
export function shiftToday(ctx: AccessContext, minutes: number, now = appNow()): { ok: true; message: string } | { ok: false; code: string } {
  if (!Number.isInteger(minutes) || minutes < SHIFT_MINUTES.min || minutes > SHIFT_MINUTES.max) return { ok: false, code: "SHIFT_MINUTES_INVALID" };
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const today = formatInTimeZone(now, zone, "yyyy-MM-dd");
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const before = readFrozen(ctx, now);
  const after = shiftFrozen(before, minutes, now, new Date(toZonedInstant(tomorrow, "00:00", zone)));
  if (JSON.stringify(after) !== JSON.stringify(before)) writeFrozen(ctx, after);
  // Two shifts in a row add up: the second starts from the end of the first.
  const current = Date.parse(getStore().getSetting(ctx.workspaceId, DELAY_SETTING) ?? "") || 0;
  getStore().setSetting(ctx.workspaceId, DELAY_SETTING, new Date(Math.max(current, now.getTime()) + minutes * 60_000).toISOString());
  const held = after.filter((item) => (item.reason === "pinned" || item.reason === "locked") && Date.parse(item.end) > now.getTime()
    && formatInTimeZone(new Date(item.start), zone, "yyyy-MM-dd") === today).length;
  const t = tOf(ctx);
  return { ok: true, message: held ? t("今天之后的安排顺延 {{minutes}} 分钟，已锁定的 {{count}} 块不动", { minutes, count: held })
    : t("今天之后的安排顺延 {{minutes}} 分钟", { minutes }) };
}
/** The stretch `schedule.shift` holds from now on, as a busy block of today in the person's clock; undefined once it has passed. */
export function delayBlock(ctx: AccessContext, now: Date, zone: string): { day: string; start: string; end: string } | undefined {
  const until = Date.parse(getStore().getSetting(ctx.workspaceId, DELAY_SETTING) ?? "");
  if (!until || until <= now.getTime()) return undefined;
  const day = formatInTimeZone(now, zone, "yyyy-MM-dd");
  const end = formatInTimeZone(new Date(until), zone, "yyyy-MM-dd") === day ? formatInTimeZone(new Date(until), zone, "HH:mm") : "23:59";
  const start = formatInTimeZone(now, zone, "HH:mm");
  return end > start ? { day, start, end } : undefined;
}
export function clearKept(ctx: AccessContext, now = appNow()): void {
  writeFrozen(ctx, readFrozen(ctx, now).filter((item) => item.reason !== "keep"));
}

/**
 * Locks one block at a time (docs/loop-and-scout.md §1): started (`pinned`) or locked by the button (`locked`). A pencilled-in block
 * (`optional:`) becomes the same-numbered `scheduled:` block. The planner freezes that segment only; the task's others are still placed.
 */
export function lockBlock(ctx: AccessContext, blockId: string, at: { day: string; start: string; end: string },
  reason: "pinned" | "locked" = "pinned", options: { overlapOk?: boolean } = {}): { ok: true } | { ok: false; code: string } {
  if (!/^(scheduled|optional):/.test(blockId) || !/^\d{4}-\d{2}-\d{2}$/.test(at.day) || !/^\d{2}:\d{2}$/.test(at.start) || !/^\d{2}:\d{2}$/.test(at.end) || at.end <= at.start)
    return { ok: false, code: "PIN_INVALID" };
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  let start: string, end: string;
  try { start = toZonedInstant(at.day, at.start, zone); end = toZonedInstant(at.day, at.end, zone); } catch { return { ok: false, code: "PIN_INVALID" }; }
  const id = blockId.replace(/^optional:/, "scheduled:");
  writeFrozen(ctx, withFrozen(readFrozen(ctx, appNow()), { blockId: id, start, end, reason, ...(options.overlapOk ? { overlapOk: true } : {}) }));
  return { ok: true };
}
/**
 * Held blocks (started or locked) in the way of something without the person's acceptance (`settleFrozen`): a calendar event, a file's
 * class meeting, an event the person added, or another held block. One entry per held block, with what it overlaps, for the
 * `locked_conflict` ask.
 */
export function heldConflicts(ctx: AccessContext, now = appNow()): Array<{ entry: FrozenBlock; title: string; block?: PersistedScheduleBlock }> {
  const store = getStore();
  const stored = store.listPlanVersions(ctx.workspaceId)[0];
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const blocks = stored ? committedBlocks(ctx, stored.payload).filter((block) => block.day && !block.id.startsWith("scheduled:")) : [];
  const busy = blocks.flatMap((block) => { try {
    return [{ id: block.id, start: Date.parse(toZonedInstant(block.day!, block.start, zone)), end: Date.parse(toZonedInstant(block.day!, block.end === "24:00" ? "23:59" : block.end, zone)) }];
  } catch { return []; } });
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const frozen = readFrozen(ctx, now);
  const seen = new Set<string>();
  return settleFrozen(frozen, busy).conflicts.flatMap((conflict) => {
    const entry = frozen.find((item) => item.blockId === conflict.blockId);
    if (!entry || seen.has(conflict.blockId)) return [];
    seen.add(conflict.blockId);
    const other = conflict.kind === "frozen" ? orders.get(plannerIdOfBlock(conflict.with).split("#")[0]!) : undefined;
    const block = conflict.kind === "busy" ? byId.get(conflict.with) : undefined;
    return [{ entry, title: conflict.kind === "busy" ? block?.title ?? "" : other ? taskTitleOf(other) : "", ...(block ? { block } : {}) }];
  });
}
export function unlockBlock(ctx: AccessContext, blockId: string): { ok: true } {
  writeFrozen(ctx, withoutFrozen(readFrozen(ctx, appNow()), blockId.replace(/^optional:/, "scheduled:")));
  return { ok: true };
}

export function plannerIdOfBlock(blockId: string): string {
  const parts = blockId.split(":");
  return parts[2] && STEP_ID.test(parts[2]) ? stepTaskId(parts[1]!, parts[2]) : parts[1]!;
}
