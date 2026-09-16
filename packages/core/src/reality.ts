/**
 * Comparing what the calendar now says against what a plan was built on.
 *
 * Pure and deterministic on purpose: this decides whether an approved plan has been invalidated, and
 * that decision must be reproducible from two lists rather than depending on when the sync happened to
 * run or what a model thought of it.
 */
export type RealityBlock = {
  /** Stable across syncs — derived from the source item's identity, not from its position or title. */
  id: string;
  title: string;
  /**
   * The local calendar day this block belongs to, `YYYY-MM-DD`.
   *
   * Imported reality is always dated. Seeded example blocks deliberately carry no day at all: they
   * illustrate a typical day, and pinning them to a date would leave them stranded in the past by
   * tomorrow while pretending to be real commitments.
   */
  day: string;
  /** Local wall-clock `HH:MM`. */
  start: string;
  end: string;
  source: string;
};

export type RealityChange =
  | { kind: "add"; blockId: string; title: string; explanation: string }
  | { kind: "remove"; blockId: string; title: string; explanation: string }
  | { kind: "move"; blockId: string; title: string; explanation: string };

/** `9/16 11:00–12:00`, or just the times when the block is today — the day is noise on today's row. */
const when = (block: RealityBlock, today: string) => {
  const span = `${block.start}–${block.end}`;
  if (block.day === today) return span;
  const [, month, date] = block.day.split("-");
  return `${Number(month)}/${Number(date)} ${span}`;
};

/**
 * What changed between the reality a plan was built on and the reality now.
 *
 * A retitled or rescheduled block counts as a move rather than a remove plus an add: it is the same
 * commitment, and splitting it would make the review read as if something vanished.
 */
export function realityChanges(previous: RealityBlock[], next: RealityBlock[], today = ""): RealityChange[] {
  const before = new Map(previous.map((block) => [block.id, block]));
  const after = new Map(next.map((block) => [block.id, block]));
  const changes: RealityChange[] = [];

  for (const block of next) {
    const old = before.get(block.id);
    if (!old) {
      changes.push({
        kind: "add", blockId: block.id, title: block.title,
        explanation: `日历新增「${block.title}」${when(block, today)}`
      });
      continue;
    }
    if (old.start !== block.start || old.end !== block.end || old.title !== block.title || old.day !== block.day) {
      changes.push({
        kind: "move", blockId: block.id, title: block.title,
        explanation: `「${old.title}」${when(old, today)} 变为「${block.title}」${when(block, today)}`
      });
    }
  }
  for (const block of previous) {
    if (after.has(block.id)) continue;
    // A block that has simply aged out of the window was not removed from anything — the window moved.
    // Saying "已不存在" there would raise a false alarm every single day as yesterday rolls off, and a
    // recurring meeting would look deleted every week when last week's occurrence dropped out.
    if (today && block.day && block.day < today) continue;
    changes.push({
      kind: "remove", blockId: block.id, title: block.title,
      explanation: `日历中已不存在「${block.title}」${when(block, today)}`
    });
  }
  // Ordered by day then id so two runs over the same data produce the same review, and the ledger
  // stays stable.
  return changes.sort((a, b) => a.blockId.localeCompare(b.blockId) || a.kind.localeCompare(b.kind));
}

/**
 * Turns an external calendar item into a dated plan block, or nothing when it cannot be one.
 *
 * An all-day or multi-day event is deliberately dropped rather than stretched across a strip: drawing
 * a week-long trip as a 00:00–23:59 bar would bury every real commitment underneath it. They are still
 * real constraints, which is why the caller counts what it skipped instead of pretending the days are
 * emptier than they are.
 */
export function toRealityBlock(item: {
  provider: string; externalId: string; title: string; start?: string; end?: string;
}, timeZone?: string): RealityBlock | undefined {
  if (!item.start || !item.end) return undefined;
  const start = new Date(item.start.endsWith("Z") ? item.start : `${item.start}Z`);
  const end = new Date(item.end.endsWith("Z") ? item.end : `${item.end}Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined;

  const clock = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {})
  });
  const dayOf = new Intl.DateTimeFormat("en-CA", { ...(timeZone ? { timeZone } : {}) });
  const day = dayOf.format(start);
  // Something that does not end on the day it starts is not a block on a day strip.
  if (dayOf.format(end) !== day) return undefined;
  return {
    id: `${item.provider}:${item.externalId}`,
    title: item.title,
    day,
    start: clock.format(start),
    end: clock.format(end),
    source: item.provider === "graph_calendar" ? "日历" : item.provider
  };
}

/** The `YYYY-MM-DD` days a sync window covers, starting today. */
export function syncWindowDays(now: Date, days: number, timeZone?: string): string[] {
  const dayOf = new Intl.DateTimeFormat("en-CA", { ...(timeZone ? { timeZone } : {}) });
  return Array.from({ length: Math.max(1, days) }, (_, offset) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + offset);
    return dayOf.format(date);
  });
}
