import type { CrosslineStore } from "@crossline/db";

/**
 * Approved milestones the worker has not yet worked backwards into tasks: no task serves them and no backplan was proposed, refused or
 * declined at their current version. While there are any, an empty 「下一步」 says the tasks are being made — it used to tell someone who
 * had just approved twelve milestones to 「收集一项工作」 for twenty minutes (2026-10-17 walkthrough, W-28). A passed deadline is not
 * counted, since the worker does not plan towards it.
 */
export function milestonesBeingBackplanned(store: CrosslineStore, workspaceId: string, today: string): number {
  const deadlines = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const served = new Set(store.listWorkOrders(workspaceId)
    .flatMap((order) => [order.milestoneId, ...((order.payload as { alsoServes?: string[] } | undefined)?.alsoServes ?? [])]));
  const tried = new Set(store.listEvents(workspaceId, { type: ["goal.backplan_proposed", "goal.backplan_blocked", "goal.backplan_declined"] })
    .map((event) => `${event.entityId}:${(event.payload as { milestoneVersion?: number }).milestoneVersion}`));
  return store.listMilestones(workspaceId).filter((milestone) => milestone.status === "approved" && milestone.projectId
    && !served.has(milestone.id) && !tried.has(`${milestone.id}:${milestone.version}`)
    && (!deadlines.get(milestone.id) || deadlines.get(milestone.id)! >= today)).length;
}
