import type { Locale } from "../../lib/i18n";
import { hoursText } from "./format";
import { toMinutes, type TimelineItem } from "./model";

/**
 * What the day panel beside the timeline shows, as pure functions over the timeline's items: the day's load, the next block to start,
 * and — for a block the person picked — the task's next block after it. No React and no clock: the panel passes in the day and minute.
 */
const length = (item: TimelineItem) => Math.max(0, toMinutes(item.end) - toMinutes(item.start));
const isWork = (item: TimelineItem) => (item.kind === "scheduled" || item.kind === "optional") && Boolean(item.workOrderId);

/** A fixed item of twenty hours or more marks the day (a rest day, a trip), it does not fill it. */
const ALL_DAY_MINUTES = 20 * 60;

/**
 * Minutes of the day by standing: scheduled work, pencilled-in work (outside the person's hours), and fixed commitments — overlapping ones
 * counted once. An all-day item is named in `allDay` instead of counted: a 00:00–23:59 「周日休息」 read as 「固定日程 24 小时」 (W-25).
 */
export function dayLoad(items: TimelineItem[], day: string): { planned: number; pencilled: number; fixed: number; allDay: string[] } {
  const ofDay = items.filter((item) => item.day === day);
  const sum = (kinds: Array<TimelineItem["kind"]>) => ofDay.filter((item) => kinds.includes(item.kind)).reduce((total, item) => total + length(item), 0);
  const fixedItems = ofDay.filter((item) => item.kind === "calendar" || item.kind === "import");
  const allDay = fixedItems.filter((item) => length(item) >= ALL_DAY_MINUTES);
  const spans = fixedItems.filter((item) => length(item) < ALL_DAY_MINUTES).map((item) => [toMinutes(item.start), toMinutes(item.end)] as const)
    .filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
  let fixed = 0, reach = -1;
  for (const [from, to] of spans) {
    if (to <= reach) continue;
    fixed += to - Math.max(from, reach);
    reach = to;
  }
  return { planned: sum(["scheduled"]), pencilled: sum(["optional"]), fixed, allDay: [...new Set(allDay.map((item) => item.title))] };
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

/** 「1.5 小时」 / "1.5 h". */
export const hoursLabel = (minutes: number, locale?: Locale) => hoursText(locale, minutes);
