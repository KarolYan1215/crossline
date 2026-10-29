/**
 * Three rituals that put the person's decisions in one place instead of spread over the day (decided by the owner on 2026-10-28, after a
 * real day showed 630 usable minutes against 1735 of work, four tasks 5–11 days overdue only ever rolled forward, and 21 decisions, 14
 * questions, 9+ reminders and two different risk counts on one screen):
 *
 * - **the weekly commitment** (Sunsama's weekly plan, Motion's "too much this week"): once a week, the week's usable hours against the
 *   week's work, and every task in one of three groups — 保 (keep), 推 (to next week or later), 砍 (archive, recoverable) — suggested by
 *   rule and confirmed by the person in one undoable step; asked again mid-week only when a new overload appears;
 * - **the evening wrap-up** (Sunsama's shutdown): at the end of the person's last available hours, the day's blocks one tap each
 *   (完成 / 部分 / 没做) and the day's decisions with a safe default settled together; it replaces the completion check's per-block
 *   pushes for every block whose deadline is not tomorrow or sooner;
 * - **answering everything by its recommendation** (Superhuman's "Get Me To Zero"): one button for the kinds that have a safe, undoable
 *   default, never for drafts, targets, anything that leaves the machine, or a question only the person can answer.
 *
 * And one weekly risk card in place of a card per milestone: risks are said once a week, or sooner only when one turns high.
 *
 * Everything here is pure: the web gathers the inputs and carries the result out.
 */
import type { Ask, AskKind } from "./asks";
import { asPlannedOutcome } from "./measured-capacity";

const DAY = 86_400_000;
const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const between = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);

/** The Monday of the week `day` falls in (weeks run Monday to Sunday, as the review and the quota saver count them). */
export function weekStartOf(day: string): string {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return plusDays(day, -((weekday + 6) % 7));
}

/* ── the weekly commitment ── */

/** Demand more than this much over the week's usable minutes is an overload worth asking about again mid-week. */
export const OVERLOAD_RATIO = 1.15;
/** From this hour on a Sunday, the commitment asked about is next week's (the owner: 「周日晚上或周一第一段」). */
export const SUNDAY_EVENING = "17:00";
/** Work this many days overdue, never started and of ordinary weight is suggested for 砍 rather than rolled forward once more. */
export const DROP_OVERDUE_DAYS = 7;
/** A milestone weighed this much or more is important: its work is never suggested for 砍. */
const IMPORTANT = 60;

export type CommitGroup = "keep" | "defer" | "drop";
export const COMMIT_GROUPS: CommitGroup[] = ["keep", "defer", "drop"];
export const COMMIT_GROUP_LABEL: Record<CommitGroup, string> = { keep: "保", defer: "推", drop: "砍" };

export type CommitTask = {
  id: string;
  /** What is left of it, in the person's minutes (open steps at their usual estimate). */
  minutes: number;
  /** Its due day (its own, else its milestone's), when it has one. */
  dueDay?: string;
  /** The person already worked on it (a timer ran, a step is done). */
  started: boolean;
  /** The importance (0–100) of the milestone it serves. */
  weight: number;
};

export type CommitSuggestion = { group: CommitGroup; reason: "started" | "due" | "fits" | "over_capacity" | "stale" };

/**
 * The week the commitment is about: on a Sunday from `SUNDAY_EVENING` on, next week; otherwise this week. Returned as its Monday.
 */
export function commitWeekOf(today: string, clock: string): string {
  void clock;
  const monday = weekStartOf(today);
  // On a Sunday the week ahead (2026-10-30, docs/plans/closed-loop-1030.md §5): this week has only today left, and today's hours against
  // the whole week's work read as a week pushed out of all proportion. The question still waits for the evening (`weeklyCommitDue`).
  return new Date(`${today}T12:00:00Z`).getUTCDay() === 0 ? plusDays(monday, 7) : monday;
}

/** The order in which work earns the week's hours: started, then due this week (overdue first), then the heavier milestone, then the sooner day. */
function commitOrder(weekEnd: string, today: string) {
  const dueRank = (task: CommitTask) => !task.dueDay ? 2 : task.dueDay <= weekEnd ? 0 : 1;
  const overdue = (task: CommitTask) => task.dueDay && task.dueDay < today ? between(task.dueDay, today) : 0;
  return (a: CommitTask, b: CommitTask) => Number(b.started) - Number(a.started) || dueRank(a) - dueRank(b) || b.weight - a.weight
    || overdue(b) - overdue(a) || (a.dueDay ?? "9999").localeCompare(b.dueDay ?? "9999") || a.id.localeCompare(b.id);
}

/**
 * The suggested group of every task: 砍 for work overdue `DROP_OVERDUE_DAYS` or more that was never started and serves no important
 * milestone (rolling it forward again is how it got that old); the rest in `commitOrder`, kept while the week's minutes last and pushed
 * once they are spent — a smaller task further down still kept if it fits in what is left.
 */
export function proposeWeeklyCommit(input: { tasks: CommitTask[]; capacityMinutes: number; today: string; weekStart: string }):
  { groups: Record<string, CommitSuggestion>; keptMinutes: number } {
  const weekEnd = plusDays(input.weekStart, 6);
  const groups: Record<string, CommitSuggestion> = {};
  let kept = 0;
  for (const task of [...input.tasks].sort(commitOrder(weekEnd, input.today))) {
    const overdueDays = task.dueDay && task.dueDay < input.today ? between(task.dueDay, input.today) : 0;
    if (!task.started && overdueDays >= DROP_OVERDUE_DAYS && task.weight < IMPORTANT) { groups[task.id] = { group: "drop", reason: "stale" }; continue; }
    const minutes = Math.max(0, task.minutes);
    if (kept + minutes <= input.capacityMinutes) {
      kept += minutes;
      groups[task.id] = { group: "keep", reason: task.started ? "started" : task.dueDay && task.dueDay <= weekEnd ? "due" : "fits" };
    } else groups[task.id] = { group: "defer", reason: "over_capacity" };
  }
  return { groups, keptMinutes: kept };
}

/** Minutes of the tasks in one group, under the person's choices. */
export function groupMinutes(tasks: CommitTask[], groups: Record<string, CommitGroup>, group: CommitGroup): number {
  return tasks.filter((task) => (groups[task.id] ?? "keep") === group).reduce((sum, task) => sum + Math.max(0, task.minutes), 0);
}

/** Over by more than `OVERLOAD_RATIO`: the only mid-week reason to ask again. */
export const overloaded = (demandMinutes: number, capacityMinutes: number) => demandMinutes > Math.round(capacityMinutes * OVERLOAD_RATIO);

/**
 * Where a pushed task goes: not before the Monday after the committed week, and when its due day falls before that, due at the end of
 * that week instead (a due day before the day work may start would read as already late).
 */
export function deferTarget(task: Pick<CommitTask, "dueDay">, weekStart: string): { notBefore: string; dueDay?: string } {
  const next = plusDays(weekStart, 7);
  return task.dueDay && task.dueDay < next ? { notBefore: next, dueDay: plusDays(next, 6) } : { notBefore: next };
}

/** What the last commitment recorded (`schedule.weeklyCommit`, an undoable setting). */
export type WeeklyCommitRecord = { week: string; at: string; demandMinutes: number; capacityMinutes: number;
  /** The week a mid-week overload was asked about, so it is asked once. */
  overloadAskedFor?: string };
export const WEEKLY_COMMIT_SETTING = "schedule.weeklyCommit";

export function parseWeeklyCommit(raw: string | null | undefined): WeeklyCommitRecord | undefined {
  try {
    const value = JSON.parse(raw ?? "") as Partial<WeeklyCommitRecord>;
    return typeof value.week === "string" && typeof value.at === "string"
      ? { week: value.week, at: value.at, demandMinutes: Number(value.demandMinutes) || 0, capacityMinutes: Number(value.capacityMinutes) || 0,
        ...(typeof value.overloadAskedFor === "string" ? { overloadAskedFor: value.overloadAskedFor } : {}) } : undefined;
  } catch { return undefined; }
}

/**
 * Whether to ask for the commitment now, and why: `weekly` once per week, from Sunday evening (for the week ahead) to the end of Monday,
 * while the week is not committed; `overload` once in a committed week when its work has since grown past `OVERLOAD_RATIO` of its hours
 * and the commitment had left it within them. A week left uncommitted past Monday is not chased: `/commit` stays open by hand, and the
 * next Sunday asks again. Opened by hand, the page needs no reason.
 */
export function weeklyCommitDue(input: { today: string; clock: string; last: WeeklyCommitRecord | undefined; demandMinutes: number; capacityMinutes: number }):
  { week: string; reason: "weekly" | "overload" } | undefined {
  const week = commitWeekOf(input.today, input.clock);
  const sunday = new Date(`${input.today}T12:00:00Z`).getUTCDay() === 0;
  if (sunday && input.clock < SUNDAY_EVENING) return undefined;
  if (input.last?.week !== week) return week !== weekStartOf(input.today) || input.today === week ? { week, reason: "weekly" } : undefined;
  const wasOver = overloaded(input.last.demandMinutes, input.last.capacityMinutes);
  if (!wasOver && input.last.overloadAskedFor !== week && overloaded(input.demandMinutes, input.capacityMinutes)) return { week, reason: "overload" };
  return undefined;
}

/* ── the evening wrap-up ── */

type Window = { days: number[]; start: string; end: string };
/** The end of the person's last available hours on `weekday` (0 = Sunday), or undefined on a day with none. */
export function wrapTimeOf(windows: Window[], weekday: number, rest: ReadonlyArray<{ start: string; end: string }> = []): string | undefined {
  const end = windows.filter((window) => window.days.includes(weekday)).map((window) => window.end).sort().at(-1);
  if (!end) return end;
  // A rest event the person put at the end of the day (「今晚 9 点以后不排工作」, W-156) ends the working day where it begins.
  const cut = rest.filter((span) => span.start < end && span.end >= end).map((span) => span.start).sort()[0];
  return cut ?? end;
}
/**
 * The rows the wrap-up's one-tap 「按预估完成」 records, and how: not yet answered, and work went on inside the block — its timer ran, or
 * the passive signals saw work (`workMinutes`, docs/plans/closed-loop-1030.md §3). A block nobody touched keeps its own three-part control:
 * recording it done drops its work from the plan. One worked for under 70% of its planned minutes is recorded as 部分, not 完成, so the
 * step stays open and the rest is placed again (the month simulation's tired 「一键」 had marked 41 half-done blocks done).
 */
export function bulkDoneRows<T extends { blockId: string; timedMinutes: number; workMinutes?: number; start?: string; end?: string }>(rows: T[],
  answered: Record<string, unknown>): Array<T & { outcome: "done" | "partial" }> {
  const clock = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  return rows.filter((row) => !answered[row.blockId] && Math.max(row.timedMinutes, row.workMinutes ?? 0) > 0).map((row) => {
    const planned = row.start && row.end ? clock(row.end) - clock(row.start) : 0;
    return { ...row, outcome: asPlannedOutcome(Math.max(row.timedMinutes, row.workMinutes ?? 0), planned) };
  });
}
/** Quiet hours: nothing is pushed then; the morning brief says what was left. */
export const QUIET_FROM = "23:00";
export const QUIET_UNTIL = "08:00";

/* ── answering by the recommendation ── */

/**
 * The kinds of question one button may answer, and how: by its recommended option, or — for a cross-line relation's check, which has no
 * safe answer (each option states a fact about what was delivered) — by asking again next week. Everything else is left: milestone drafts
 * and targets are not asks; the interview, a step's questions, a waiting item, a capture, an exam's result and every question about a
 * fact only the person has are not here; nothing here sends, publishes or pays. A risk due within two days stays (`milestone_risk`):
 * accepting it unread would silence the one warning that still has time to matter.
 */
export const ANSWER_ALL_KINDS: Partial<Record<AskKind, "recommended" | "snooze">> = {
  risk_digest: "recommended", milestone_risk_review: "recommended", missed_block: "recommended", relation_check: "snooze"
};

export type AnswerAllStep = { askId: string; kind: AskKind; title: string } & ({ optionId: string } | { snooze: "week" });

/** One step per ask the button settles; asks it cannot settle safely are left as they are. */
export function answerAllSteps(asks: Ask[]): AnswerAllStep[] {
  return asks.flatMap((ask): AnswerAllStep[] => {
    const how = ANSWER_ALL_KINDS[ask.kind];
    if (!how || ask.select === "many") return [];
    if (how === "snooze") return [{ askId: ask.id, kind: ask.kind, title: ask.title, snooze: "week" }];
    const option = ask.options.find((item) => item.recommended);
    if (!option || option.href || option.needsNote || option.fields?.some((field) => field.required)) return [];
    return [{ askId: ask.id, kind: ask.kind, title: ask.title, optionId: option.id }];
  });
}

/** An assistant result that is safe to accept unread: its checks passed, it left the person's files alone and acted only on this machine. */
export const safeAssistantResult = (row: { checksPassed: boolean; inputsModified: string[]; external: boolean; partial: boolean }) =>
  row.checksPassed && row.inputsModified.length === 0 && !row.external && !row.partial;

/** A proposal nobody approved whose own due day has passed, or that has waited this many days: put away (recoverable). */
export const STALE_PROPOSAL_DAYS = 14;
export function staleProposal(input: { dueDay?: string; createdAt: string; today: string }): boolean {
  return Boolean(input.dueDay && input.dueDay < input.today) || between(input.createdAt.slice(0, 10), input.today) >= STALE_PROPOSAL_DAYS;
}

/* ── the weekly risk card ── */

export type RiskDigestMember = { id: string; level: "high" | "medium" };
/** What the person last looked at (`schedule.riskDigest`): the week, and each milestone's level then. */
export type RiskDigestSeen = { week: string; levels: Record<string, "high" | "medium"> };
export const RISK_DIGEST_SETTING = "schedule.riskDigest";

export function parseRiskDigestSeen(raw: string | null | undefined): RiskDigestSeen | undefined {
  try {
    const value = JSON.parse(raw ?? "") as Partial<RiskDigestSeen>;
    return typeof value.week === "string" && value.levels && typeof value.levels === "object" ? { week: value.week, levels: value.levels } : undefined;
  } catch { return undefined; }
}

/**
 * The weekly risk card shows once a week, and mid-week again only when a milestone's risk turned high that was not high when the person
 * last looked: a new medium risk waits for next week's card.
 */
export function riskDigestShows(members: RiskDigestMember[], seen: RiskDigestSeen | undefined, week: string): boolean {
  if (!members.length) return false;
  if (!seen || seen.week !== week) return true;
  return members.some((member) => member.level === "high" && seen.levels[member.id] !== "high");
}
