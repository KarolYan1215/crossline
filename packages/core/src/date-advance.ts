/**
 * Things that wait for the person move with the calendar (the owner's rule of 2026-10-21, after 27 assistant results sat in 待确认 with
 * the oldest from 10-08 and approved milestones stayed due on days long gone): every pending thing has a moment, and once that moment
 * passes without the person acting it does not stay on the old day. It is carried to the next moment that matters with a new reason,
 * decided by the system the recommended way (undoable), or put away (recoverable); and the person is told once.
 *
 * These are the rules; the worker's daily pass (`apps/worker/src/date-advance.ts`) applies them to the ledger.
 */

const DAY = 86_400_000;

/** A finished assistant result nobody reviewed for this long is decided by the system when it is safe to (see `adoptable`). */
export const RESULT_REVIEW_DAYS = 7;
/** One that is not safe to adopt is put away (still in 助手产出) after this long. */
export const RESULT_EXPIRE_DAYS = 14;
/** An overdue milestone moved by the system is never due sooner than this many days from today. */
export const OVERDUE_MIN_DAYS = 3;

export const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const later = (a: string, b: string) => (a > b ? a : b);

/**
 * What a step delivers, as a comparison key: the step part of a run's `「task」 · 「step」` title, without case, spaces or punctuation.
 * Two tasks of one course both planned 「汇集课程讲义、作业与样题，形成材料目录」; the key is what makes them the same work.
 */
export const deliverableKey = (title: string): string => (title.split(" · ").at(-1) ?? title).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

export type ResultRow = { taskId: string; workOrderId: string; stepId: string; title: string; requestedAt: string; status: string };

/**
 * Two runs did the same piece of work: the same order (or both outside any order, a grown workflow's runs) and the same step, or the same
 * deliverable when the step was re-planned under a new id. An empty key never matches: a run titled 「任务 · 」 has no step part, and keying
 * on that put every step of one task together, so only the newest of six different steps was left to review.
 */
export function sameWork(a: ResultRow, b: ResultRow): boolean {
  if (a.workOrderId !== b.workOrderId) return false;
  if (a.stepId && a.stepId === b.stepId) return true;
  const key = deliverableKey(a.title);
  return Boolean(key) && key === deliverableKey(b.title);
}

/** Each result waiting for review that a later finished run of the same work replaced, with the run that replaced it (the newest). */
export function supersededResults(rows: ResultRow[]): Map<string, string> {
  const finished = rows.filter((row) => row.status === "needs_review" || row.status === "accepted");
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.status !== "needs_review") continue;
    const newer = finished.filter((other) => other.taskId !== row.taskId && other.requestedAt > row.requestedAt && sameWork(row, other))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
    if (newer) out.set(row.taskId, newer.taskId);
  }
  return out;
}

export type AdvanceResultRow = ResultRow & {
  /** When it was handed over (its `agent.task.completed`), else when it was asked for. */
  completedAt?: string;
  checksPassed: boolean; inputsModified: string[];
  /** The run touched something outside the machine (a send, publish, upload or payment the guard flagged). */
  external: boolean;
  /** A run stopped part way, offered as it was. */
  partial: boolean;
  /** Already put away by an earlier pass. */
  settled?: string;
  /** The task it was for is accepted or archived: not a decision any more, left as it is. */
  orderGone: boolean;
};

/**
 * Safe for the system to accept in the person's place: its own checks passed, it changed none of the person's originals, it touched
 * nothing outside the machine, and it is a finished run (not a stopped one, and not a run that grows a workflow, which installs code).
 */
export const adoptable = (row: AdvanceResultRow): boolean =>
  row.checksPassed && !row.inputsModified.length && !row.external && !row.partial && !row.taskId.startsWith("grow-");

export type ResultMove =
  | { taskId: string; action: "supersede"; by: string }
  | { taskId: string; action: "adopt" }
  | { taskId: string; action: "expire" };

/** What the daily pass does with each result still waiting for the person. Results already settled or for finished work are left alone. */
export function advanceResults(rows: AdvanceResultRow[], now: Date): ResultMove[] {
  const replaced = supersededResults(rows.filter((row) => !row.settled));
  return rows.filter((row) => row.status === "needs_review" && !row.settled && !row.orderGone).flatMap((row): ResultMove[] => {
    const by = replaced.get(row.taskId);
    if (by) return [{ taskId: row.taskId, action: "supersede", by }];
    const ageDays = (now.getTime() - Date.parse(row.completedAt ?? row.requestedAt)) / DAY;
    if (adoptable(row)) return ageDays > RESULT_REVIEW_DAYS ? [{ taskId: row.taskId, action: "adopt" }] : [];
    return ageDays > RESULT_EXPIRE_DAYS ? [{ taskId: row.taskId, action: "expire" }] : [];
  });
}

export type DeadlineRow = { id: string; line: string; project: string; deadline: string };

/**
 * Moves milestones to new days and keeps each line's chain in order: a later milestone of the same line and project that the move would
 * now put before the moved one goes by the same number of days. A milestone moved twice keeps the later day. Pure: the caller writes it.
 */
export function shiftWithChain(approved: DeadlineRow[], seeds: Array<{ id: string; to: string; days: number }>): Map<string, string> {
  const byId = new Map(approved.map((row) => [row.id, row]));
  const moves = new Map<string, string>();
  for (const seed of seeds) {
    const moved = byId.get(seed.id);
    if (!moved) continue;
    moves.set(seed.id, later(moves.get(seed.id) ?? "", seed.to));
    for (const other of approved) {
      if (other.id === seed.id || other.line !== moved.line || other.project !== moved.project || !other.deadline) continue;
      if (other.deadline >= moved.deadline && other.deadline <= seed.to) moves.set(other.id, later(moves.get(other.id) ?? "", addDays(other.deadline, seed.days)));
    }
  }
  return moves;
}

/** The cautious finish of open work with nothing else known: its p85 minutes at the person's daily hours, from today. */
export const conservativeFinish = (today: string, openMinutes: number, dailyMinutes: number): string =>
  addDays(today, Math.max(0, Math.ceil(openMinutes / Math.max(30, dailyMinutes))));

/**
 * The day an overdue milestone of the person's own moves to: its cautious finish plus the margin the forecast asks for, and never sooner
 * than `OVERDUE_MIN_DAYS` from today.
 */
export const overdueTarget = (input: { today: string; finish: string; marginDays: number }): string =>
  later(addDays(input.finish, input.marginDays), addDays(input.today, OVERDUE_MIN_DAYS));
