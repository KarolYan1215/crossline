import { dayLoad } from "../timeline/panel-model";
import { toMinutes, weekdayOf, weekDays, type TimelineDeadline, type TimelineItem } from "../timeline/model";

/** One day of the head band's week strip: how full its work is (0–1) and whether something is due on it. */
export type WeekDayLoad = { day: string; work: number; load: number; deadline: boolean };

/**
 * The week strip's load bars and deadline flags (scenarios.md §4.11), pure for its test. A day's load is its work (scheduled and
 * pencilled-in minutes) over the hours it has: the day less the unavailable stretches of its weekday and the fixed commitments. A day
 * with no hours and some work reads as full.
 */
export function weekLoad(items: TimelineItem[], deadlines: TimelineDeadline[], today: string,
  quietByWeekday: Record<number, Array<[string, string]>> = {}): WeekDayLoad[] {
  const due = new Set(deadlines.map((deadline) => deadline.day));
  return weekDays(today).map((day) => {
    const load = dayLoad(items, day);
    const work = load.planned + load.pencilled;
    const quiet = (quietByWeekday[weekdayOf(day)] ?? []).reduce((sum, [from, to]) => sum + Math.max(0, (toMinutes(to) || 24 * 60) - toMinutes(from)), 0);
    const hours = Math.max(0, 24 * 60 - quiet - load.fixed);
    return { day, work, load: hours > 0 ? Math.min(1, work / hours) : work > 0 ? 1 : 0, deadline: due.has(day) };
  });
}
