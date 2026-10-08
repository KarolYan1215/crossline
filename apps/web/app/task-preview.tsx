import type { AccessContext } from "@crossline/core";
import { loadMilestoneDetail, type MilestoneDetail } from "../lib/task-detail";
import { MilestoneDetailView } from "./task-detail-view";
import { PreviewDrawer } from "./preview-drawer";

/** The corner "⊕" preview of a milestone: `{detail}` when the page batched it (`loadMilestoneDetailsBatch`), else `{ctx, milestoneId}`. */
export function MilestonePreview(props: { ctx: AccessContext; milestoneId: string } | { detail: MilestoneDetail | undefined }) {
  const detail = "detail" in props ? props.detail : loadMilestoneDetail(props.ctx, props.milestoneId);
  if (!detail) return null;
  return <PreviewDrawer title={detail.title} href={`/milestones/${encodeURIComponent(detail.id)}`}>
    <MilestoneDetailView detail={detail} />
  </PreviewDrawer>;
}
