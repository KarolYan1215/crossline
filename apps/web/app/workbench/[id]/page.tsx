import { notFound } from "next/navigation";
import { SubpageShell } from "../../subpage-shell";
import { loadTaskDetail } from "../../../lib/task-detail";
import { requireSessionContext } from "../../../lib/access-guard";
import { gateUntilReady } from "../../../lib/start-gate";
import { TaskPanels } from "../../task/task-dialog";
import { TaskActions } from "../../task/task-actions";

export const dynamic = "force-dynamic";

/**
 * A task's own page: the same panels the task dialog shows, as a bookmarkable address. 「开始计时」 lands here, so the steps, materials
 * and tutorial are in front of the person while the countdown runs.
 */
export default async function WorkOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const { id } = await params;
  const detail = loadTaskDetail(ctx, id);
  if (!detail) notFound();
  return <SubpageShell active="任务" title={detail.intent}>
    <div className="task-page" data-line={detail.identityId}>
      <TaskActions workOrderId={detail.id} state={detail.state} paused={detail.paused} agentReady={detail.agentSteps.length > 0} agentStepId={detail.agentSteps[0]?.id}
        offline={{ ownerId: detail.viewerId, workspaceId: detail.workspaceId, intent: detail.intent }} />
      <TaskPanels detail={detail} />
    </div>
  </SubpageShell>;
}
