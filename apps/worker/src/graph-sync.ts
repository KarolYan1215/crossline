import { createHash, randomUUID } from "node:crypto";
import { realityChanges, syncWindowDays, toRealityBlock, type RealityBlock, type RealityChange } from "@crossline/core";
import { reconcileExternalItems, type ExternalItem, type GraphDeltaPage } from "@crossline/connectors";
import type { CrosslineStore } from "@crossline/db";

const OWNER_ID = "local-owner";
const PROVIDER = "graph_calendar";
/** A delta stream can page; this caps one tick so a first sync cannot spin forever. */
const MAX_PAGES = 20;
/**
 * How many days of reality the plan carries, starting today.
 *
 * Seven, because the A lens is a day/week view: importing only today meant the week view had nothing
 * to show and the sync threw away twenty of every twenty-one events it had already paid to read.
 */
const WINDOW_DAYS = Number(process.env.CROSSLINE_PLAN_WINDOW_DAYS ?? 7);

export type CalendarReader = { pullCalendar(cursor?: string): Promise<GraphDeltaPage> };

/**
 * One calendar, in one account, that the person asked to have read.
 *
 * `key` is `<accountId>:<calendarId>`. It is the cursor's `external_id` and the `sourceKey` stamped on
 * every block this source produces, which is what makes it safe for one source to fail while the
 * others sync: a source may only add, change or delete the plan blocks that carry its own key.
 */
export type CalendarSource = { key: string; label: string; reader: CalendarReader };

export type SyncOutcome =
  | {
      state: "synced"; imported: number; skipped: number; changes: number;
      planVersionId?: string; resynced: boolean;
      /** Sources that could not be read this tick. Their existing blocks were left alone. */
      failed?: Array<{ key: string; label: string; code: string }>;
    }
  | { state: "blocked"; code: string; message: string };

/**
 * Reads every page of the delta stream for this tick.
 *
 * A `resyncRequired` answer is not an error: Graph threw the cursor away, which happens to any worker
 * that was off for a while. It restarts from the base URL, and the caller is told, because after a
 * resync the pages are the complete current state rather than a list of changes — items deleted during
 * the gap simply are not there, with no tombstone to apply.
 */
async function readAll(reader: CalendarReader, cursor: string | null): Promise<{
  items: ExternalItem[]; cursor: string | null; resynced: boolean;
}> {
  let next: string | undefined = cursor ?? undefined;
  let resynced = false;
  const items: ExternalItem[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result: GraphDeltaPage = await reader.pullCalendar(next);
    if (result.resyncRequired) {
      if (resynced) break;
      resynced = true;
      items.length = 0;
      next = undefined;
      continue;
    }
    items.push(...result.items);
    // A deltaLink ends the stream; a nextLink means another page. They are indistinguishable here, so
    // the loop stops when a page returns nothing new to follow.
    if (!result.cursor || result.cursor === next) { next = result.cursor ?? next; break; }
    next = result.cursor;
    if (!result.items.length) break;
  }
  return { items, cursor: next ?? null, resynced };
}

/**
 * The reality blocks a plan version was built on, as recorded in its payload.
 *
 * A block written before the plan carried days has no `day`, and by construction it was a block for
 * the day it was imported on — so it reads as today rather than as blank. Leaving it empty would make
 * the first sync after the upgrade report every imported block as having moved.
 */
function planReality(payload: unknown, today: string): RealityBlock[] {
  const blocks = (payload as { blocks?: Array<Record<string, unknown>> }).blocks ?? [];
  return blocks
    .filter((block) => typeof block.source === "string" && String(block.id).startsWith(`${PROVIDER}:`))
    .map((block) => ({
      id: String(block.id), title: String(block.title), day: String(block.day ?? today),
      start: String(block.start), end: String(block.end), source: String(block.source),
      // Missing on anything imported before there was more than one calendar. Those blocks came from
      // the single default-calendar read, and the pass below adopts them into whichever source now
      // reports them; any that nobody reports are ghosts and get dropped.
      ...(typeof block.sourceKey === "string" ? { sourceKey: block.sourceKey } : {})
    }));
}

/** What one source contributed this tick, or why it contributed nothing. */
type SourceRead =
  | { ok: true; source: CalendarSource; blocks: RealityBlock[]; removed: Set<string>; authoritative: boolean; resynced: boolean; skipped: number }
  | { ok: false; source: CalendarSource; code: string };

/**
 * Pulls the signed-in user's calendar and reflects it into the day plan.
 *
 * Two rules decide what happens to the plan, and they are the whole point of the job:
 *
 * - a **draft** plan is updated in place, because nothing has been agreed yet;
 * - an **approved** plan is never rewritten. Reality moving under a plan you already approved is a
 *   disagreement, not an update, so it becomes a new draft version whose changes are all `conflict` —
 *   which `approvePlanVersion` then refuses to wave through until each one has been looked at.
 */
export function createGraphSync(store: CrosslineStore, workspaceId: string, options: {
  /** Resolved fresh on each tick, because the person can change which calendars are read. */
  sources: () => CalendarSource[];
  now?: () => Date;
  timeZone?: string;
}) {
  const now = options.now ?? (() => new Date());
  return async function sync(): Promise<SyncOutcome> {
    const sources = options.sources();
    if (!sources.length) {
      return { state: "blocked", code: "GRAPH_NO_CALENDAR_SELECTED", message: "没有勾选任何日历；在连接页选一个再同步。" };
    }

    const days = new Set(syncWindowDays(now(), WINDOW_DAYS, options.timeZone));
    const today = [...days][0]!;

    const reads: SourceRead[] = [];
    for (const source of sources) {
      const storedCursor = store.readSyncCursor(workspaceId, PROVIDER, source.key);
      let page: Awaited<ReturnType<typeof readAll>>;
      try {
        page = await readAll(source.reader, storedCursor);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        // One account being signed out, rate-limited or unreachable must not take the others down with
        // it, and above all must not look like its events were deleted.
        reads.push({ ok: false, source, code: /^GRAPH_[A-Z_]+/.test(message) ? message.split(":")[0]! : "GRAPH_SYNC_FAILED" });
        continue;
      }
      // Tombstones first: an item that arrived earlier in the same stream and was then deleted must not
      // survive because the addition happened to come later in the page order.
      const removed = new Set(page.items.filter((item) => item.removed).map((item) => `${item.provider}:${item.externalId}`));
      const live = page.items.filter((item) => !item.removed && !removed.has(`${item.provider}:${item.externalId}`));
      // Dedup by iCalUid so the same meeting arriving twice is one block, not two stacked on each
      // other. Across accounts this is what collapses one shared invite into a single block.
      const reconciled = reconcileExternalItems(live).items;
      const blocks: RealityBlock[] = [];
      let skipped = 0;
      for (const item of reconciled) {
        const block = toRealityBlock(item, options.timeZone, { key: source.key, label: source.label });
        // Outside the window is not a skip worth reporting: the delta range is wider than the plan on
        // purpose, so that a change just beyond the edge is already known when the window rolls onto it.
        if (!block) { skipped += 1; continue; }
        if (days.has(block.day)) blocks.push(block);
      }
      reads.push({
        ok: true, source, blocks, removed, skipped, resynced: page.resynced,
        authoritative: page.resynced || !storedCursor
      });
      store.saveSyncCursor({ ownerId: OWNER_ID, workspaceId, provider: PROVIDER, collection: source.key, cursor: page.cursor });
    }

    const read = reads.filter((entry): entry is Extract<SourceRead, { ok: true }> => entry.ok);
    const failed = reads.filter((entry) => !entry.ok)
      .map((entry) => ({ key: entry.source.key, label: entry.source.label, code: (entry as { code: string }).code }));
    // Every source failing is the old single-source failure, and the old answer is still the right one.
    if (!read.length) {
      return { state: "blocked", code: failed[0]?.code ?? "GRAPH_SYNC_FAILED", message: "读取日历失败；计划中的现实轨保持原样。" };
    }

    const skipped = read.reduce((total, entry) => total + entry.skipped, 0);
    const resynced = read.some((entry) => entry.resynced);
    const blocks = read.flatMap((entry) => entry.blocks)
      .sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    const removed = new Set(read.flatMap((entry) => [...entry.removed]));

    const plans = store.listPlanVersions(workspaceId);
    const current = plans[0];
    if (!current) {
      return { state: "synced", imported: blocks.length, skipped, changes: 0, resynced, ...(failed.length ? { failed } : {}) };
    }

    const previous = planReality(current.payload, today);
    /**
     * An incremental delta page lists what CHANGED. A block it does not mention is unchanged, not
     * gone — treating every page as the authoritative set wiped the whole plan on the second tick and
     * reported everything as deleted.
     *
     * A page is the complete set in exactly two cases: the first read (no stored cursor), and a resync
     * the server forced. Only then may local blocks missing from it be dropped.
     *
     * Authority is **per source**. A source that read its whole calendar may drop its own stale blocks
     * and nobody else's — so a source that failed this tick keeps everything it contributed last time,
     * and a source that was just unticked keeps nothing, because it is no longer read at all.
     */
    const kept = new Map(previous.map((block) => [block.id, block]));
    const fresh = new Set(blocks.map((block) => block.id));
    // Blocks from before there were multiple sources carry no key, so there is no way to tell which
    // source owns them. They may only be dropped when EVERY selected source read its whole calendar
    // this tick — only then is the fresh set the complete picture and a missing block really gone.
    //
    // `some(authoritative)` was wrong and did real damage: ticking a second calendar made that new
    // source authoritative (it has no cursor yet) while the original stayed incremental, and every
    // legacy block was deleted as though the calendar had been emptied. On an approved plan that
    // forked a draft full of 「日历中已不存在」 conflicts for events that were never touched.
    const legacyAdoptable = read.length === sources.length && read.every((entry) => entry.authoritative);
    const selected = new Set(sources.map((source) => source.key));
    for (const [id, block] of kept) {
      const owner = read.find((entry) => entry.source.key === block.sourceKey);
      if (owner) { if (owner.authoritative && !fresh.has(id)) kept.delete(id); continue; }
      // Not read this tick. Two very different reasons, and confusing them is the whole hazard here:
      // a source still selected but failing keeps its blocks, while one the person unticked loses them,
      // because nothing is going to update them ever again.
      if (block.sourceKey) { if (!selected.has(block.sourceKey)) kept.delete(id); continue; }
      if (legacyAdoptable && !fresh.has(id)) kept.delete(id);
    }
    for (const id of removed) kept.delete(id);
    for (const block of blocks) kept.set(block.id, block);
    let next = [...kept.values()];
    // Whatever the source, the plan only carries the window: a block that aged off the front leaves
    // quietly rather than lingering as a stale row nobody can act on.
    next = next.filter((block) => days.has(block.day))
      .sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));

    const changes = realityChanges(previous, next, today);
    if (!changes.length) {
      return {
        state: "synced", imported: next.length, skipped, changes: 0,
        planVersionId: current.id, resynced, ...(failed.length ? { failed } : {})
      };
    }

    const mine = new Set(previous.map((block) => block.id));
    const authored = ((current.payload as { blocks?: Array<Record<string, unknown>> }).blocks ?? [])
      .filter((block) => !mine.has(String(block.id)));
    const merged = [
      // Imported reality is read-only in the plan: editing it here would silently diverge from the
      // calendar it came from, and the next sync would undo the edit anyway.
      ...next.map((block) => ({ ...block, lane: "human" as const, readOnly: true })),
      ...authored
    ];

    const target = current.status === "draft"
      ? { id: current.id, version: current.version }
      : { id: `plan-${randomUUID()}`, version: current.version + 1 };
    store.savePlanVersion({
      id: target.id, ownerId: OWNER_ID, workspaceId,
      version: target.version, status: "draft", payload: { blocks: merged }
    });
    for (const change of changes) {
      store.savePlanChange({
        // Hashed, not truncated. A Graph event id is ~150 characters and two events in the same mailbox
        // share almost all of it, so `.slice(0, 200)` cut the `:add`/`:move` suffix off and made a move
        // upsert onto the earlier add row — the C lens then showed "新增" next to text describing a move.
        // A long enough shared prefix would have collapsed two different events onto one row entirely.
        id: `${target.id}:${createHash("sha1").update(change.blockId).digest("hex").slice(0, 16)}:${change.kind}`,
        ownerId: OWNER_ID, workspaceId, planVersionId: target.id,
        // Against an approved plan every reality change is a conflict, because it contradicts something
        // already agreed. On a draft it keeps its own shape — nothing was agreed to contradict.
        kind: current.status === "draft" ? change.kind : "conflict",
        triggerEventId: `graph-sync:${today}`,
        explanation: change.explanation,
        status: "pending"
      });
    }
    store.appendEvent({
      ownerId: OWNER_ID, workspaceId,
      idempotencyKey: `graph-sync:${today}:${target.id}:${changes.length}`,
      type: "plan.reality_changed", entityId: target.id,
      payload: { changes, resynced, skipped, against: current.status, ...(failed.length ? { failed } : {}) }
    });
    return {
      state: "synced", imported: next.length, skipped,
      changes: changes.length, planVersionId: target.id, resynced, ...(failed.length ? { failed } : {})
    };
  };
}

export type { RealityChange };
