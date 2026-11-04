import { calendarEventKey } from "./calendar-lines";
import { normalizeTaskTitle, textSimilarity } from "./task-merge";

/**
 * Overlapping timed items that are the same thing (the owner, 2026-11-03: 「对于所有时间冲突的事项，应该检查两者内容是否相似，相似的话
 * 则询问用户是否合并，周期性事务只要用户合并一次就应该持续合并」). A class can reach the plan three ways at once — the synced calendar, the
 * syllabus's dates and an event the person typed — and the day view drew it two or three times over.
 *
 * - Two items overlap on one day and their titles say the same thing (`similarTitles`) → the `event_merge` ask: 合并 / 两个都留 / 不是同一件事.
 * - The answer is kept per **series**, not per occurrence (`seriesKey`: where it came from, its title, its start), so a weekly class merged
 *   once stays merged every week, and a pair answered 「不是同一件事」 is not asked again.
 * - A merged pair is drawn as one item: the one kept is the stronger source (`KEEP_RANK`: the person's own calendar, then a file's item,
 *   then an event the person added, then a day heard in a recording); a work block the person locked over a calendar event of the same
 *   work keeps the work block.
 * - Where the person names a concrete time and a new event would be made (the input box, a file's dates, a recording), a matching item
 *   already there (`matchesItem`: same day, starts within 15 minutes, `similarTitles`) is merged into without asking.
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

const COURSE = /[a-z]{2,5}\s?\d{3,4}/gi;
const squash = (text: string) => text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
const courseOf = (title: string) => (title.match(COURSE) ?? []).map((code) => code.replace(/\s/g, "").toLowerCase()).sort().join(",");
const numbersOf = (title: string) => (title.replace(COURSE, "").match(/\d+/g) ?? []).sort().join(",");
const toMinutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

/**
 * Two titles name the same thing: one contains the other, they share a course code, four characters in a row, or their normalized
 * titles are 0.6 alike (the task merge's rule). Never when both name a course and the courses differ (ECE 555 / ECE 548), or when the
 * numbers in them differ (作业 2 / 作业 3, Midterm 1 / Midterm 2).
 */
export function similarTitles(a: string, b: string): boolean {
  const x = squash(a), y = squash(b);
  if (!x || !y) return false;
  const ca = courseOf(a), cb = courseOf(b);
  if (ca && cb && ca !== cb) return false;
  if (numbersOf(a) !== numbersOf(b)) return false;
  if (x.includes(y) || y.includes(x)) return true;
  if (ca && ca === cb) return true;
  for (let i = 0; i + 4 <= x.length; i += 1) if (y.includes(x.slice(i, i + 4))) return true;
  return textSimilarity(normalizeTaskTitle(a), normalizeTaskTitle(b)) >= 0.6;
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
 * Pairs to ask about: overlapping on a day, titles alike, from different series, and not decided yet. One per series pair (a weekly class
 * overlaps its calendar copy every week), with its first day and how many days it happens on. Work blocks are left to `locked_conflict`.
 */
export function mergeCandidates(items: TimedItem[], book: MergeBook): MergeCandidate[] {
  const byDay = new Map<string, TimedItem[]>();
  for (const item of items) if (item.kind !== "work") byDay.set(item.day, [...(byDay.get(item.day) ?? []), item]);
  const found = new Map<string, MergeCandidate>();
  for (const day of [...byDay.keys()].sort()) {
    const list = byDay.get(day)!;
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]!, b = list[j]!;
      const sa = seriesKey(a), sb = seriesKey(b);
      if (sa === sb || !overlaps(a, b) || !similarTitles(a.title, b.title)) continue;
      const key = pairKey(sa, sb);
      if (book[key]) continue;
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

/** Whether `existing` is the item the person just named: same day, starts within 15 minutes, titles alike. */
export function matchesItem(named: { title: string; day: string; start: string }, existing: { title: string; day: string; start: string }): boolean {
  return named.day === existing.day && Math.abs(toMinutes(named.start) - toMinutes(existing.start)) <= SAME_START_MINUTES && similarTitles(named.title, existing.title);
}
