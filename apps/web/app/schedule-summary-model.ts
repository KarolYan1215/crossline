import type { FinerSplitNote, ScheduleChange } from "../lib/crossline";
import { tFor, type Locale } from "../lib/i18n";

/**
 * How Today's change summary is folded before it is drawn. A task split into several blocks moved by one meeting came back as one line
 * per block, word for word the same with a 「钉回原位」 each; four tasks split finer were four lines (2026-10-21 walkthrough). Pure, so the
 * folding is tested without a page.
 */
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** 「后移 30 分钟」, 「提前 15 分钟」 or 「改到 10/14 09:00」, in the page's language. */
export function shiftText(change: ScheduleChange, locale?: Locale): string {
  const t = tFor(locale);
  if (change.to.day !== change.day) return t("改到 {{month}}/{{day}} {{time}}", { month: Number(change.to.day.slice(5, 7)), day: Number(change.to.day.slice(8, 10)), time: change.to.start });
  const delta = minutes(change.to.start) - minutes(change.from.start);
  return delta > 0 ? t("后移 {{minutes}} 分钟", { minutes: delta }) : t("提前 {{minutes}} 分钟", { minutes: -delta });
}

/** The blocks of one task moved by one cause the same way: one line, one 「钉回原位」 for all of them. */
export type ChangeGroup = { key: string; title: string; cause: string; shift: string; changes: ScheduleChange[] };

export function groupChanges(changes: ScheduleChange[], locale?: Locale): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const change of changes) {
    const shift = shiftText(change, locale);
    const key = `${change.title}\u0000${change.cause}\u0000${shift}`;
    const group = groups.get(key);
    if (group) { if (!group.changes.some((item) => item.blockId === change.blockId)) group.changes.push(change); }
    else groups.set(key, { key, title: change.title, cause: change.cause, shift, changes: [change] });
  }
  return [...groups.values()];
}

/** Steps split finer after the same number of days: one line naming them all. */
export type SplitGroup = { days: number; names: string[] };

export const splitName = (split: FinerSplitNote) => `${split.title}${split.step ? ` · ${split.step}` : ""}`;

export function groupSplits(splits: FinerSplitNote[]): SplitGroup[] {
  const groups = new Map<number, SplitGroup>();
  for (const split of splits) {
    const group = groups.get(split.days) ?? { days: split.days, names: [] };
    const name = splitName(split);
    if (!group.names.includes(name)) group.names.push(name);
    groups.set(split.days, group);
  }
  return [...groups.values()].sort((a, b) => b.days - a.days);
}
