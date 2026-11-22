import {
  CALENDAR_LINES, EVENT_MERGE_REVIEW, EVENT_MERGES, FIXED_EVENTS, TASK_MERGE_REVIEW_SCHEMA, fixedEventBlocks, fixedTimedItemOf, isCancelledEvent,
  mergeCandidates, readMergeBook, readMergeReview, sameTitle, validateTaskMergeReview, type CalendarLines, type FixedEvent, type MergeCandidate,
  type TaskMergeReview, type TimedItem
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";

/**
 * Overlapping items on the person's calendar that might be one thing (`packages/core/src/event-merge.ts`, 2026-11-22). Code circles the
 * candidates — overlapping, titles worth a look — and the reviewer decides which pairs are the same thing; only those (and pairs with the
 * same title) become the person's `event_merge` question. Each pair of series is reviewed once (`EVENT_MERGE_REVIEW`); nothing is merged
 * here, the person still answers.
 */
const REVIEWER = "crossline:crossline-validation-reviewer";
const MAX_PAIRS = 12;
const LOOKAHEAD_DAYS = 15;
const DAY_MS = 86_400_000;

const json = <T>(raw: string | null | undefined, fallback: T): T => { try { return (JSON.parse(raw ?? "null") as T | null) ?? fallback; } catch { return fallback; } };

/** The fixed items on the stored plan and the person's own events over the next two weeks, as the web's merge asks see them. */
export function fixedItemsForReview(store: CrosslineStore, workspaceId: string, now: Date): TimedItem[] {
  // From yesterday: the stored days are the person's local ones, which may be a day behind UTC.
  const days = Array.from({ length: LOOKAHEAD_DAYS }, (_, index) => new Date(now.getTime() + (index - 1) * DAY_MS).toISOString().slice(0, 10));
  const wanted = new Set(days);
  const marks = json<CalendarLines | null>(store.getSetting(workspaceId, CALENDAR_LINES), null);
  type Block = { id: string; title: string; day?: string; start: string; end: string; sourceKey?: string };
  const stored = ((store.listPlanVersions(workspaceId)[0]?.payload as { blocks?: Block[] } | undefined)?.blocks ?? [])
    .filter((block) => block.day && wanted.has(block.day) && !(block.id.startsWith("graph_calendar:") && isCancelledEvent(marks, block.title)));
  const events = json<FixedEvent[]>(store.getSetting(workspaceId, FIXED_EVENTS), []);
  return [...stored, ...fixedEventBlocks(events, days)].flatMap((block) => { const item = fixedTimedItemOf(block); return item ? [item] : []; });
}

/** Candidates the reviewer has not seen: different titles (the same title is asked without a review), not yet answered, soonest first. */
export function eventMergeCandidates(store: CrosslineStore, workspaceId: string, now: Date): MergeCandidate[] {
  const review = readMergeReview(store.getSetting(workspaceId, EVENT_MERGE_REVIEW));
  return mergeCandidates(fixedItemsForReview(store, workspaceId, now), readMergeBook(store.getSetting(workspaceId, EVENT_MERGES)))
    .filter((pair) => !sameTitle(pair.a.title, pair.b.title) && review[pair.key] === undefined).slice(0, MAX_PAIRS);
}

const SOURCE: Record<TimedItem["kind"], string> = { calendar: "synced calendar", file: "read from a file", event: "added by the person", heard: "heard in a recording", work: "scheduled work" };

/** Asks the reviewer about the circled pairs once each and records its answers. Returns the keys it called the same. */
export async function eventMergeReviewPass(store: CrosslineStore, workspaceId: string, client: CodexRpcBoundary, cwd: string, now = new Date()): Promise<string[]> {
  const pairs = eventMergeCandidates(store, workspaceId, now);
  if (!pairs.length) return [];
  const side = (item: TimedItem) => ({ title: item.title, intent: `${SOURCE[item.kind]}: ${item.day} ${item.start}–${item.end}`, milestone: "", due: item.day });
  const input = { version: "crossline.event-merge-review.v1", pairs: pairs.map((pair, index) => ({ id: `p${index + 1}`, a: side(pair.a), b: side(pair.b),
    rule: `event_vs_event: overlapping on ${pair.days} day(s) from ${pair.firstDay}` })) };
  const result = await runCodexSkill<TaskMergeReview>(client, input, { skillName: REVIEWER, cwd,
    developerInstructions: "Each pair is two items on the person's calendar that overlap in time. same: true only when both are the same "
      + "occurrence of one thing reaching the calendar twice (a class from the synced calendar and from the syllabus, a meeting the person typed "
      + "that the calendar already had), whatever language or abbreviation each title uses. Two different things at one time are false: a "
      + "lecture and office hours of one course, homework 2 and homework 3, two different meetings. When unsure, false. Return only the requested JSON.",
    outputSchema: TASK_MERGE_REVIEW_SCHEMA as unknown as Record<string, unknown>, prepareInput: () => input,
    validateOutput: (output) => validateTaskMergeReview(output, input.pairs.map((pair) => pair.id)), onAudit: () => {}, timeoutMs: 30 * 60_000 });
  if (!result.ok) return [];
  const review = readMergeReview(store.getSetting(workspaceId, EVENT_MERGE_REVIEW));
  const same: string[] = [];
  for (const answer of result.output.pairs) {
    const pair = pairs[Number(answer.id.slice(1)) - 1];
    if (!pair) continue;
    review[pair.key] = { same: answer.same, why: answer.why, at: now.toISOString() };
    if (answer.same) same.push(pair.key);
  }
  store.setSetting(workspaceId, EVENT_MERGE_REVIEW, JSON.stringify(review));
  return same;
}
