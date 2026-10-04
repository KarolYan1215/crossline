import { redirect } from "next/navigation";
import { DashboardView } from "./dashboard-view";
import { loadDashboard, needsOnboarding } from "../lib/crossline";
import { requireSessionContext } from "../lib/access-guard";
import { currentWorkState, loadTimeline } from "../lib/timeline";
import { loadCurrentPlan } from "../lib/crossline";
import { loadTaskDetailsBatch, loadMilestoneDetailsBatch } from "../lib/task-detail";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ctx = await requireSessionContext();
  if (needsOnboarding(ctx)) redirect("/onboarding");
  const data = await loadDashboard(ctx);
  // One batched read behind every preview drawer on this page instead of each `TaskPreview`/
  // `MilestonePreview` re-reading the whole workspace — kept out of `loadDashboard` itself (which lives
  // in `lib/crossline.ts`) to avoid a circular import with `lib/task-detail.ts`, which already imports
  // from `lib/crossline.ts`.
  const taskWorkOrderIds = [
    ...[data.primary, data.higherPriority, data.lowEnergy, data.shortGap].flatMap((action) => action ? [action.id] : []),
    ...data.upcoming.filter((item) => item.identityId !== "unclassified").map((item) => item.id)
  ];
  const milestoneIds = data.milestonePulse.map((item) => item.id);
  return <DashboardView data={{
    ...data,
    taskDetailById: loadTaskDetailsBatch(ctx, taskWorkOrderIds),
    milestoneDetailById: loadMilestoneDetailsBatch(ctx, milestoneIds),
    ...await (async () => {
      const plan = await loadCurrentPlan(ctx);
      const workState = currentWorkState(ctx, plan);
      return { calendar: await loadTimeline(ctx, plan), ...(workState ? { workState } : {}) };
    })()
  }} />;
}

