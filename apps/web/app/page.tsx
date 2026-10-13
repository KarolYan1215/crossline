import { redirect } from "next/navigation";
import { DashboardView } from "./dashboard-view";
import { appNow, loadDashboard, planToday, readChangeSummary } from "../lib/crossline";
import { requireSessionContext } from "../lib/access-guard";
import { gateUntilReady } from "../lib/start-gate";
import { returnDue } from "../lib/return";
import { currentWorkState, loadTimeline } from "../lib/timeline";
import { loadCurrentPlan } from "../lib/crossline";
import { loadTaskDetailsBatch, loadMilestoneDetailsBatch } from "../lib/task-detail";
import { loadAsks } from "../lib/asks";
import { nextSlots } from "../lib/steps";
import { loadFlywheelGraph } from "../lib/flywheel-graph";
import { shiftDay } from "./timeline/model";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  // Back after days away: what happened and the work that was due come first (docs/review-2026-10-13.md §6.3).
  if (returnDue(ctx, appNow())) redirect("/return");
  const data = await loadDashboard(ctx);
  // One batched read behind every card on this page — kept out of `loadDashboard` itself (which lives in `lib/crossline.ts`) to avoid
  // a circular import with `lib/task-detail.ts`, which already imports from `lib/crossline.ts`.
  const taskWorkOrderIds = [
    ...[data.primary, data.higherPriority, data.lowEnergy, data.shortGap].flatMap((action) => action ? [action.id] : []),
    ...data.upcoming.filter((item) => item.identityId !== "unclassified").map((item) => item.id)
  ];
  const milestoneIds = data.milestonePulse.map((item) => item.id);
  const plan = await loadCurrentPlan(ctx);
  const workState = currentWorkState(ctx, plan);
  const calendar = await loadTimeline(ctx, plan);
  // The day panel beside the timeline shows the task behind a picked block: the coming week's tasks are read here in the same batch,
  // so picking a block costs no request; a block further out is read when it is picked.
  const weekEnd = shiftDay(calendar.today, 7);
  const calendarOrderIds = [...new Set(calendar.items.filter((item) => item.workOrderId && item.day >= calendar.today && item.day < weekEnd)
    .map((item) => item.workOrderId!))];
  const details = loadTaskDetailsBatch(ctx, [...new Set([...taskWorkOrderIds, ...calendarOrderIds])]);
  return <DashboardView data={{
    ...data,
    taskDetailById: details,
    calendarDetails: Object.fromEntries(calendarOrderIds.flatMap((id) => details.has(id) ? [[id, details.get(id)!]] : [])),
    milestoneDetailById: loadMilestoneDetailsBatch(ctx, milestoneIds),
    slotById: nextSlots(plan.blocks, planToday(ctx)),
    // Kept out of `loadDashboard` for the same reason: `lib/asks.ts` imports from `lib/crossline.ts`.
    asks: await loadAsks(ctx),
    calendar,
    scheduleChanges: readChangeSummary(ctx),
    flywheelGraph: loadFlywheelGraph(ctx),
    ...(workState ? { workState } : {})
  }} />;
}
