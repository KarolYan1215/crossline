import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AvailabilityWindow } from "@crossline/core";
import type { ScheduleParams } from "@crossline/planner";

/**
 * What a preview changes without writing anything: a task's (or one step's, keyed `<order>#<step>`) usual minutes and a task's due
 * date. Read by `plannerTaskOf` and `plannerItemsFor` inside `withPreview`, so the schedule and the forecast are recomputed with the
 * change and compared with the real ones (`lib/impact.ts`). Async-local, so a preview never leaks into another request.
 */
export type PreviewOverrides = { estimates?: Record<string, number>; dueDates?: Record<string, string>; notBefore?: Record<string, string>;
  /** The plan page's own controls: a repainted week, other packing numbers, a moved importance slider (by milestone id). */
  availability?: AvailabilityWindow[]; params?: ScheduleParams; weights?: Record<string, number>; lineShares?: Record<string, number>;
  /** The energy of the slot the person is in, as if they had just said it (the energy question's value-of-information gate). */
  currentEnergy?: "low" | "medium" | "high";
  /** A held block as if moved to this time on the day panel (`move_block`), in the person's zone. */
  lock?: { blockId: string; day: string; start: string; end: string } };
export const previewScope = new AsyncLocalStorage<PreviewOverrides>();
export const withPreview = <T>(overrides: PreviewOverrides, run: () => T): T => previewScope.run(overrides, run);
/** Inside an impact preview nothing is written, a change summary included. */
export const inPreview = () => previewScope.getStore() !== undefined;
