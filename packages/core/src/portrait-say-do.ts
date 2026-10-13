import type { SayDoId } from "./portrait";

/**
 * The "does" side of the portrait's say–do comparison (decided 2026-10-12), computed from the ledger rather than written by the model.
 * Pure: `sayDoFor` in `@crossline/db` gathers the counts. Each dimension is a ratio out of 100; one with nothing counted is null and
 * drawn as "暂无记录". Below 14 days or 10 executions the readings are too thin to draw, and the page says so in words instead.
 */
export const SAY_DO_MIN_DAYS = 14;
export const SAY_DO_MIN_EXECUTIONS = 10;

export type SayDoInput = {
  now: Date;
  firstExecutionAt: string | null;
  executions: number;
  plannedMinutes: number; workedMinutes: number;
  stepsDue: number; stepsOnTime: number;
  started: number; finished: number;
  submitted: number; passed: number;
  waitingAnswered: number; waitingOnTime: number;
};
export type SayDoReading = { sufficient: boolean; days: number; executions: number; does: Record<SayDoId, number | null> };

const ratio = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : null);

export function sayDoReadings(input: SayDoInput): SayDoReading {
  const days = input.firstExecutionAt ? Math.max(0, Math.floor((input.now.getTime() - Date.parse(input.firstExecutionAt)) / 86_400_000)) : 0;
  const does: Record<SayDoId, number | null> = {
    plan: ratio(input.workedMinutes, input.plannedMinutes),
    on_time: ratio(input.stepsOnTime, input.stepsDue),
    follow_through: ratio(input.finished, input.started),
    acceptance: ratio(input.passed, input.submitted),
    waiting: ratio(input.waitingOnTime, input.waitingAnswered)
  };
  return { sufficient: input.firstExecutionAt !== null && days >= SAY_DO_MIN_DAYS && input.executions >= SAY_DO_MIN_EXECUTIONS, days, executions: input.executions, does };
}

/** A waiting item is answered on time when the answer came within two days of its follow-up day (the 系统体检 rule). */
export function answeredOnTime(item: { updatedAt: string; followUpAt: string }): boolean {
  return Date.parse(item.updatedAt) <= Date.parse(`${item.followUpAt}T00:00:00Z`) + 2 * 86_400_000;
}
