import { randomUUID } from "node:crypto";
import { FROZEN_SETTING } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";

/**
 * One-time repair of what overlapping calendar publishes left in the ledger (found on the real account, 2026-10-15; decided by the
 * owner's delegate the same day). Two publishes at once read each other's writes as the person's own edits:
 *
 * - a block one run had just moved was read back by the other as 「dragged by the person」 and locked (`reason: "locked"`, no `via`,
 *   since only locks taken from the calendar after the fix carry `via: "calendar"`);
 * - a block one run had just removed was read back as 「deleted by the person」 and never written again (`removedByPerson`).
 *
 * Released: every such lock, unless the person may have made it — a lock not present before some undoable operation of theirs that
 * touched the frozen list (the lock button, 改时间, 保留重叠 all go through it), which is kept. Started blocks (`pinned`), `keep` and
 * `commit` are never touched. The 「deleted by the person」 marks are cleared so those blocks are written again. Runs once per
 * workspace (`repair.frozen-race.v1`), leaves a `repair.frozen_race` event naming what it changed, and records an undo that puts the
 * released locks back (the marks are not restored: by then the blocks are back on the calendar, and marking them again would only
 * stop them following the plan).
 */
export const FROZEN_RACE_REPAIR = "repair.frozen-race.v1";
const LEDGER = "calendar.published";

type Entry = { blockId?: string; reason?: string; via?: string; start?: string; end?: string };
type Inverse = { kind: string; entries?: Array<{ key: string; value: string | null }>; items?: Inverse[] };

const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

/** Locks that may be the person's: absent from the frozen list before one of their own undoable operations on it. */
function personLocks(store: CrosslineStore, workspaceId: string, current: Entry[]): Set<string> {
  const before = (inverse: Inverse): Array<string | null> => inverse.kind === "batch" ? (inverse.items ?? []).flatMap(before)
    : inverse.kind === "settings.restore" ? (inverse.entries ?? []).filter((entry) => entry.key === FROZEN_SETTING).map((entry) => entry.value) : [];
  const out = new Set<string>();
  for (const event of store.listEvents(workspaceId, { type: "op.applied" })) {
    for (const value of before((event.payload as { inverse?: Inverse }).inverse ?? { kind: "" })) {
      const lockedThen = new Set(parse<Entry[]>(value, []).filter((entry) => entry.reason === "locked").map((entry) => entry.blockId));
      for (const entry of current) if (entry.reason === "locked" && entry.blockId && !lockedThen.has(entry.blockId)) out.add(entry.blockId);
    }
  }
  return out;
}

export function repairFrozenRace(store: CrosslineStore, workspaceId: string, ownerId: string, now = new Date()):
  { released: string[]; republished: string[] } | undefined {
  if (store.getSetting(workspaceId, FROZEN_RACE_REPAIR)) return undefined;
  const frozenRaw = store.getSetting(workspaceId, FROZEN_SETTING) ?? null;
  const frozen = parse<Entry[]>(frozenRaw, []);
  // Only a workspace that has published can have been raced.
  const published = store.listEvents(workspaceId, { type: "calendar.published" }).length > 0;
  const kept = personLocks(store, workspaceId, frozen);
  const released = published ? frozen.filter((entry) => entry.reason === "locked" && !entry.via && entry.blockId && !kept.has(entry.blockId)) : [];
  const ledger = parse<Record<string, { removedByPerson?: boolean }>>(store.getSetting(workspaceId, LEDGER), {});
  const republished = published ? Object.keys(ledger).filter((blockId) => ledger[blockId]?.removedByPerson) : [];

  if (released.length) store.setSetting(workspaceId, FROZEN_SETTING, JSON.stringify(frozen.filter((entry) => !released.includes(entry))));
  if (republished.length) {
    for (const blockId of republished) delete ledger[blockId];
    store.setSetting(workspaceId, LEDGER, JSON.stringify(ledger));
  }
  store.setSetting(workspaceId, FROZEN_RACE_REPAIR, now.toISOString());
  if (!released.length && !republished.length) return { released: [], republished: [] };

  const at = now.toISOString();
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `repair.frozen_race:${workspaceId}`, type: "repair.frozen_race", entityId: workspaceId,
    payload: { released: released.map((entry) => ({ blockId: entry.blockId, start: entry.start, end: entry.end })), republished, at } });
  if (released.length) {
    // The same shape the web's undo writes (`recordOp`), so 撤销 in the input box and on 待确认 can take it back for a day.
    const id = `op-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `op.applied:${id}`, type: "op.applied", entityId: id,
      payload: { label: `解除 ${released.length} 个由日历回读误加的锁定`, inverse: { kind: "settings.restore", entries: [{ key: FROZEN_SETTING, value: frozenRaw }] } } });
  }
  return { released: released.map((entry) => entry.blockId!), republished };
}
