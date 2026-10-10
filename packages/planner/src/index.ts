
export type PlannerTask = {
  id: string;
  title: string;
  identityId?: string;
  milestoneId?: string;
  estimate: {
    p25Minutes: number;
    p50Minutes: number;
    p85Minutes: number;
    confidence: "low" | "medium" | "high";
  };
  energy?: "low" | "medium" | "high";
  inputsReady: boolean;
  deadlineTier: 1 | 2 | 3 | 4;
  interruptible?: boolean;
  deadline?: string;
  dependsOn?: string[];
  /** ISO instant before which no block may start: the work waits for something to arrive (a release date). */
  notBefore?: string;
  /** Importance 0-100 (the milestone's weight). Orders work inside a deadline tier; never lifts work across tiers. */
  weight?: number;
};

/**
 * The four numbers the person sets for how a day is packed: the break between blocks, the share of a day's free time that may be
 * filled, the longest stretch one task gets before it moves to another slot (0 = no cap), and how many days before a deadline work is
 * aimed to finish. `buffered` and `asap` are the two presets the old mode switch stood for.
 */
export type ScheduleParams = { gapMinutes: number; maxDailyShare: number; focusCapMinutes: number; deadlineBufferDays: number };
export const PARAMS_BUFFERED: ScheduleParams = { gapMinutes: 10, maxDailyShare: 0.85, focusCapMinutes: 0, deadlineBufferDays: 0 };
export const PARAMS_ASAP: ScheduleParams = { gapMinutes: 0, maxDailyShare: 1, focusCapMinutes: 0, deadlineBufferDays: 0 };
export const SCHEDULE_PARAM_LIMITS = {
  gapMinutes: { min: 0, max: 30, step: 5 }, maxDailyShare: { min: 0.5, max: 1, step: 0.05 },
  focusCapMinutes: { min: 0, max: 180, step: 15 }, deadlineBufferDays: { min: 0, max: 5, step: 1 }
} as const;
export function paramsFor(input: { mode?: "buffered" | "asap" | undefined; params?: ScheduleParams | undefined }): ScheduleParams {
  return input.params ?? (input.mode === "asap" ? PARAMS_ASAP : PARAMS_BUFFERED);
}
/** A stored or submitted set clamped into range; anything missing takes the buffered preset's value. */
export function normalizeParams(value: unknown): ScheduleParams {
  const raw = (value ?? {}) as Partial<Record<keyof ScheduleParams, unknown>>;
  const pick = (key: keyof ScheduleParams) => {
    const limit = SCHEDULE_PARAM_LIMITS[key];
    const given = raw[key];
    const number = typeof given === "number" && Number.isFinite(given) ? given : PARAMS_BUFFERED[key];
    return Math.min(limit.max, Math.max(limit.min, number));
  };
  return { gapMinutes: Math.round(pick("gapMinutes")), maxDailyShare: Math.round(pick("maxDailyShare") * 100) / 100,
    focusCapMinutes: Math.round(pick("focusCapMinutes")), deadlineBufferDays: Math.round(pick("deadlineBufferDays")) };
}

export type PlanningInput = {
  now: Date;
  horizonDays: number;
  mode?: "buffered" | "asap";
  /** Overrides what `mode` stands for; see `ScheduleParams`. */
  params?: ScheduleParams;
  currentEnergy?: "low" | "medium" | "high";
  currentDay?: string;
  tasks: PlannerTask[];
  availability: Array<{ start: string; end: string; day?: string; energy: "low" | "medium" | "high" }>;
  /** Capacity evidence for fourth-quadrant wake-up; never used to place the near-term plan. */
  lookaheadAvailability?: PlanningInput["availability"];
  frozenBlocks: Array<{ taskId: string; start: string; end: string }>;
};

export type ScheduleBlock = { taskId: string; start: string; end: string;
  frozen?: boolean; progressOnly?: boolean };

export type PlanBlocker = { code: string; taskId: string; message: string };
export type PlanResult = {
  status: "feasible" | "partial" | "infeasible";
  plan: { blocks: ScheduleBlock[] };
  blockers: PlanBlocker[];
  /** Things the person should know about a plan that did get made — a buffer that had to be cut down to
   * fit the longest free stretch, say. Not blockers: the work was scheduled. */
  notes?: PlanBlocker[];
  solver: "optimal" | "feasible_time_limit" | "fallback" | "empty" | "no_capacity";
  bufferRelaxed?: boolean;
};

const energyValue = { low: 1, medium: 2, high: 3 } as const;

export { planSchedule } from "./optimizer";
export { forecastGoals, DEADLINE_MARGIN_DAYS, type ForecastGoal, type ForecastDay, type ForecastResult, type ForecastWeek, type GoalForecast, type WeekDemand } from "./forecast";

export function recommendNextActions(_tasks: PlannerTask[], _gapMinutes: number,
  currentEnergy?: "low" | "medium" | "high", now = new Date(),
  predictedAfter: Record<string, "low" | "medium" | "high"> = {}): {
  primary?: PlannerTask;
  lowEnergy?: PlannerTask;
  shortGap?: PlannerTask;
  higherPriority?: PlannerTask;
} {
  const ready = _tasks.filter((task) => task.inputsReady && task.deadlineTier !== 4).sort(compareTasks);
  const urgent = ready.find((task) => task.deadline && Date.parse(task.deadline) - now.getTime() <= 24 * 60 * 60_000);
  const matching = currentEnergy ? ready.filter((task) => task.energy === currentEnergy)
    .sort((a, b) => a.deadlineTier === b.deadlineTier && !a.deadline && !b.deadline
      ? (energyValue[predictedAfter[b.id] ?? currentEnergy] -
          energyValue[predictedAfter[a.id] ?? currentEnergy]) || compareTasks(a, b)
      : compareTasks(a, b))[0] : undefined;
  const compatible = currentEnergy ? ready.find((task) => task.energy &&
    energyValue[task.energy] <= energyValue[currentEnergy]) : undefined;
  const primary = urgent ?? matching ?? compatible ?? ready[0];
  const higherPriority = primary && currentEnergy ? ready.find((task) =>
    task.id !== primary.id && compareTasks(task, primary) < 0) : undefined;
  const lowEnergy = _tasks
    .filter((task) => task.energy === "low" && task.id !== primary?.id && task.deadlineTier !== 4)
    .sort(compareTasks)[0];
  const shortGap = _tasks
    .filter((task) => task.estimate.p85Minutes <= _gapMinutes && task.id !== primary?.id &&
      task.id !== lowEnergy?.id && task.deadlineTier !== 4)
    .sort((a, b) => a.estimate.p50Minutes - b.estimate.p50Minutes || compareTasks(a, b))[0];
  return {
    ...(primary ? { primary } : {}),
    ...(higherPriority ? { higherPriority } : {}),
    ...(lowEnergy ? { lowEnergy } : {}),
    ...(shortGap ? { shortGap } : {})
  };
}

export function compareTasks(a: PlannerTask, b: PlannerTask): number {
  if (a.inputsReady !== b.inputsReady) return a.inputsReady ? -1 : 1;
  if (a.deadlineTier !== b.deadlineTier) return a.deadlineTier - b.deadlineTier;
  const deadlineA = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY;
  const deadlineB = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY;
  if (deadlineA !== deadlineB) return deadlineA - deadlineB;
  if ((a.weight ?? 50) !== (b.weight ?? 50)) return (b.weight ?? 50) - (a.weight ?? 50);
  return a.estimate.p50Minutes - b.estimate.p50Minutes || a.id.localeCompare(b.id);
}
