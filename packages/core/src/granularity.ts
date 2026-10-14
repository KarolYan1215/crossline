/**
 * Adaptive granularity (docs/energy-and-ecosystem.md §6): a step the person keeps not getting through is too big to begin, so it is
 * split again — no question, no push. What counts as not getting through a step, each read from the ledger by the worker:
 * - `not_done`: the completion check answered 「未执行」 (`block.confirmed`, outcome `not_done`);
 * - `missed`: 「昨天排的没做」 answered by rolling it forward (`missed.handled`);
 * - `not_started`: a block seen under way with no timer started for the task that day and no completion answer;
 * - `overrun`: the timer ran half again over the step's usual minutes (the `timer_overrun` nudge).
 * The same block failing in two ways (unstarted and answered 「未执行」) is one failure: troubles are counted per step per day.
 */
export type StepTrouble = { kind: "not_done" | "missed" | "not_started" | "overrun"; orderId: string; stepId: string; day: string };
/** A finer split already asked for: the step, the plan version it belonged to, and when. */
export type FinerSplitAsked = { orderId: string; stepId: string; version: number; at: string };
export type FinerSplit = { orderId: string; stepId: string; version: number; days: string[] };

/** Days of trouble on one step before it is split again. */
export const FINER_SPLIT_AFTER = 2;
/** At most one automatic split per task in this many days, whatever its steps do. */
export const FINER_SPLIT_TASK_DAYS = 7;
/** What the step planner is told; the step's title goes in front. */
export const FINER_SPLIT_FEEDBACK = "拆细，首步 ≤15 分钟";

/**
 * The open steps of current plans that have had trouble on `FINER_SPLIT_AFTER` days or more, at most one per task (the step with the
 * most days, then the earliest in the plan). A step is split once per plan version — a replan gives its steps new ids, so the new
 * smaller steps start counting afresh — and a task at most once a week.
 */
export function stepsNeedingFinerSplit(events: StepTrouble[], context: {
  plans: Array<{ orderId: string; version: number; openStepIds: string[] }>; asked: FinerSplitAsked[]; now: string;
}): FinerSplit[] {
  const since = Date.parse(context.now) - FINER_SPLIT_TASK_DAYS * 86_400_000;
  const days = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.orderId || !event.stepId || !event.day) continue;
    const key = `${event.orderId}#${event.stepId}`;
    days.set(key, (days.get(key) ?? new Set()).add(event.day));
  }
  return context.plans.flatMap((plan) => {
    if (context.asked.some((asked) => asked.orderId === plan.orderId && Date.parse(asked.at) > since)) return [];
    const candidates = plan.openStepIds.flatMap((stepId, index) => {
      const seen = days.get(`${plan.orderId}#${stepId}`);
      if (!seen || seen.size < FINER_SPLIT_AFTER) return [];
      if (context.asked.some((asked) => asked.orderId === plan.orderId && asked.stepId === stepId && asked.version === plan.version)) return [];
      return [{ stepId, index, days: [...seen].sort() }];
    }).sort((a, b) => b.days.length - a.days.length || a.index - b.index);
    const pick = candidates[0];
    return pick ? [{ orderId: plan.orderId, stepId: pick.stepId, version: plan.version, days: pick.days }] : [];
  });
}
