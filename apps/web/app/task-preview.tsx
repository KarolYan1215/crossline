import type { AccessContext } from "@crossline/core";
import { loadTaskDetail, loadMilestoneDetail, type TaskDetail, type MilestoneDetail } from "../lib/task-detail";
import { TaskDetailView, MilestoneDetailView } from "./task-detail-view";
import { PreviewDrawer } from "./preview-drawer";

/** The corner "⊕" preview affordance every task card gets. Two ways to reach it: pass `{ctx,
 * workOrderId}` for a one-off preview (fetches its own detail via the single-id tier), or pass
 * `{detail}` when the page already precomputed it via `loadTaskDetailsBatch` — a list page rendering
 * many cards should always do the latter, or each preview redundantly re-reads the whole workspace. */
export function TaskPreview(props: { ctx: AccessContext; workOrderId: string } | { detail: TaskDetail | undefined }) {
  const detail = "detail" in props ? props.detail : loadTaskDetail(props.ctx, props.workOrderId);
  if (!detail) return null;
  return <PreviewDrawer title={detail.intent} href={`/workbench/${encodeURIComponent(detail.id)}`}>
    <TaskDetailView detail={detail} />
  </PreviewDrawer>;
}

export function MilestonePreview(props: { ctx: AccessContext; milestoneId: string } | { detail: MilestoneDetail | undefined }) {
  const detail = "detail" in props ? props.detail : loadMilestoneDetail(props.ctx, props.milestoneId);
  if (!detail) return null;
  return <PreviewDrawer title={detail.title} href={`/milestones/${encodeURIComponent(detail.id)}`}>
    <MilestoneDetailView detail={detail} />
  </PreviewDrawer>;
}
