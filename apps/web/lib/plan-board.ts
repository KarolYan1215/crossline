import "server-only";
import { statedWeeklyHours, weeklyAvailableHours, type AccessContext, type AvailabilityWindow, type ImportancePreset } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { DEADLINE_MARGIN_DAYS, PARAMS_ASAP, PARAMS_BUFFERED, type ScheduleParams } from "@crossline/planner";
import { effectiveParams, effectiveSchedulePreferences, effectiveWeight, getStore, IMPORTANT_WEIGHT, importancePresets, loadGoalForecast, planRanking, planToday,
  readAvailability, readGoalSettings, readSchedulePreferences, type PersistedPlan, type RankedTask } from "./crossline";
import { suggestedAvailabilityFor } from "./timeline";

/**
 * Everything below the calendar on the plan page, read once: the week's capacity against what the person said and what is open, the
 * eight-week forecast, the scheduler's own ordering, and the three things the person sets (when they are free, how a day is packed,
 * how much each milestone matters) with the system's suggestion beside each.
 */
export type PlanBoard = {
  today: string; timeZone: string; labels: Record<string, string>;
  capacity: { statedWeekly: number | null; configuredWeekly: number; plannedThisWeek: number; openP50: number; openP85: number; usingDefault: boolean };
  weeks: Array<{ week: number; start: string; netMinutes: number; usableMinutes: number }>;
  goals: Array<{ id: string; title: string; line: string; p50Day: string | null; p85Day: string | null; deadline: string | null;
    slackDays: number | null; atRisk: boolean; bottleneck: string | null; p50Minutes: number; p85Minutes: number;
    /** Not forecast at all: ordinary importance and no deadline (the forecast only follows what is important or dated). */
    unforecast: boolean }>;
  inferredRegularBlocks: number;
  ranking: RankedTask[];
  params: ScheduleParams; presets: { buffered: ScheduleParams; asap: ScheduleParams };
  importance: Array<{ id: string; title: string; line: string; weight: number; custom: boolean; preset: ImportancePreset }>;
  week: { windows: AvailabilityWindow[]; suggested: AvailabilityWindow[];
    /** Calendar commitments over the next two weeks, per weekday (0 = Sunday) and half hour: how many of those fall in it. */
    busy: number[][] };
};

const minutesOf = (clock: string) => { const [h, m] = clock.split(":").map(Number); return h! * 60 + m!; };

export async function loadPlanBoard(ctx: AccessContext, plan: PersistedPlan): Promise<PlanBoard> {
  const store = getStore();
  const today = planToday(ctx);
  const forecast = loadGoalForecast(ctx);
  const labels = Object.fromEntries(defaultIdentityPacks().map((pack) => [pack.id, pack.label]));
  const milestones = store.listMilestones(ctx.workspaceId);
  const lineOf = new Map(milestones.map((item) => [item.id, item.identityId]));
  const weekEnd = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const twoWeeks = new Date(Date.parse(`${today}T12:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
  const scheduled = plan.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day && block.day >= today && block.day < weekEnd);
  const ranking = planRanking(ctx, plan);

  const busy = Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => 0));
  for (const block of plan.blocks) {
    if (!block.day || block.day < today || block.day >= twoWeeks || !(block.id.startsWith("graph_calendar:") || block.id.startsWith("import:"))) continue;
    const weekday = new Date(`${block.day}T12:00:00Z`).getUTCDay();
    for (let cell = Math.floor(minutesOf(block.start) / 30); cell < Math.ceil(minutesOf(block.end) / 30) && cell < 48; cell += 1) busy[weekday]![cell]! += 1;
  }

  const presets = importancePresets(ctx);
  const approved = milestones.filter((item) => item.status === "approved");
  const preferences = readSchedulePreferences(ctx);
  return {
    today, timeZone: effectiveSchedulePreferences(ctx).preferences.timeZone, labels,
    capacity: {
      statedWeekly: statedWeeklyHours(store.listProfileFacts(ctx.workspaceId)) ?? null,
      configuredWeekly: weeklyAvailableHours(readAvailability(ctx)),
      plannedThisWeek: scheduled.reduce((sum, block) => sum + minutesOf(block.end) - minutesOf(block.start), 0),
      openP50: ranking.reduce((sum, task) => sum + task.p50Minutes, 0),
      openP85: ranking.reduce((sum, task) => sum + task.p85Minutes, 0),
      usingDefault: plan.usingDefaultPreferences
    },
    weeks: forecast.weeks.map((week) => ({ ...week,
      start: new Date(Date.parse(`${today}T12:00:00Z`) + (week.week - 1) * 7 * 86_400_000).toISOString().slice(0, 10) })),
    goals: forecast.goals.map((goal) => ({ id: goal.milestoneId, title: goal.title, line: lineOf.get(goal.milestoneId) ?? "none",
      p50Day: goal.p50Day, p85Day: goal.p85Day, deadline: goal.confirmedDeadline, slackDays: goal.slackDays,
      atRisk: goal.slackDays !== null && goal.slackDays < DEADLINE_MARGIN_DAYS, bottleneck: goal.bottleneck,
      p50Minutes: goal.p50Minutes, p85Minutes: goal.p85Minutes,
      unforecast: !goal.confirmedDeadline && effectiveWeight(ctx, goal.milestoneId) < IMPORTANT_WEIGHT })),
    inferredRegularBlocks: forecast.inferredRegularBlocks,
    ranking,
    params: effectiveParams(ctx), presets: { buffered: PARAMS_BUFFERED, asap: PARAMS_ASAP },
    importance: approved.flatMap((item) => {
      const preset = presets.get(item.id);
      if (!preset) return [];
      const goal = readGoalSettings(ctx, item.id);
      const custom = typeof goal?.weight === "number" || Boolean(goal?.importance ?? preferences?.importance[item.id]);
      return [{ id: item.id, title: item.title, line: item.identityId, weight: effectiveWeight(ctx, item.id), custom, preset }];
    }),
    week: { windows: readAvailability(ctx), suggested: suggestedAvailabilityFor(ctx), busy }
  };
}
