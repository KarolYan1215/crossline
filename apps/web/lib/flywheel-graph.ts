import "server-only";
import type { AccessContext } from "@crossline/core";
import { getStore, milestonesRetiredBySystem } from "./crossline";
import { identityLines } from "./lines";
import type { FlywheelGraphData } from "../app/flywheel/graph-model";

const FINISHED = new Set(["accepted", "archived"]);

/**
 * What the flywheel graph on Today draws, read once: the person's lines (health is capacity, not a line, and is not among them) with
 * each one's first long-term goal and its unfinished tasks; every live milestone — approved or draft, never archived or replaced by the
 * system — with its unfinished tasks and the earlier milestones it depends on; and the approved and candidate relations between them.
 */
export function loadFlywheelGraph(ctx: AccessContext): FlywheelGraphData {
  const store = getStore();
  const lines = identityLines(ctx);
  const lineIds = new Set(lines.map((line) => line.id));
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => !order.tombstone && !FINISHED.has(order.state));
  const retired = milestonesRetiredBySystem(ctx);
  const milestones = store.listMilestones(ctx.workspaceId)
    .filter((milestone) => (milestone.status === "approved" || milestone.status === "draft") && !retired.has(milestone.id) && lineIds.has(milestone.identityId));
  const live = new Set(milestones.map((milestone) => milestone.id));
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.dependsOn]));
  const open = (predicate: (order: (typeof orders)[number]) => boolean) => orders.filter(predicate).length;
  return {
    lines: lines.map((line) => ({ id: line.id, label: line.label, goal: line.goals?.[0] ?? line.goal ?? "", openTasks: open((order) => order.identityId === line.id) })),
    milestones: milestones.map((milestone) => ({ id: milestone.id, line: milestone.identityId, title: milestone.title, status: milestone.status as "approved" | "draft",
      openTasks: open((order) => order.milestoneId === milestone.id), dependsOn: (anchors.get(milestone.id) ?? []).filter((id) => live.has(id)) })),
    relations: store.listMilestoneRelations(ctx.workspaceId)
      .filter((relation) => (relation.status === "approved" || relation.status === "candidate") && live.has(relation.fromMilestoneId) && live.has(relation.toMilestoneId))
      .map((relation) => ({ id: relation.id, from: relation.fromMilestoneId, to: relation.toMilestoneId, kind: relation.kind,
        status: relation.status as "approved" | "candidate", explanation: relation.explanation ?? "" }))
  };
}
