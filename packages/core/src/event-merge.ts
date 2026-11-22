import { calendarEventKey } from "./calendar-lines";
import { CANDIDATE, normalizeTaskTitle, textSimilarity } from "./task-merge";

/**
 * Overlapping timed items that are the same thing (the owner, 2026-11-03: 「对于所有时间冲突的事项，应该检查两者内容是否相似，相似的话
 * 则询问用户是否合并，周期性事务只要用户合并一次就应该持续合并」). A class can reach the plan three ways at once — the synced calendar, the
 * syllabus's dates and an event the person typed — and the day view drew it two or three times over.
 *
 * - Two items overlap on one day and their titles are worth a look (`titlesWorthALook`, cheap character overlap) → a candidate. Code
 *   asks the person about it only when the titles are the same (`sameTitle`) or the reviewer model called the two the same thing
 *   (`EVENT_MERGE_REVIEW`, `apps/worker/src/event-merge-review.ts`) → the `event_merge` ask: 合并 / 两个都留 / 不是同一件事. Before
 *   2026-11-22 a synonym-free Dice score, a course-code rule and a number rule decided it, which merged 「ECE 555 Lecture」 with
 *   「ECE 555 Office Hours」 and knew nothing outside courses. A candidate not yet reviewed is not asked about (both stay, shown overlapping).
 * - The answer is kept per **series**, not per occurrence (`seriesKey`: where it came from, its title, its start), so a weekly class merged
 *   once stays merged every week, and a pair answered 「不是同一件事」 is not asked again.
 * - A merged pair is drawn as one item: the one kept is the stronger source (`KEEP_RANK`: the person's own calendar, then a file's item,
 *   then an event the person added, then a day heard in a recording); a work block the person locked over a calendar event of the same
 *   work keeps the work block.
 * - Where the person names a concrete time and a new event would be made (the input box, a file's dates, a recording), a matching item
 *   already there (`matchesItem`: same day, starts within 15 minutes, `sameTitle`) is merged into without asking. Anything less than the
 *   same title is written and left to the candidates above: nothing is merged by itself on a resemblance.
 *
 * Stored in `schedule.merges`, a `schedule.` setting, so undo and backups carry it.
 */
export const EVENT_MERGES = "schedule.merges";

export type TimedKind = "calendar" | "file" | "event" | "heard" | "work";
export type TimedItem = {
  id: string; kind: TimedKind; title: string; day: string; start: string; end: string;
  /** A calendar block's source (`<account>:<calendar>`, `ical:<id>`), so the same event in two calendars is two series. */
  source?: string;
  /** A work block's order: its series is the order, since the work moves while the calendar event stays. */
  orderId?: string;
};
export type MergeHow = "merge" | "both" | "different";
export type MergeDecision = { how: MergeHow; keep: string; drop: string; titles: [string, string]; at: string; by: "person" | "system" };
export type MergeBook = Record<string, MergeDecision>;

/** Which of a merged pair stays on the plan: the lower rank. */
export const KEEP_RANK: Record<TimedKind, number> = { work: 0, calendar: 1, file: 2, event: 3, heard: 4 };
/** How far apart two starts may be for an item to be the one the person just named. */
export const SAME_START_MINUTES = 15;

const squash = (text: string) => text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
const toMinutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

/** The same title once spaces, punctuation, case and filler words are set aside: the only resemblance code acts on by itself. */
export function sameTitle(a: string, b: string): boolean {
  const x = normalizeTaskTitle(a), y = normalizeTaskTitle(b);
  return Boolean(x) && x === y;
}

/**
 * Two titles share enough characters to be worth the reviewer's look: one contains the other, or their character bigrams are `CANDIDATE`
 * alike. It only draws candidates; which ones are the same thing (a lecture and its office hours are not; 「组会」 and 「实验室组会（周三）」
 * are) is the reviewer's, and the person's.
 */
export function titlesWorthALook(a: string, b: string): boolean {
  const x = squash(a), y = squash(b);
  if (!x || !y) return false;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return true;
  return textSimilarity(normalizeTaskTitle(a), normalizeTaskTitle(b)) >= CANDIDATE;
}

/** The reviewer's reading of candidate pairs, by `pairKey` of their series: `same` asks the person, anything else does not. */
export const EVENT_MERGE_REVIEW = "schedule.mergeReview";
export type MergeReview = Record<string, { same: boolean; why: string; at: string }>;
export function readMergeReview(raw: string | null | undefined): MergeReview {
  try { const parsed = JSON.parse(raw ?? "null") as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as MergeReview : {}; } catch { return {}; }
}

/** The series an item belongs to: every week's occurrence of one class has the same key. */
export function seriesKey(item: TimedItem): string {
  if (item.kind === "work") return `work:${item.orderId ?? item.id}`;
  return `${item.kind}${item.source ? `/${item.source}` : ""}:${calendarEventKey(item.title)}@${item.start}`;
}
export const pairKey = (a: string, b: string) => [a, b].sort().join("||");
const overlaps = (a: TimedItem, b: TimedItem) => a.day === b.day && a.start < b.end && b.start < a.end;

export function readMergeBook(raw: string | null | undefined): MergeBook {
  try { const parsed = JSON.parse(raw ?? "null") as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as MergeBook : {}; } catch { return {}; }
}

/** The decision for two items, kept by series. */
export function decisionFor(book: MergeBook, a: TimedItem, b: TimedItem): MergeDecision | undefined {
  return book[pairKey(seriesKey(a), seriesKey(b))];
}

/** The decision to record for a pair: which series is kept and which drops out of view. */
export function mergeDecision(a: TimedItem, b: TimedItem, how: MergeHow, by: "person" | "system", at: string): { key: string; decision: MergeDecision } {
  const [keep, drop] = KEEP_RANK[a.kind] <= KEEP_RANK[b.kind] ? [a, b] : [b, a];
  return { key: pairKey(seriesKey(a), seriesKey(b)),
    decision: { how, keep: seriesKey(keep), drop: seriesKey(drop), titles: [keep.title, drop.title], at, by } };
}

export type MergeCandidate = { key: string; a: TimedItem; b: TimedItem; firstDay: string; days: number };

/**
 * Candidate pairs: overlapping on a day, titles worth a look, from different series, and not decided yet. One per series pair (a weekly
 * class overlaps its calendar copy every week), with its first day and how many days it happens on. Work blocks are left to
 * `locked_conflict`. With `review`, only the pairs to ask the person about: the same title, or called the same by the reviewer.
 */
export function mergeCandidates(items: TimedItem[], book: MergeBook, review?: MergeReview): MergeCandidate[] {
  const byDay = new Map<string, TimedItem[]>();
  for (const item of items) if (item.kind !== "work") byDay.set(item.day, [...(byDay.get(item.day) ?? []), item]);
  const found = new Map<string, MergeCandidate>();
  for (const day of [...byDay.keys()].sort()) {
    const list = byDay.get(day)!;
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]!, b = list[j]!;
      const sa = seriesKey(a), sb = seriesKey(b);
      if (sa === sb || !overlaps(a, b) || !titlesWorthALook(a.title, b.title)) continue;
      const key = pairKey(sa, sb);
      if (book[key]) continue;
      if (review && !sameTitle(a.title, b.title) && review[key]?.same !== true) continue;
      const known = found.get(key);
      if (known) { if (known.firstDay !== day) known.days += 1; continue; }
      found.set(key, { key, a, b, firstDay: day, days: 1 });
    }
  }
  return [...found.values()].sort((x, y) => x.firstDay.localeCompare(y.firstDay));
}

/**
 * The items as they are drawn: an item whose series a 「合并」 dropped is left out on every day it overlaps the kept series, and the kept
 * one carries the titles merged into it. A dropped item with nothing of the kept series beside it that day stays (the merge says the two
 * are the same where they meet, nothing about a day one of them is alone).
 */
export function applyMerges<T extends TimedItem>(items: T[], book: MergeBook): { items: T[]; mergedInto: Map<string, string[]> } {
  const merges = Object.values(book).filter((decision) => decision.how === "merge");
  if (!merges.length) return { items, mergedInto: new Map() };
  const keys = new Map(items.map((item) => [item.id, seriesKey(item)]));
  const dropped = new Set<string>();
  const mergedInto = new Map<string, string[]>();
  for (const item of items) {
    const key = keys.get(item.id)!;
    for (const decision of merges.filter((entry) => entry.drop === key)) {
      const keeper = items.find((other) => other !== item && keys.get(other.id) === decision.keep && overlaps(item, other) && !dropped.has(other.id));
      if (!keeper) continue;
      dropped.add(item.id);
      mergedInto.set(keeper.id, [...(mergedInto.get(keeper.id) ?? []), item.title]);
      break;
    }
  }
  return { items: items.filter((item) => !dropped.has(item.id)), mergedInto };
}

/** Whether a series has been merged away into another (so it is never written to a calendar or offered again). */
export const mergedAway = (book: MergeBook, key: string) => Object.values(book).some((decision) => decision.how === "merge" && decision.drop === key);

/**
 * Whether `existing` is the item the person just named: same day, starts within 15 minutes, the same title. Merged without asking, so
 * only on the same title; a resemblance is written and becomes a candidate for the reviewer and the person.
 */
export function matchesItem(named: { title: string; day: string; start: string }, existing: { title: string; day: string; start: string }): boolean {
  return named.day === existing.day && Math.abs(toMinutes(named.start) - toMinutes(existing.start)) <= SAME_START_MINUTES && sameTitle(named.title, existing.title);
}

/**
 * A stored plan block as a fixed timed item, by its id: a synced calendar's (`graph_calendar:`), a file's (`import:`), an event the person
 * added (`event:`); anything else (work, activity, proposals) is not one. Shared by the web's asks and the worker's review.
 */
export function fixedTimedItemOf(block: { id: string; title: string; day?: string | undefined; start: string; end: string; sourceKey?: string | undefined }, sourceKey?: string): TimedItem | undefined {
  if (!block.day) return undefined;
  const base = { id: block.id, title: block.title, day: block.day, start: block.start, end: block.end };
  const source = sourceKey ?? block.sourceKey;
  if (block.id.startsWith("graph_calendar:")) return { ...base, kind: "calendar", ...(source ? { source } : {}) };
  if (block.id.startsWith("import:")) return { ...base, kind: "file" };
  if (block.id.startsWith("event:")) return { ...base, kind: "event" };
  return undefined;
}
