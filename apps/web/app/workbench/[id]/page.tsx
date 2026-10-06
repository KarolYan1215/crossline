import { notFound } from "next/navigation";
import { SubpageShell } from "../../subpage-shell";
import { TaskDetailView } from "../../task-detail-view";
import { loadTaskDetail } from "../../../lib/task-detail";
import { requireSessionContext } from "../../../lib/access-guard";
import { ManualbookView } from "../../manualbook-view";
import { AssistantSection } from "../../assistant-section";

export const dynamic = "force-dynamic";

/**
 * The standalone destination behind every task card's "⤢ 独立页面查看" — same `TaskDetailView` the
 * quick-preview drawer renders, just wrapped in the page chrome instead of a dialog, so it is a real,
 * bookmarkable, back-button-friendly URL rather than only ever existing inside a list.
 */
export default async function WorkOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSessionContext();
  const { id } = await params;
  const detail = loadTaskDetail(ctx, id);
  if (!detail) notFound();
  return <SubpageShell active="任务" eyebrow="WORKBENCH / TASK" title={detail.intent}
    description={`${detail.identityLabel}${detail.milestone ? ` · 所属里程碑：${detail.milestone.title}` : ""}`}>
    <AssistantSection ctx={ctx} workOrderId={detail.id} />
    <ManualbookView workOrderId={detail.id} building={detail.state === "preparing"} />
    <TaskDetailView detail={detail} />
  </SubpageShell>;
}
