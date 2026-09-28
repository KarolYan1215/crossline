import { DashboardView } from "./dashboard-view";
import { loadDashboard } from "../lib/crossline";
import { requireSessionContext } from "../lib/access-guard";
import { loadTaskDetailsBatch, loadMilestoneDetailsBatch } from "../lib/task-detail";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ctx = await requireSessionContext();
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
    milestoneDetailById: loadMilestoneDetailsBatch(ctx, milestoneIds)
  }} />;
}

