import "server-only";
import type { AccessContext } from "@crossline/core";
import { effectiveSchedulePreferences, loadCurrentPlan, toZonedInstant } from "./crossline";

export type PublishBlockInput = { id: string; title: string; start: string; end: string };

/**
 * The blocks the scheduler placed for work orders, as instants. Only these go to the Crossline calendar: real calendar events,
 * imported class meetings and everything else on the plan came from the person and are never written back anywhere.
 * Nothing is written until the plan version is approved (`write_focus_block` is a batch approval).
 */
export async function blocksToPublish(ctx: AccessContext, now = new Date()): Promise<{ approved: boolean; blocks: PublishBlockInput[] }> {
  const plan = await loadCurrentPlan(ctx);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const blocks = plan.blocks.flatMap((block) => {
    if (!block.id.startsWith("scheduled:") || !block.day) return [];
    // The demo work orders every new account is seeded with are there to show the flow, not to claim the person's time.
    if (block.id.split(":")[1]?.endsWith("-starter-work-order")) return [];
    try {
      const start = toZonedInstant(block.day, block.start, zone);
      const end = toZonedInstant(block.day, block.end === "24:00" ? "23:59" : block.end, zone);
      return Date.parse(end) > now.getTime() && Date.parse(end) > Date.parse(start) ? [{ id: block.id, title: block.title, start, end }] : [];
    } catch { return []; }
  });
  return { approved: plan.status === "approved", blocks };
}
