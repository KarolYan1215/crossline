import { redirect } from "next/navigation";
import { DashboardView } from "./dashboard-view";
import { loadDashboard, needsOnboarding, planToday } from "../lib/crossline";
import { requireSessionContext } from "../lib/access-guard";
import { currentWorkState, loadTimeline } from "../lib/timeline";
import { loadCurrentPlan } from "../lib/crossline";
import { loadTaskDetailsBatch, loadMilestoneDetailsBatch } from "../lib/task-detail";
import { loadAsks } from "../lib/asks";
import { nextSlots } from "../lib/steps";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ctx = await requireSessionContext();
  if (needsOnboarding(ctx)) redirect("/onboarding");
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
  return <DashboardView data={{
    ...data,
    taskDetailById: loadTaskDetailsBatch(ctx, taskWorkOrderIds),
    milestoneDetailById: loadMilestoneDetailsBatch(ctx, milestoneIds),
    slotById: nextSlots(plan.blocks, planToday(ctx)),
    // Kept out of `loadDashboard` for the same reason: `lib/asks.ts` imports from `lib/crossline.ts`.
    asks: await loadAsks(ctx),
    calendar: await loadTimeline(ctx, plan),
    ...(workState ? { workState } : {})
  }} />;
}
