/**
 * What the person did to the events this app wrote on their calendar, judged the same way whichever calendar it is (Outlook now,
 * Google later; docs/loop-and-scout.md §1, §13). The writer only reports what it read back; this decides what it means:
 *
 * - the time moved   → the person put it there: lock that block at the new time;
 * - only the title   → not a lock: keep moving it with the plan, under the person's title;
 * - a future event gone → the person removed it: never create that block again (the task is still planned elsewhere).
 *
 * A record written before this (only a content hash) is left to the old rule — changed means leave alone — until the next write
 * stores the new shape.
 */
export type PublishedEntry = {
  eventId: string;
  title: string;
  /** Instants as written. */
  start: string;
  end: string;
  reminder?: number | null;
  recurrence?: string;
  /** The title the person gave it; later writes keep it. */
  personTitle?: string;
  /** The person deleted the event: the block is not written again. */
  removedByPerson?: true;
  /** A record from before titles and times were kept apart. */
  hash?: string;
};

export type ReadBack = { blockId: string; eventId: string; title: string; start: string; end: string };

export type CalendarEdits = {
  moved: Array<{ blockId: string; start: string; end: string }>;
  retitled: Array<{ blockId: string; title: string }>;
  removed: string[];
};

/** Minute precision, as an instant: calendars return the same time in different formats and precisions. */
const minute = (value: string) => { const at = Date.parse(value); return Number.isFinite(at) ? Math.floor(at / 60_000) : NaN; };

export function classifyCalendarEdits(ledger: Record<string, PublishedEntry>, readBack: ReadBack[], now: Date): CalendarEdits {
  const edits: CalendarEdits = { moved: [], retitled: [], removed: [] };
  const seen = new Map(readBack.map((item) => [item.blockId, item]));
  for (const [blockId, entry] of Object.entries(ledger)) {
    if (entry.removedByPerson || (entry.hash && !entry.start)) continue;
    const read = seen.get(blockId);
    if (!read) {
      if (Date.parse(entry.start) > now.getTime()) edits.removed.push(blockId);
      continue;
    }
    if (minute(read.start) !== minute(entry.start) || minute(read.end) !== minute(entry.end)) {
      edits.moved.push({ blockId, start: new Date(minute(read.start) * 60_000).toISOString(), end: new Date(minute(read.end) * 60_000).toISOString() });
      continue;
    }
    if (read.title !== (entry.personTitle ?? entry.title)) edits.retitled.push({ blockId, title: read.title });
  }
  return edits;
}
