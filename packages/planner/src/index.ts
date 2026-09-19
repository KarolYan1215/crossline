
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
};

export type PlanningInput = {
  now: Date;
  horizonDays: number;
  mode?: "buffered" | "asap";
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
  solver: "optimal" | "feasible_time_limit" | "fallback";
  bufferRelaxed?: boolean;
};

const energyValue = { low: 1, medium: 2, high: 3 } as const;

export { planSchedule } from "./optimizer";
export { forecastGoals, type ForecastGoal, type ForecastDay, type ForecastResult } from "./forecast";

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
  return a.estimate.p50Minutes - b.estimate.p50Minutes || a.id.localeCompare(b.id);
}
