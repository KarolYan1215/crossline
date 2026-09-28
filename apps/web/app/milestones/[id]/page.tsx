import { notFound } from "next/navigation";
import { SubpageShell } from "../../subpage-shell";
import { MilestoneDetailView } from "../../task-detail-view";
import { loadMilestoneDetail } from "../../../lib/task-detail";
import { requireSessionContext } from "../../../lib/access-guard";

export const dynamic = "force-dynamic";

export default async function MilestoneDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSessionContext();
  const { id } = await params;
  const detail = loadMilestoneDetail(ctx, id);
  if (!detail) notFound();
  return <SubpageShell eyebrow="MILESTONES / DETAIL" title={detail.title}
    description={`${detail.identityLabel} · ${detail.relatedWorkOrders.length} 个相关任务`}>
    <MilestoneDetailView detail={detail} />
  </SubpageShell>;
}
