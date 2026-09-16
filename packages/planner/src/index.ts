
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
  deadlineTier: 1 | 2 | 3;
  interruptible?: boolean;
  deadline?: string;
};

export type PlanningInput = {
  now: Date;
  horizonDays: number;
  tasks: PlannerTask[];
  availability: Array<{ start: string; end: string; energy: "low" | "medium" | "high" }>;
  frozenBlocks: Array<{ taskId: string; start: string; end: string }>;
};

type ScheduleBlock = { taskId: string; start: string; end: string; frozen?: boolean };

export type PlanResult =
  | { status: "feasible"; plan: { blocks: ScheduleBlock[] } }
  | { status: "infeasible"; blockers: Array<{ code: string; taskId: string; message: string }> };

const energyValue = { low: 1, medium: 2, high: 3 } as const;

export function planSchedule(input: PlanningInput): PlanResult {
  const frozenIds = new Set(input.frozenBlocks.map((block) => block.taskId));
  const blocks: ScheduleBlock[] = input.frozenBlocks.map((block) => ({ ...block, frozen: true }));
  const slots = input.availability
    .map((slot) => ({ ...slot, startMs: Date.parse(slot.start), endMs: Date.parse(slot.end) }))
    .sort((a, b) => a.startMs - b.startMs);
  const blockers: Array<{ code: string; taskId: string; message: string }> = [];
  const tasks = input.tasks
    .filter((task) => !frozenIds.has(task.id))
    .sort(compareTasks);

  for (const task of tasks) {
    const reservedMinutes = task.estimate.confidence === "low" ? task.estimate.p85Minutes : task.estimate.p50Minutes;
    const durationMs = reservedMinutes * 60_000;
    const deadlineMs = task.deadline ? Date.parse(task.deadline) : Number.POSITIVE_INFINITY;
    const slot = slots.find((candidate) =>
      candidate.endMs - candidate.startMs >= durationMs &&
      candidate.startMs + durationMs <= deadlineMs &&
      (!task.energy || energyValue[candidate.energy] >= energyValue[task.energy])
    );
    if (!slot) {
      blockers.push({
        code: task.interruptible === false ? "NO_CONTINUOUS_SLOT" : "NO_CAPACITY",
        taskId: task.id,
        message: task.interruptible === false
          ? `${task.title}需要连续 ${reservedMinutes} 分钟`
          : `${task.title}在排程窗口内没有可用容量`
      });
      continue;
    }
    const endMs = slot.startMs + durationMs;
    blocks.push({ taskId: task.id, start: new Date(slot.startMs).toISOString(), end: new Date(endMs).toISOString() });
    slot.startMs = endMs;
  }

  if (blockers.length > 0) return { status: "infeasible", blockers };
  return { status: "feasible", plan: { blocks: blocks.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) } };
}

export function recommendNextActions(_tasks: PlannerTask[], _gapMinutes: number): {
  primary?: PlannerTask;
  lowEnergy?: PlannerTask;
  shortGap?: PlannerTask;
} {
  const primary = [..._tasks].filter((task) => task.inputsReady).sort(compareTasks)[0];
  const lowEnergy = _tasks
    .filter((task) => task.energy === "low" && task.id !== primary?.id)
    .sort(compareTasks)[0];
  const shortGap = _tasks
    .filter((task) => task.estimate.p85Minutes <= _gapMinutes && task.id !== primary?.id && task.id !== lowEnergy?.id)
    .sort((a, b) => a.estimate.p50Minutes - b.estimate.p50Minutes || compareTasks(a, b))[0];
  return {
    ...(primary ? { primary } : {}),
    ...(lowEnergy ? { lowEnergy } : {}),
    ...(shortGap ? { shortGap } : {})
  };
}

function compareTasks(a: PlannerTask, b: PlannerTask): number {
  if (a.inputsReady !== b.inputsReady) return a.inputsReady ? -1 : 1;
  if (a.deadlineTier !== b.deadlineTier) return a.deadlineTier - b.deadlineTier;
  const deadlineA = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY;
  const deadlineB = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY;
  if (deadlineA !== deadlineB) return deadlineA - deadlineB;
  return a.estimate.p50Minutes - b.estimate.p50Minutes || a.id.localeCompare(b.id);
}
