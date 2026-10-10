/**
 * Whether the system is working, measured every day from the ledger — no long experiment, no control group.
 *
 * The four numbers are the ones the person chose as their own test of "effective": milestones met on time,
 * estimates that hold, time going where the priorities say, and how much the system itself costs to run. Beside
 * them are mechanism coverages: each is the share of work that gets the treatment a meta-analysis found to work —
 * a date-and-time plan (implementation intentions, d≈0.65; a dated *and* timed plan was what moved a field
 * experiment), recorded progress (progress monitoring, d≈0.40, stronger when recorded), and an answered
 * follow-up on what one waits for (external reminders improve whether intentions are carried out). These are
 * proximal measures: they say whether the person is getting the mechanism, not that the outcome followed.
 *
 * 跨线关系兑现率 is the flywheel's own test: each cross-line relation promised a measurable transfer by a check day, and the person said
 * on that day whether it was delivered. "The flywheel compounds" has no evidence at the personal level; this is where the app tests it.
 */
import { relationFulfilment, type RelationCheckOutcome } from "./artifact-plan";
export type EffectivenessInput = {
  today: string;
  /** Approved milestones with a deadline, and each criterion's best reading with the day it was first met. */
  milestones: Array<{ id: string; title: string; deadline: string; requiredCriteria: string[]; metOn: Record<string, string>;
    /** The 8-week forecast's p85 finish for it, when there is one. */ p85Finish?: string | null }>;
  /** Finished work with the analysis's estimate and what it really took. */
  durations: Array<{ llmP50: number; llmP85: number; calibratedP50: number; calibratedP85: number; actual: number }>;
  /** Worked minutes in the last 7 days by line, and the person's priority order of lines (first = highest). */
  minutesByLine: Record<string, number>;
  deadlineMinutes: number;
  totalMinutes: number;
  priorityOrder: string[];
  /** The system's own cost over the last 7 days. */
  decisions: { count: number; minutes: number };
  captureToScheduledMinutes: number[];
  pendingNow: number;
  /** Mechanism coverage inputs. */
  committedOrders: number; committedWithBlock: number;
  liveMilestones: number; milestonesWithProgressLast7d: number;
  waitingAnswered: number; waitingAnsweredOnTime: number;
  /** The person's answers to relation checks (兑现 / 部分 / 没有), with the artifact kind each was about. */
  relationChecks?: Array<{ outcome: RelationCheckOutcome; kind: string }>;
};

export type Effectiveness = {
  onTime: { due: number; met: number; rate: number | null; atRisk: string[] };
  estimates: { n: number; medianBiasRaw: number | null; maeRaw: number | null; maeCalibrated: number | null; coverageRaw: number | null; coverageCalibrated: number | null };
  priorities: { minutesByLine: Record<string, number>; deadlineShare: number | null; topLine: string | null; topLineShare: number | null };
  overhead: { decisionsPerDay: number; decisionMinutesPerDay: number; medianCaptureToScheduled: number | null; pendingNow: number };
  coverage: { datedAndTimed: number | null; progressRecorded: number | null; followUpsOnTime: number | null };
  relations: { checked: number; rate: number | null; byKind: Array<{ kind: string; checked: number; rate: number }> };
};

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const share = (part: number, whole: number) => whole > 0 ? Math.round((part / whole) * 100) / 100 : null;
const round = (value: number | null, digits = 2) => value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

export function computeEffectiveness(input: EffectivenessInput): Effectiveness {
  const due = input.milestones.filter((milestone) => milestone.deadline < input.today);
  const metOnTime = due.filter((milestone) => milestone.requiredCriteria.length > 0
    && milestone.requiredCriteria.every((id) => Boolean(milestone.metOn[id] && milestone.metOn[id]! <= milestone.deadline)));
  // Two days of slack is the margin the forecast itself asks for (`DEADLINE_MARGIN_DAYS`).
  const atRisk = input.milestones.filter((milestone) => milestone.deadline >= input.today && milestone.p85Finish
    && Date.parse(`${milestone.deadline}T00:00:00Z`) - Date.parse(`${milestone.p85Finish}T00:00:00Z`) < 2 * 86_400_000).map((milestone) => milestone.title);

  const logError = (estimate: number, actual: number) => Math.abs(Math.log(actual / estimate));
  const usable = input.durations.filter((item) => item.actual > 0 && item.llmP50 > 0 && item.calibratedP50 > 0);
  const totalLine = Object.values(input.minutesByLine).reduce((sum, value) => sum + value, 0);
  const topLine = input.priorityOrder[0] ?? null;

  return {
    onTime: { due: due.length, met: metOnTime.length, rate: share(metOnTime.length, due.length), atRisk },
    estimates: {
      n: usable.length,
      medianBiasRaw: round(median(usable.map((item) => item.actual / item.llmP50))),
      maeRaw: round(mean(usable.map((item) => logError(item.llmP50, item.actual)))),
      maeCalibrated: round(mean(usable.map((item) => logError(item.calibratedP50, item.actual)))),
      coverageRaw: share(usable.filter((item) => item.actual <= item.llmP85).length, usable.length),
      coverageCalibrated: share(usable.filter((item) => item.actual <= item.calibratedP85).length, usable.length)
    },
    priorities: { minutesByLine: input.minutesByLine, deadlineShare: share(input.deadlineMinutes, input.totalMinutes),
      topLine, topLineShare: topLine ? share(input.minutesByLine[topLine] ?? 0, totalLine) : null },
    overhead: { decisionsPerDay: round(input.decisions.count / 7, 1)!, decisionMinutesPerDay: round(input.decisions.minutes / 7, 1)!,
      medianCaptureToScheduled: median(input.captureToScheduledMinutes), pendingNow: input.pendingNow },
    coverage: { datedAndTimed: share(input.committedWithBlock, input.committedOrders),
      progressRecorded: share(input.milestonesWithProgressLast7d, input.liveMilestones),
      followUpsOnTime: share(input.waitingAnsweredOnTime, input.waitingAnswered) },
    relations: (({ checked, rate, byKind }) => ({ checked, rate, byKind }))(relationFulfilment(input.relationChecks ?? []))
  };
}
