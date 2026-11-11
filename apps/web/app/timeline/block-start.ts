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

/** A block a double-click starts: a work block of a task (planned or pencilled in), never a fixed event or a waiting proposal's preview. */
export function startableBlock(item: TimelineItem): boolean {
  return (item.kind === "scheduled" || item.kind === "optional") && Boolean(item.workOrderId);
}

/**
 * Double-clicking a work block starts it (the person's decision of 2026-11-11, W-258): the block is locked as 开始计时 does, the session
 * times the block's own step, and the workbench opens. A message means it did not start.
 */
export async function startFromBlock(item: TimelineItem, locale?: Locale): Promise<string | null> {
  if (!startableBlock(item)) return null;
  const refused = await lockOnStart(item, locale);
  if (refused) return refused;
  const id = encodeURIComponent(item.workOrderId!);
  const response = await fetch(`/api/work-orders/${id}/execution`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "start", ...(item.stepId ? { stepId: item.stepId } : {}) }) }).catch(() => null);
  if (!response?.ok) {
    const code = (await response?.json().catch(() => null) as { code?: string } | null)?.code;
    return tFor(locale)(code === "MATERIALS_PREPARING" ? "材料还在准备，好了再开始" : "未能开始计时，请在右侧点「开始」再试");
  }
  location.href = `/workbench/${id}`;
  return null;
}
