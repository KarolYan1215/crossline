import type { Locale } from "../../lib/i18n";
import { hoursText } from "./format";
import { toMinutes, type TimelineItem } from "./model";

/**
 * What the day panel beside the timeline shows, as pure functions over the timeline's items: the day's load, the next block to start,
 * and — for a block the person picked — the task's next block after it. No React and no clock: the panel passes in the day and minute.
 */
const length = (item: TimelineItem) => Math.max(0, toMinutes(item.end) - toMinutes(item.start));
const isWork = (item: TimelineItem) => (item.kind === "scheduled" || item.kind === "optional") && Boolean(item.workOrderId);

/** Minutes of the day by standing: scheduled work, pencilled-in work (outside the person's hours), and fixed commitments. */
export function dayLoad(items: TimelineItem[], day: string): { planned: number; pencilled: number; fixed: number } {
  const ofDay = items.filter((item) => item.day === day);
  const sum = (kinds: Array<TimelineItem["kind"]>) => ofDay.filter((item) => kinds.includes(item.kind)).reduce((total, item) => total + length(item), 0);
  return { planned: sum(["scheduled"]), pencilled: sum(["optional"]), fixed: sum(["calendar", "import"]) };
}

/** The first block of work on the day that has not ended yet (on today, after `nowMinute`; on another day, the first of the day). */
export function nextBlock(items: TimelineItem[], day: string, today: string, nowMinute: number | undefined): TimelineItem | undefined {
  const after = day === today ? nowMinute ?? 0 : 0;
  return items.filter((item) => item.day === day && isWork(item) && toMinutes(item.end) > after)
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))[0];
}

/** The same task's next block after this one, on any later day of the loaded calendar. */
export function followingBlock(items: TimelineItem[], of: TimelineItem): TimelineItem | undefined {
  if (!of.workOrderId) return undefined;
  const key = (item: TimelineItem) => `${item.day} ${item.start}`;
  return items.filter((item) => item.id !== of.id && item.workOrderId === of.workOrderId && isWork(item) && key(item) >= `${of.day} ${of.end}`)
    .sort((a, b) => key(a).localeCompare(key(b)))[0];
}

/** Whether a block is for work the system could do: its own step, or — for a whole-task block — the first step the system can do. */
export function agentStepFor(item: TimelineItem, steps: Array<{ id: string; status: string; schedulable: boolean; executor: string }>): string | undefined {
  const open = steps.filter((step) => step.status === "planned" && step.executor !== "human");
  if (item.stepId) return open.find((step) => step.id === item.stepId)?.id;
  return open.find((step) => step.schedulable)?.id;
}

/** The step a block is for, or the task's current one for a whole-task block. */
export function stepOfBlock<T extends { id: string; status: string; schedulable: boolean }>(item: TimelineItem, steps: T[]): T | undefined {
  return (item.stepId ? steps.find((step) => step.id === item.stepId) : undefined) ?? steps.find((step) => step.status === "planned" && step.schedulable);
}

/** Open schedulable steps other than this one: when there are any, finishing the block is not finishing the task. */
export function otherOpenSteps(stepId: string | undefined, steps: Array<{ id: string; status: string; schedulable: boolean }>): number {
  return steps.filter((step) => step.status === "planned" && step.schedulable && step.id !== stepId).length;
}

/** 「1.5 小时」 / "1.5 h". */
export const hoursLabel = (minutes: number, locale?: Locale) => hoursText(locale, minutes);
