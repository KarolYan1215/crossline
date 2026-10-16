import { notFound } from "next/navigation";
import { SubpageShell } from "../../subpage-shell";
import { MilestoneDetailView } from "../../task-detail-view";
import { loadMilestoneDetail } from "../../../lib/task-detail";
import { requireSessionContext } from "../../../lib/access-guard";
import { gateUntilReady } from "../../../lib/start-gate";
import { tOf } from "../../../lib/locale";

export const dynamic = "force-dynamic";

export default async function MilestoneDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const { id } = await params;
  const detail = loadMilestoneDetail(ctx, id);
  if (!detail) notFound();
  return <SubpageShell active={"主线"} eyebrow="MILESTONES / DETAIL" title={detail.title}
    description={`${detail.identityLabel} · ${tOf(ctx)("{{count}} 个相关任务", { count: detail.relatedWorkOrders.length })}`}>
    <MilestoneDetailView detail={detail} />
  </SubpageShell>;
}
