import { notFound } from "next/navigation";
import { SubpageShell } from "../../subpage-shell";
import { loadTaskDetail } from "../../../lib/task-detail";
import { loadCurrentPlan, planToday } from "../../../lib/crossline";
import { nextSlots } from "../../../lib/steps";
import { requireSessionContext } from "../../../lib/access-guard";
import { gateUntilReady } from "../../../lib/start-gate";
import { TaskPanels } from "../../task/task-dialog";
import { BackLink } from "../../ui/back-link";

export const dynamic = "force-dynamic";

/**
 * A task's own page: the same panels the task dialog shows, as a bookmarkable address. 「开始计时」 lands here, so the steps, materials
 * and tutorial are in front of the person while the countdown runs. 「← 返回…」 goes back to the page it was opened from, as that page
 * was left; opened from a link with nothing before it, back to 任务. The head's 下一次时段 is read from the current schedule.
 */
export default async function WorkOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const { id } = await params;
  const detail = loadTaskDetail(ctx, id);
  if (!detail) notFound();
  const today = planToday(ctx);
  const slot = nextSlots((await loadCurrentPlan(ctx)).blocks, today).get(detail.id);
  return <SubpageShell active={"任务"} title={detail.title} back={<BackLink scope={`/workbench/${encodeURIComponent(detail.id)}`} fallback="/workbench" />}>
    <div className="task-page tk-page" data-line={detail.identityId}>
      <TaskPanels detail={detail} slot={slot} today={today} anchors />
    </div>
  </SubpageShell>;
}
