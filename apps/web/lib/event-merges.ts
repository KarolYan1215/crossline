import "server-only";
import {
  EVENT_MERGES, FIXED_EVENTS, fixedEventBlocks, isCancelledEvent, mergeCandidates, mergeDecision, readMergeBook,
  type AccessContext, type FixedEvent, type MergeBook, type MergeCandidate, type MergeDecision, type MergeHow, type TimedItem
} from "@crossline/core";
import { getStore, planToday, plannerIdOfBlock, type PersistedScheduleBlock } from "./crossline";

/**
 * Overlapping items that are the same thing (`packages/core/src/event-merge.ts`): the person's answers, the `event_merge` ask's pairs, and
 * the plan blocks as `TimedItem`s. The answers live in `schedule.merges`, which undo and backups carry.
 */
export const readMerges = (ctx: AccessContext): MergeBook => readMergeBook(getStore().getSetting(ctx.workspaceId, EVENT_MERGES));

export function recordMerge(ctx: AccessContext, key: string, decision: MergeDecision): void {
  getStore().setSetting(ctx.workspaceId, EVENT_MERGES, JSON.stringify({ ...readMerges(ctx), [key]: decision }));
}

/** Records a pair's answer, by series: a weekly class merged once stays merged. */
export function decidePair(ctx: AccessContext, a: TimedItem, b: TimedItem, how: MergeHow, by: "person" | "system" = "person"): void {
  const { key, decision } = mergeDecision(a, b, how, by, new Date().toISOString());
  recordMerge(ctx, key, decision);
}

type BlockLike = Pick<PersistedScheduleBlock, "id" | "title" | "start" | "end"> & { day?: string | undefined; sourceKey?: string | undefined };

/** A plan block as a timed item, or nothing when it is not one the merge rules look at (activity, proposals, pencilled-in work). */
export function timedItemOf(block: BlockLike, sourceKey?: string): TimedItem | undefined {
  if (!block.day) return undefined;
  const base = { id: block.id, title: block.title, day: block.day, start: block.start, end: block.end };
  const source = sourceKey ?? block.sourceKey;
  if (block.id.startsWith("graph_calendar:")) return { ...base, kind: "calendar", ...(source ? { source } : {}) };
  if (block.id.startsWith("import:")) return { ...base, kind: "file" };
  if (block.id.startsWith("event:")) return { ...base, kind: "event" };
  if (block.id.startsWith("scheduled:")) return { ...base, kind: "work", orderId: plannerIdOfBlock(block.id).split("#")[0]! };
  return undefined;
}

const DAY_MS = 86_400_000;
/** How far ahead overlaps are looked for: a weekly pair shows within two weeks. */
export const MERGE_LOOKAHEAD_DAYS = 14;

/** The days from `from`, `count` of them. */
export const daysFrom = (from: string, count: number) => Array.from({ length: count }, (_, index) => new Date(Date.parse(`${from}T12:00:00Z`) + index * DAY_MS).toISOString().slice(0, 10));

/**
 * The person's fixed arrangements on the stored plan (synced calendars, file dates) plus the events they added, on `days` (by default
 * the next `MERGE_LOOKAHEAD_DAYS` from today).
 */
export function fixedTimedItems(ctx: AccessContext, now = new Date(), days = daysFrom(planToday(ctx, now), MERGE_LOOKAHEAD_DAYS)): TimedItem[] {
  const store = getStore();
  const wanted = new Set(days);
  const stored = ((store.listPlanVersions(ctx.workspaceId)[0]?.payload as { blocks?: BlockLike[] } | undefined)?.blocks ?? [])
    .filter((block) => block.day && wanted.has(block.day) && !(block.id.startsWith("graph_calendar:") && isCancelledEvent(block.title)));
  let events: FixedEvent[] = [];
  try { events = JSON.parse(store.getSetting(ctx.workspaceId, FIXED_EVENTS) ?? "[]") as FixedEvent[]; } catch { /* none */ }
  return [...stored, ...fixedEventBlocks(events, days)].flatMap((block) => { const item = timedItemOf(block); return item && item.kind !== "work" ? [item] : []; });
}

/** Pairs that overlap and look alike, not yet answered: the `event_merge` asks. */
export const mergePairs = (ctx: AccessContext, now = new Date()): MergeCandidate[] => mergeCandidates(fixedTimedItems(ctx, now), readMerges(ctx));
