import type { TimelineItem } from "./model";

/**
 * The one thing starting from a block adds to starting from a card: a pencilled-in block (预排, outside the person's hours) becomes
 * formal at the time it shows, so the plan keeps it there. Handed to `TaskActions` as `beforeStart`; a message means the start stops.
 */
export async function pinIfPencilled(item: TimelineItem): Promise<string | null> {
  if (item.kind !== "optional") return null;
  const response = await fetch("/api/plan/pin", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ blockId: item.id, day: item.day, start: item.start, end: item.end }) }).catch(() => null);
  return response?.ok ? null : "未能转为正式排程，请重试";
}
