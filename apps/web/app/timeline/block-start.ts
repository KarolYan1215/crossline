import { tFor, type Locale } from "../../lib/i18n";
import type { TimelineItem } from "./model";

/**
 * The one thing starting from a block adds to starting from a card: the block is locked where it is (docs/loop-and-scout.md §1),
 * so re-planning no longer moves what the person is doing; a pencilled-in block (预排) becomes formal at that time. Handed to
 * `TaskActions` as `beforeStart`; a message means the start stops.
 */
export async function lockOnStart(item: TimelineItem, locale?: Locale): Promise<string | null> {
  // A missed block's time is gone: starting it starts the work now, with nothing to lock.
  if ((item.kind !== "optional" && item.kind !== "scheduled") || item.missed) return null;
  const response = await fetch("/api/plan/pin", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ blockId: item.id, day: item.day, start: item.start, end: item.end, reason: "pinned" }) }).catch(() => null);
  return response?.ok ? null : tFor(locale)("未能锁定这段时间，请重试");
}
