
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
  /**
   * Work from the task library (its milestone is due beyond the library window): it earns nothing by being placed and is placed only
   * to meet its line's weekly floor (`PlanningInput.lineShares`); left out, it is not reported as unplaced.
   */
  floorOnly?: boolean;
  /**
   * Extra days this work is aimed to finish before its deadline because its milestone carries a risk (`riskBufferDays` in core: two for
   * a high one, one for a medium one). Added to the person's own deadline buffer and dropped with it in the relaxed run.
   */
  riskBufferDays?: number;
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
  // Minutes are kept on the five-minute grid every block is placed on (GRID_MINUTES in optimizer.ts).
  const toGrid = (minutes: number) => Math.round(minutes / 5) * 5;
  return { gapMinutes: toGrid(pick("gapMinutes")), maxDailyShare: Math.round(pick("maxDailyShare") * 100) / 100,
    focusCapMinutes: toGrid(pick("focusCapMinutes")), deadlineBufferDays: Math.round(pick("deadlineBufferDays")) };
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
  /**
   * Each line's share (percent) of the next seven days' free time, as the person stated it: a soft floor worth less than any deadline,
   * so a line whose milestones are far off still gets its hours (the real account's plan was 100% research while the person had said
   * 64 / 20 / 11 / 5).
   */
  lineShares?: Record<string, number>;
  /**
   * A day's capacity (docs/energy-and-ecosystem.md §3.3): a multiplier below 1 holds that day's work without a deadline to that part of
   * its share — after short nights or a heart-rate reading off the person's baseline. Work with a deadline is not held, so a tired day
   * never puts a deadline at risk; the relaxed (emergency) run ignores it.
   */
  capacityByDay?: Record<string, number>;
  /**
   * How much of an hour's work a slot one and two energy levels short of the work yields, learned from the person's own confirmed
   * blocks (`packages/core/src/efficiency.ts`) and passed only once a backtest shows them better than the assumed 0.8 and 0.65.
   */
  efficiency?: [number, number];
};

export type ScheduleBlock = { taskId: string; start: string; end: string;
  frozen?: boolean; progressOnly?: boolean;
  /** Set when the slot is short of the energy the task needs: the share of an hour's work it yields, so the block runs that much longer. */
  efficiency?: number };

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

/**
 * Whether two plans do something different over the next `hours` (docs/energy-and-ecosystem.md §6, the value-of-information gate): the
 * blocks not yet over that start before then, compared by task and start rounded to 15 minutes. Frozen blocks are the same in both and
 * left out. Equal heads mean the answer to a question about now would change nothing the person is about to do.
 */
export function planHeadDiffers(a: ScheduleBlock[], b: ScheduleBlock[], now: Date, hours = 3): boolean {
  const from = now.getTime(), until = from + hours * 3_600_000;
  const head = (blocks: ScheduleBlock[]) => new Set(blocks.filter((block) => !block.frozen && Date.parse(block.end) > from && Date.parse(block.start) < until)
    .map((block) => `${block.taskId}|${Math.round(Date.parse(block.start) / 900_000)}`));
  const left = head(a), right = head(b);
  return left.size !== right.size || [...left].some((key) => !right.has(key));
}

export { planSchedule, type SolveOptions, type ModelSolver, type HighsSolution } from "./optimizer";
export { scheduleInputHash } from "./input-hash";
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
