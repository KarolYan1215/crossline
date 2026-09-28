import type { AccessContext } from "@crossline/core";
import { loadTaskDetail, loadMilestoneDetail } from "../lib/task-detail";
import { TaskDetailView, MilestoneDetailView } from "./task-detail-view";
import { PreviewDrawer } from "./preview-drawer";

/** The corner "⊕" preview affordance every task card gets — self-contained so a card only needs an id to
 * grow one, without every list page having to assemble a `TaskDetail` itself. */
export function TaskPreview({ ctx, workOrderId }: { ctx: AccessContext; workOrderId: string }) {
  const detail = loadTaskDetail(ctx, workOrderId);
  if (!detail) return null;
  return <PreviewDrawer title={detail.intent} href={`/workbench/${encodeURIComponent(workOrderId)}`}>
    <TaskDetailView detail={detail} />
  </PreviewDrawer>;
}

export function MilestonePreview({ ctx, milestoneId }: { ctx: AccessContext; milestoneId: string }) {
  const detail = loadMilestoneDetail(ctx, milestoneId);
  if (!detail) return null;
  return <PreviewDrawer title={detail.title} href={`/milestones/${encodeURIComponent(milestoneId)}`}>
    <MilestoneDetailView detail={detail} />
  </PreviewDrawer>;
}
