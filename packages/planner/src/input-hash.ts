import { createHash } from "node:crypto";
import type { PlanningInput } from "./index";

/** Keys sorted at every level, dates as ISO strings, so the same input always serialises the same way. */
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, stable(item)]));
  return value;
}

/**
 * The key the background optimal plan is cached under (docs/loop-and-scout.md §2). Everything the planner reads is in `input` —
 * tasks with their steps, estimates, deadlines, energy and dependencies; the slots with their predicted energy (a sleep update changes
 * it); hard constraints, already taken out of the slots; frozen blocks; the packing numbers; line shares — except `now`, which moves
 * every second. `epoch` stands in for it: the caller passes the start of the slot it is in plus the self-reported energy, so the plan
 * is solved again when time crosses into another slot, not on every page load.
 */
export function scheduleInputHash(input: PlanningInput, epoch: string): string {
  const { now: _now, ...rest } = input;
  return createHash("sha256").update(JSON.stringify(stable({ ...rest, epoch }))).digest("hex");
}
