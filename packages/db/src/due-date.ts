import { goalSettingKey } from "@crossline/core";
import type { CrosslineStore, StoredWorkOrder } from "./index";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A task's deadline as its task page shows it: the earlier of its own due day and its milestone's — the goal's confirmed deadline, else
 * the milestone's anchor (the goal setting replaces the anchor's date, 2026-10-28). Days only (`YYYY-MM-DD`).
 *
 * One reading for every place that tells the person or a model when a task is due (W-277, 2026-11-17): the assistant's task list read
 * only `payload.dueDate`, which 22 of ~100 open tasks on the owner's ledger had, and answered 「本周截止的事」 with 「没有截止日期」
 * while the task page listed them.
 */
export function effectiveDueDate(own: string | undefined, goalDeadline: string | undefined, anchorDeadline: string | undefined): string | undefined {
  return [own, goalDeadline || anchorDeadline].filter((value): value is string => Boolean(value && YMD.test(value))).sort()[0];
}

/** `effectiveDueDate` for the orders of one workspace, reading each milestone's goal setting and anchor once. */
export function dueDateReader(store: CrosslineStore, workspaceId: string): (order: Pick<StoredWorkOrder, "milestoneId" | "payload">) => string | undefined {
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const goals = new Map<string, string | undefined>();
  const goalOf = (milestoneId: string) => {
    if (!goals.has(milestoneId)) {
      let deadline: string | undefined;
      try { deadline = (JSON.parse(store.getSetting(workspaceId, goalSettingKey(milestoneId)) ?? "{}") as { confirmedDeadline?: string }).confirmedDeadline; }
      catch { /* none */ }
      goals.set(milestoneId, deadline);
    }
    return goals.get(milestoneId);
  };
  return (order) => {
    const own = (order.payload as { dueDate?: unknown } | undefined)?.dueDate;
    const milestone = order.milestoneId;
    return effectiveDueDate(typeof own === "string" ? own : undefined, milestone ? goalOf(milestone) : undefined, milestone ? anchors.get(milestone) : undefined);
  };
}
