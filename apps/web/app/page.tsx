import { redirect } from "next/navigation";
import { DashboardView } from "./dashboard-view";
import { appNow, loadDashboard, planToday, readChangeSummary, readFinerSplits } from "../lib/crossline";
import { requireSessionContext } from "../lib/access-guard";
import { gateUntilReady } from "../lib/start-gate";
import { returnDue } from "../lib/return";
import { currentWorkState, loadTimeline } from "../lib/timeline";
import { loadCurrentPlan } from "../lib/crossline";
import { cardView, loadTaskDetailsBatch, loadMilestoneDetailsBatch } from "../lib/task-detail";
import { loadAsks } from "../lib/asks";
import { loadReminders } from "../lib/reminders";
import { loadAskPreviews } from "./asks/previews";
import { nextSlots } from "../lib/steps";
import { loadFlywheelGraph } from "../lib/flywheel-graph";
import { shiftDay } from "./timeline/model";
import { timed, timedSync } from "../lib/sections";
import { localeFor } from "../lib/locale";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  // Back after days away: what happened and the work that was due come first (docs/review-2026-10-13.md §6.3).
  if (timedSync("today.returnDue", () => returnDue(ctx, appNow()))) redirect("/return");
  const data = await timed("today.dashboard", () => loadDashboard(ctx));
  // One batched read behind every card on this page — kept out of `loadDashboard` itself (which lives in `lib/crossline.ts`) to avoid
  // a circular import with `lib/task-detail.ts`, which already imports from `lib/crossline.ts`.
  const taskWorkOrderIds = [
    ...[data.primary, data.higherPriority, data.lowEnergy, data.shortGap].flatMap((action) => action ? [action.id] : []),
    ...data.upcoming.filter((item) => item.identityId !== "unclassified").map((item) => item.id)
  ];
  const milestoneIds = data.milestonePulse.map((item) => item.id);
  const plan = await timed("plan.current", () => loadCurrentPlan(ctx));
  const workState = currentWorkState(ctx, plan);
  const calendar = await timed("today.timeline", () => loadTimeline(ctx, plan));
  // The day panel beside the timeline shows the task behind a picked block: the coming week's tasks are read here in the same batch,
  // so picking a block costs no request; a block further out is read when it is picked.
  const weekEnd = shiftDay(calendar.today, 7);
  const calendarOrderIds = [...new Set(calendar.items.filter((item) => item.workOrderId && item.day >= calendar.today && item.day < weekEnd)
    .map((item) => item.workOrderId!))];
  // The cards' and the panel's copy (`cardView`); a task dialog opened from either reads the whole detail.
  const details = new Map([...await timed("today.details", () => loadTaskDetailsBatch(ctx, [...new Set([...taskWorkOrderIds, ...calendarOrderIds])]))]
    .map(([id, detail]) => [id, cardView(detail, { panel: true })] as const));
  // Kept out of `loadDashboard` for the same reason: `lib/asks.ts` imports from `lib/crossline.ts`.
  const asks = await timed("asks", () => loadAsks(ctx));
  return <DashboardView data={{
    ...data,
    locale: localeFor(ctx),
    taskDetailById: details,
    calendarDetails: Object.fromEntries(calendarOrderIds.flatMap((id) => details.has(id) ? [[id, details.get(id)!]] : [])),
    milestoneDetailById: timedSync("today.milestoneDetails", () => loadMilestoneDetailsBatch(ctx, milestoneIds)),
    slotById: nextSlots(plan.blocks, planToday(ctx)),
    asks,
    askPreviews: timedSync("today.askPreviews", () => loadAskPreviews(ctx, asks)),
    reminders: timedSync("today.reminders", () => { try { return loadReminders(ctx, plan, calendar.items, asks); } catch { return []; } }),
    calendar,
    scheduleChanges: timedSync("today.changes", () => readChangeSummary(ctx)),
    finerSplits: readFinerSplits(ctx),
    flywheelGraph: timedSync("today.flywheel", () => loadFlywheelGraph(ctx)),
    ...(workState ? { workState } : {})
  }} />;
}
