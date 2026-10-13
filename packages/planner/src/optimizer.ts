import { compareTasks, paramsFor, type PlanBlocker, type PlanResult, type PlannerTask, type PlanningInput, type ScheduleBlock } from "./index";
import { createRequire } from "node:module";

// Keep HiGHS outside the Next server bundle so its loader finds highs.wasm beside itself.
const loadHighs = createRequire(import.meta.url)("highs") as typeof import("highs").default;

type Slot = { start: number; end: number; energy: "low" | "medium" | "high"; day: string };
type Choice = { task: number; slot: number; presence: string; minutes?: string; duration: number; maximum: number; efficiency: number; short: number;
  /** Longest session in this slot; `rests` counts the rests between sessions when the work here may run past one session. */
  cap: number; rests?: string };
const energyRank = { low: 1, medium: 2, high: 3 } as const;

/*
 * Energy is how much an hour yields, not whether the hour may be used (decided 2026-10-12). It used to be a hard filter: work needing
 * 「high」 went only into high slots, about three hours a day, so a homework due tomorrow got nothing while those hours went to undated
 * work. The evidence for time-of-day effects is real but moderate and task-dependent (effort can offset it on reasoning tasks), with no
 * reliable percentage, so these factors are assumptions to be calibrated against timed work; time-on-task fatigue builds gradually,
 * so work is done in sessions with a rest between (a long slot holds several), shorter where the slot is short of the energy needed.
 *   EFFICIENCY[k]: share of an hour's work a slot k levels short of the task's need yields (one short ≈ 1.25×, two short ≈ 1.5× the time).
 *   SESSION_CAP[k]: longest session there — 90 minutes even in a matching slot (sustained attention declines with time on task; the
 *   60–90-minute session is the defensible default, not a precise cycle) — and REST_MINUTES between sessions. Work that cannot be
 *   interrupted stays one block: a real evening once read 19:30–22:58 on one outline without a pause.
 * One level short is open to all work; two levels short (high work in a low slot) only to work with a deadline: time pressure is the
 * reason to work tired, and work without one waits for a better hour. Each minute short carries a small cost, so a matching slot is
 * always taken first, but never one large enough to leave work unplaced rather than placed in a weaker hour.
 */
const EFFICIENCY = [1, 0.8, 0.65] as const;
const SESSION_CAP = [90, 60, 45] as const;
const REST_MINUTES = 10;
const SHORT_COST_PER_MINUTE = 0.002;
const shortfall = (task: PlannerTask, slot: Slot): number => task.energy ? Math.max(0, energyRank[task.energy] - energyRank[slot.energy]) : 0;
const usable = (task: PlannerTask, short: number): boolean => short <= 1 || (short === 2 && Boolean(task.deadline));
/** Wall minutes needed in a slot to get `work` minutes done there. */
const wallMinutes = (work: number, efficiency: number) => Math.ceil(work / efficiency - 1e-9);
const sessionCap = (task: PlannerTask, short: number) => task.interruptible === false ? Infinity : SESSION_CAP[short]!;
/** `minutes` of work cut into the fewest sessions of at most `cap`, evenly (185 at 45 is five of 37, not four of 45 and a 5-minute tail). */
const sessions = (minutes: number, cap: number): number[] => {
  const count = cap === Infinity ? 1 : Math.max(1, Math.ceil(minutes / cap));
  const base = Math.floor(minutes / count);
  return Array.from({ length: count }, (_, index) => base + (index < minutes - base * count ? 1 : 0));
};
/** The most work minutes that fit in `room` minutes as sessions of at most `cap` with `rest` between. */
const fitting = (room: number, cap: number, rest: number): number => {
  let work = 0;
  for (let left = room; left > 0; left -= cap + rest) work += Math.min(cap, left);
  return work;
};
const highsReady = loadHighs();
const MIN_SEGMENT = 15;

const durationOf = (task: PlannerTask) => task.estimate.confidence === "low"
  ? task.estimate.p85Minutes : task.estimate.p50Minutes;
const term = (coefficient: number, name: string) => `${coefficient < 0 ? "-" : "+"} ${Math.abs(coefficient)} ${name}`;
const expression = (terms: Array<[number, string]>) => terms.map(([value, name]) => term(value, name)).join(" ") || "0";
const valueOf = (columns: Record<string, { Primal?: number }>, name: string) => columns[name]?.Primal ?? 0;

function freeSlots(input: PlanningInput): Slot[] {
  const frozen = input.frozenBlocks.map((block) => ({ start: Date.parse(block.start), end: Date.parse(block.end) }));
  const slots: Slot[] = [];
  for (const available of input.availability) {
    const start = Math.max(Date.parse(available.start), input.now.getTime());
    const end = Date.parse(available.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < MIN_SEGMENT * 60_000) continue;
    let pieces = [{ start, end }];
    for (const block of frozen) {
      pieces = pieces.flatMap((piece) => block.end <= piece.start || block.start >= piece.end ? [piece] : [
        { start: piece.start, end: Math.min(piece.end, block.start) },
        { start: Math.max(piece.start, block.end), end: piece.end }
      ].filter((item) => item.end - item.start >= MIN_SEGMENT * 60_000));
    }
    slots.push(...pieces.map((piece) => ({ ...piece, energy: available.energy,
      day: available.day ?? available.start.slice(0, 10) })));
  }
  return slots.sort((a, b) => a.start - b.start || a.end - b.end);
}

function statusFor(blocks: ScheduleBlock[], blockers: PlanResult["blockers"], frozenCount: number): PlanResult["status"] {
  if (!blockers.length) return "feasible";
  return blocks.length > frozenCount ? "partial" : "infeasible";
}

/** Verify the returned clock times independently of the MILP's own constraint bookkeeping. */
function validBlocks(blocks: ScheduleBlock[], slots: Slot[], input: PlanningInput, gap: number): boolean {
  const sorted = [...blocks].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (let i = 0; i < sorted.length; i += 1) {
    const block = sorted[i]!;
    const start = Date.parse(block.start), end = Date.parse(block.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
    if (i && start < Date.parse(sorted[i - 1]!.end)) return false;
    if (i && !block.frozen && !sorted[i - 1]!.frozen &&
      start < Date.parse(sorted[i - 1]!.end) + gap * 60_000) return false;
    if (block.frozen) continue;
    if (!slots.some((slot) => start >= slot.start && end <= slot.end)) return false;
    const task = input.tasks.find((item) => item.id === block.taskId);
    if (!task || (task.deadline && end > Date.parse(task.deadline)) ||
      !slots.some((slot) => start >= slot.start && end <= slot.end && usable(task, shortfall(task, slot)))) return false;
  }
  const credited = (task: PlannerTask, block: ScheduleBlock) => {
    const start = Date.parse(block.start), end = Date.parse(block.end);
    const slot = slots.find((item) => start >= item.start && end <= item.end);
    return (end - start) / 60_000 * (slot ? EFFICIENCY[shortfall(task, slot)]! : 1);
  };
  for (const task of input.tasks) {
    const own = sorted.filter((block) => block.taskId === task.id);
    if (!own.length) continue;
    // Work done, not wall time: a slot short of the energy needed yields less per minute. Whole minutes leave at most one over.
    const expected = own.some((block) => block.progressOnly) ? 45 : durationOf(task);
    const done = own.reduce((sum, block) => sum + (block.frozen ? 0 : credited(task, block)), 0);
    if (done < expected - 1e-6 || done > expected + 1 + 1e-6) return false;
    if (task.interruptible === false && own.length !== 1) return false;
    if (task.notBefore && Date.parse(own[0]!.start) < Date.parse(task.notBefore)) return false;
    for (const dependency of task.dependsOn ?? []) {
      const prerequisite = sorted.filter((block) => block.taskId === dependency);
      if (input.tasks.some((item) => item.id === dependency) && !prerequisite.length) return false;
      if (prerequisite.length && Date.parse(prerequisite.at(-1)!.end) > Date.parse(own[0]!.start)) return false;
    }
  }
  return true;
}

/** The longest unbroken stretch this task could use: slots too low-energy for it do not count. */
function longestSlotMinutes(slots: Slot[], task: PlannerTask): number {
  return Math.max(0, ...slots
    .filter((slot) => !task.energy || energyRank[slot.energy] >= energyRank[task.energy])
    .map((slot) => Math.floor((slot.end - slot.start) / 60_000)));
}

/**
 * A low-confidence estimate is reserved at p85, which is the right instinct for work that can be split
 * across days and the wrong one for work that has to sit in one slot: a 90–360 minute job marked
 * uninterruptible asked for a single 360-minute block, which almost no availability pattern contains, so
 * it never reached the schedule at all. When p85 will not fit the longest slot but the expected time (p50)
 * will, reserve as much of the buffer as one slot allows — never less than p50 — and say so. Work whose
 * p50 does not fit stays unscheduled, but with a message that names the real obstacle.
 */
function clampContinuousBuffers(input: PlanningInput): { input: PlanningInput; notes: PlanBlocker[] } {
  const slots = freeSlots(input);
  const notes: PlanBlocker[] = [];
  const tasks = input.tasks.map((task) => {
    if (task.interruptible !== false || task.estimate.confidence !== "low") return task;
    const longest = longestSlotMinutes(slots, task);
    const { p50Minutes, p85Minutes } = task.estimate;
    if (p85Minutes <= longest || p50Minutes > longest) return task;
    notes.push({ taskId: task.id, code: "BUFFER_CLAMPED",
      message: `${task.title}要一口气做完，按保守估计需要 ${p85Minutes} 分钟，但最长的连续空档只有 ${longest} 分钟；已按 ${longest} 分钟预留（预期用时 ${p50Minutes} 分钟）` });
    return { ...task, estimate: { ...task.estimate, p85Minutes: longest } };
  });
  return { input: { ...input, tasks }, notes };
}

/**
 * What placing a task is worth, in the solver's objective: urgency first (the deadline tier, lexicographic as before), then importance
 * inside a tier — the weight moves a task by less than a whole tier, so a heavier task never outranks one in a more urgent tier. Library
 * work earns nothing of its own.
 */
const taskValue = (task: PlannerTask, n: number) => task.floorOnly ? 0
  : (task.deadline ? n ** 4 : 0) + ((4 - task.deadlineTier) + .9 * (task.weight ?? 50) / 100) * n + (task.inputsReady ? 1 : 0);

/** What a plan is worth by the same measure, less the parts the greedy pass does not attempt (line floors, weekly progress). */
function worth(result: PlanResult, tasks: PlannerTask[]): number {
  const placed = new Set(result.plan.blocks.filter((block) => !block.frozen && !block.progressOnly).map((block) => block.taskId));
  return tasks.reduce((sum, task) => placed.has(task.id) ? sum + taskValue(task, tasks.length + 1) : sum, 0);
}

function makeResult(input: PlanningInput, tasks: PlannerTask[], slots: Slot[], blocks: ScheduleBlock[],
  solver: PlanResult["solver"]): PlanResult {
  const scheduled = new Set(blocks.filter((block) => !block.progressOnly).map((block) => block.taskId));
  // 「截止日前不够」 only when the deadline falls inside the days being planned; one beyond them is simply not reached yet.
  const horizon = Math.max(0, ...slots.map((slot) => slot.end));
  const blockers = tasks.filter((task) => !scheduled.has(task.id) && !task.floorOnly).map((task) => ({
    taskId: task.id,
    code: blocks.some((block) => block.taskId === task.id && block.progressOnly) ? "PROGRESS_ONLY"
      : task.interruptible === false ? "NO_CONTINUOUS_SLOT" : task.deadline && Date.parse(task.deadline) <= horizon ? "DEADLINE_CAPACITY" : "NO_CAPACITY",
    message: blocks.some((block) => block.taskId === task.id && block.progressOnly)
      ? `${task.title}本周已留 45 分钟进度，完整作业仍待排入`
      : task.interruptible === false
        ? longestSlotMinutes(slots, task) < durationOf(task)
          ? `${task.title}需要连续 ${durationOf(task)} 分钟，但最长的连续空档只有 ${longestSlotMinutes(slots, task)} 分钟；可以补充更长的可用时间，或确认它其实可以分几次做`
          : `${task.title}需要连续 ${durationOf(task)} 分钟`
      : task.deadline ? `${task.title}无法在已确认截止时间前排入` : `${task.title}在排程窗口内没有可用容量`
  }));
  return { status: statusFor(blocks, blockers, input.frozenBlocks.length),
    plan: { blocks: blocks.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) }, blockers, solver };
}

function greedyFallback(input: PlanningInput, tasks: PlannerTask[], slots: Slot[], emergency = false): PlanResult {
  const blocks: ScheduleBlock[] = input.frozenBlocks.map((block) => ({ ...block, frozen: true }));
  const cursors = slots.map((slot) => slot.start);
  const dayCapacity = new Map<string, number>();
  const dayUsed = new Map<string, number>();
  for (const slot of slots) dayCapacity.set(slot.day, (dayCapacity.get(slot.day) ?? 0) + (slot.end - slot.start) / 60_000);
  const params = paramsFor(input);
  const gap = emergency ? 0 : params.gapMinutes;
  const share = emergency ? 1 : params.maxDailyShare;
  // Library work goes in only to meet a line's floor, which this simple pass does not weigh; it waits for the solver.
  const pending = tasks.filter((task) => !task.floorOnly).sort(compareTasks);
  const ordered: PlannerTask[] = [];
  while (pending.length) {
    const index = pending.findIndex((task) => !(task.dependsOn ?? []).some((id) => pending.some((item) => item.id === id)));
    if (index < 0) break;
    ordered.push(pending.splice(index, 1)[0]!);
  }
  // One task at a time, in matching slots first; only when that cannot finish it are slots short of its energy used too.
  const attempt = (task: PlannerTask, loose: boolean) => {
    const candidate = [...cursors];
    const nextUsed = new Map(dayUsed);
    const staged: ScheduleBlock[] = [];
    let left = durationOf(task);
    for (let s = 0; s < slots.length && left > 1e-9; s += 1) {
      const slot = slots[s]!;
      const short = shortfall(task, slot);
      if (loose ? !usable(task, short) : short > 0) continue;
      const efficiency = EFFICIENCY[short]!;
      const dependencyEnd = Math.max(0, ...(task.dependsOn ?? []).flatMap((id) =>
        blocks.filter((block) => block.taskId === id).map((block) => Date.parse(block.end))));
      // The slot's own cursor keeps the gap after whatever this slot already holds. It used to be the end of the last block placed
      // anywhere, in placing order: once one task landed on Friday, every later task could only start after it, and the whole week
      // before stood empty while twenty steps were reported as having no room.
      // What it must keep the gap from is the block just before it in time — across the boundary of an adjacent window too.
      const earliest = Math.max(candidate[s]!, dependencyEnd, task.notBefore ? Date.parse(task.notBefore) : 0);
      const start = Math.max(earliest, ...[...blocks, ...staged].filter((block) => !block.frozen && Date.parse(block.end) <= earliest
        && Date.parse(block.end) > earliest - gap * 60_000).map((block) => Date.parse(block.end) + gap * 60_000));
      const until = Math.min(slot.end, task.deadline ? Date.parse(task.deadline) : Infinity);
      const remainingCap = share >= 1 ? Infinity
        : Math.floor((dayCapacity.get(slot.day) ?? 0) * share) - (nextUsed.get(slot.day) ?? 0);
      const need = wallMinutes(left, efficiency);
      const cap = sessionCap(task, short);
      const focusCap = task.interruptible !== false && params.focusCapMinutes ? params.focusCapMinutes : Infinity;
      const rest = Math.max(REST_MINUTES, gap);
      const minutes = Math.min(need, fitting(Math.floor((until - start) / 60_000), cap, rest), remainingCap, focusCap);
      if (minutes < (task.interruptible === false ? need : Math.min(need, MIN_SEGMENT))) continue;
      let at = start;
      for (const length of sessions(minutes, cap)) {
        if (at > start) at += rest * 60_000;
        staged.push({ taskId: task.id, start: new Date(at).toISOString(),
          end: new Date(at + length * 60_000).toISOString(), ...(efficiency < 1 ? { efficiency } : {}) });
        at += length * 60_000;
      }
      candidate[s] = at + gap * 60_000;
      nextUsed.set(slot.day, (nextUsed.get(slot.day) ?? 0) + minutes);
      left -= minutes * efficiency;
      if (task.interruptible === false) break;
    }
    return left <= 1e-9 ? { staged, candidate, nextUsed } : undefined;
  };
  for (const task of ordered) {
    if ((task.dependsOn ?? []).some((id) => tasks.some((item) => item.id === id) &&
      !blocks.some((block) => block.taskId === id))) continue;
    const placed = attempt(task, false) ?? attempt(task, true);
    if (!placed) continue;
    blocks.push(...placed.staged);
    cursors.splice(0, cursors.length, ...placed.candidate);
    dayUsed.clear(); for (const [day, minutes] of placed.nextUsed) dayUsed.set(day, minutes);
  }
  return makeResult(input, tasks, slots, blocks, "fallback");
}

export type HighsSolution = ReturnType<Awaited<ReturnType<typeof loadHighs>>["solve"]>;
/** Solves an LP-format model within a time limit; the background solve passes one that runs HiGHS off the request thread. */
export type ModelSolver = (model: string, timeLimitSeconds: number) => Promise<HighsSolution>;
/**
 * How the plan is solved. `timeLimitSeconds`: how long the solver may run (default two seconds; the bench and the background solve
 * pass more). `solver`: `"none"` places with the greedy pass only (what the page shows at once, docs/loop-and-scout.md §2); a function
 * replaces the in-process HiGHS; absent, HiGHS runs in this process.
 */
export type SolveOptions = { timeLimitSeconds?: number; solver?: "none" | ModelSolver };

/**
 * A frozen block freezes that segment only (docs/loop-and-scout.md §1): the task keeps the rest of its minutes to place. Work that
 * must sit in one slot (`interruptible: false`) is never cut, so a frozen block means it is placed; so is a task whose frozen minutes
 * cover it. It used to drop every task with any frozen block, so locking one segment of a long task left the rest unplanned.
 */
function withoutFrozenMinutes(input: PlanningInput): PlanningInput {
  const frozen = new Map<string, number>();
  for (const block of input.frozenBlocks)
    frozen.set(block.taskId, (frozen.get(block.taskId) ?? 0) + (Date.parse(block.end) - Date.parse(block.start)) / 60_000);
  if (!frozen.size) return input;
  return { ...input, tasks: input.tasks.flatMap((task) => {
    const done = frozen.get(task.id);
    if (done === undefined) return [task];
    const left = Math.round(durationOf(task) - done);
    if (task.interruptible === false || left < 15) return [];
    return [{ ...task, estimate: { ...task.estimate, p25Minutes: left, p50Minutes: left, p85Minutes: left } }];
  }) };
}

async function optimize(original: PlanningInput, emergency = false, trySolver = true, options: SolveOptions = {}): Promise<PlanResult> {
  const input = withoutFrozenMinutes(original);
  const tasks = input.tasks;
  const slots = freeSlots(input);
  const currentSlot = slots.findIndex((slot) => slot.day === input.currentDay);
  // Nothing to place is not a solver failure, and saying 「优化器未给出可用解」 over an empty week made a
  // correct plan read as broken. Tasks with no free time at all is a third, different situation.
  if (!tasks.length) return { ...greedyFallback(input, tasks, slots, emergency), solver: "empty" };
  if (!slots.length) return { ...greedyFallback(input, tasks, slots, emergency), solver: "no_capacity" };
  if (!trySolver) return greedyFallback(input, tasks, slots, emergency);

  const params = paramsFor(input);
  const gap = emergency ? 0 : params.gapMinutes;
  const share = emergency ? 1 : params.maxDailyShare;
  const rest = Math.max(REST_MINUTES, gap);
  const choices: Choice[] = [];
  const rows: string[] = [];
  const binary = tasks.map((_, i) => `a${i}`);
  const progress = tasks.map((task, i) => task.deadlineTier === 3 && !task.deadline && !task.floorOnly &&
    task.interruptible !== false && durationOf(task) > 45 ? `p${i}` : undefined);
  binary.push(...progress.filter((name): name is string => Boolean(name)));
  const general: string[] = [];
  const bounds: string[] = [];
  const dayCapacity = new Map<string, number>();
  for (const slot of slots) dayCapacity.set(slot.day, (dayCapacity.get(slot.day) ?? 0) + (slot.end - slot.start) / 60_000);

  for (const [i, task] of tasks.entries()) {
    const duration = durationOf(task);
    const split = task.interruptible !== false;
    for (const [s, slot] of slots.entries()) {
      const frozenDependencyEnd = Math.max(0, ...(task.dependsOn ?? []).flatMap((id) =>
        input.frozenBlocks.filter((block) => block.taskId === id).map((block) => Date.parse(block.end))));
      if (slot.start < frozenDependencyEnd) continue;
      // Waiting for something to arrive: a slot that opens before the release date is not offered at all.
      if (task.notBefore && slot.start < Date.parse(task.notBefore)) continue;
      const short = shortfall(task, slot);
      if (!usable(task, short)) continue;
      const efficiency = EFFICIENCY[short]!;
      // Wall minutes the whole task would take here.
      const wall = wallMinutes(duration, efficiency);
      const end = Math.min(slot.end, task.deadline ? Date.parse(task.deadline) : Infinity);
      // Short sessions with rests where the slot is short of the energy needed, and the focus cap: one task gets at most that long in a
      // slot and the rest goes to another.
      const cap = sessionCap(task, short);
      const maximum = Math.min(fitting(Math.floor((end - slot.start) / 60_000), cap, rest), split && params.focusCapMinutes ? params.focusCapMinutes : Infinity);
      if (maximum < (split ? Math.min(wall, MIN_SEGMENT) : wall)) continue;
      const presence = `x${i}_${s}`;
      binary.push(presence);
      if (split) {
        const minutes = `m${i}_${s}`;
        // More than one session may be needed here: k rests, at least minutes/cap − 1, each taking `rest` minutes of the slot.
        const rests = Math.min(wall, maximum) > cap ? `k${i}_${s}` : undefined;
        choices.push({ task: i, slot: s, presence, minutes, duration, maximum: Math.min(wall, maximum), efficiency, short, cap, ...(rests ? { rests } : {}) });
        general.push(minutes);
        if (rests) {
          general.push(rests);
          bounds.push(`0 <= ${rests} <= ${Math.ceil(Math.min(wall, maximum) / cap) - 1}`);
          rows.push(`rests_${i}_${s}: ${cap} ${rests} - ${minutes} >= -${cap}`);
        }
        bounds.push(`0 <= ${minutes} <= ${Math.min(wall, maximum)}`);
        rows.push(`link_hi_${i}_${s}: ${minutes} - ${Math.min(wall, maximum)} ${presence} <= 0`);
        rows.push(`link_lo_${i}_${s}: ${minutes} - ${Math.min(wall, MIN_SEGMENT)} ${presence} >= 0`);
      } else choices.push({ task: i, slot: s, presence, duration: wall, maximum, efficiency, short, cap });
    }
    const own = choices.filter((choice) => choice.task === i);
    // Work done, weighted by each slot's efficiency; whole minutes in a weaker slot can overshoot by under one, so the row is a band.
    const done = expression([
      ...own.map((choice): [number, string] => [split ? choice.efficiency : 1, choice.minutes ?? choice.presence]),
      [-(split ? duration : 1), `a${i}`],
      ...(progress[i] ? [[-45, progress[i]!] as [number, string]] : [])
    ]);
    // A task every one of whose slots yields a full hour keeps the exact row it always had (and so the solver's same answer).
    if (split && own.some((choice) => choice.efficiency < 1)) {
      rows.push(`assign_${i}: ${done} >= 0`);
      rows.push(`assign_cap_${i}: ${done} <= 1`);
    } else rows.push(`assign_${i}: ${done} = 0`);
    if (progress[i]) rows.push(`progress_or_complete_${i}: a${i} + ${progress[i]} <= 1`);
  }

  const weekly = new Map<string, number[]>();
  for (const [i, task] of tasks.entries()) {
    if (task.deadlineTier !== 3 || task.deadline || task.floorOnly) continue;
    const key = task.milestoneId ?? task.id;
    weekly.set(key, [...(weekly.get(key) ?? []), i]);
  }
  let weeklyIndex = 0;
  const weeklyNames: string[] = [];
  for (const indices of weekly.values()) {
    const name = `g${weeklyIndex++}`;
    weeklyNames.push(name);
    binary.push(name);
    const selected: Array<[number, string]> = indices.flatMap((i) => [
      [1, `a${i}`] as [number, string],
      ...(progress[i] ? [[1, progress[i]!] as [number, string]] : [])
    ]);
    rows.push(`weekly_on_${name}: ${expression([...selected, [-1, name]])} >= 0`);
    rows.push(`weekly_off_${name}: ${expression([...selected, [-indices.length, name]])} <= 0`);
  }

  for (const [s, slot] of slots.entries()) {
    const own = choices.filter((choice) => choice.slot === s);
    if (!own.length) continue;
    // Work in several sessions also takes the rests between them.
    const terms: Array<[number, string]> = own.flatMap((choice) => choice.minutes
      ? [[1, choice.minutes] as [number, string], [gap, choice.presence] as [number, string], ...(choice.rests ? [[rest, choice.rests] as [number, string]] : [])]
      : [[choice.duration + gap, choice.presence] as [number, string]]);
    rows.push(`slot_${s}: ${expression(terms)} <= ${Math.floor((slot.end - slot.start) / 60_000) + gap}`);
  }
  for (const [j, task] of tasks.entries()) {
    for (const id of task.dependsOn ?? []) {
      const i = tasks.findIndex((item) => item.id === id);
      if (i < 0) continue;
      rows.push(`dep_select_${i}_${j}: a${j} - a${i} <= 0`);
      for (const earlier of choices.filter((choice) => choice.task === j)) {
        for (const later of choices.filter((choice) => choice.task === i && choice.slot > earlier.slot)) {
          rows.push(`dep_time_${i}_${j}_${later.slot}_${earlier.slot}: ${later.presence} + ${earlier.presence} <= 1`);
        }
      }
    }
  }
  if (share < 1) {
    bounds.push("0 <= peak <= 1");
    for (const [day, capacity] of dayCapacity) {
      const own = choices.filter((choice) => slots[choice.slot]!.day === day);
      const terms: Array<[number, string]> = own.map((choice) => [choice.minutes ? 1 : choice.duration,
        choice.minutes ?? choice.presence]);
      const key = day.replaceAll("-", "");
      rows.push(`daily_${key}: ${expression(terms)} <= ${Math.floor(capacity * share)}`);
      rows.push(`peak_${key}: ${expression([...terms, [-capacity, "peak"]])} <= 0`);
    }
  }

  const n = tasks.length + 1;
  const objective: Array<[number, string]> = tasks.map((task, i) => [taskValue(task, n), `a${i}`]);
  for (const name of weeklyNames) objective.push([n * n, name]);
  // Line floors: `f` counts a line's minutes in the next seven days up to its share, and a whole floor is worth n² — as much as keeping
  // one milestone moving this week, far below any deadline (n⁴).
  const weekEnd = input.now.getTime() + 7 * 86_400_000;
  const weekMinutes = slots.filter((slot) => slot.start < weekEnd).reduce((sum, slot) => sum + (Math.min(slot.end, weekEnd) - slot.start) / 60_000, 0);
  for (const [k, [line, percent]] of Object.entries(input.lineShares ?? {}).entries()) {
    const floor = Math.round(Math.min(100, Math.max(0, percent)) / 100 * weekMinutes);
    const terms: Array<[number, string]> = choices.filter((choice) => tasks[choice.task]!.identityId === line && slots[choice.slot]!.start < weekEnd)
      .map((choice) => [choice.minutes ? 1 : choice.duration, choice.minutes ?? choice.presence]);
    if (floor < MIN_SEGMENT || !terms.length) continue;
    bounds.push(`0 <= f${k} <= ${floor}`);
    rows.push(`floor_${k}: ${expression([[1, `f${k}`], ...terms.map(([value, name]): [number, string] => [-value, name])])} <= 0`);
    objective.push([n * n / floor, `f${k}`]);
  }
  if (share < 1) objective.push([-.1, "peak"]);
  for (const choice of choices) {
    objective.push([
      (input.currentEnergy && choice.slot === currentSlot &&
        tasks[choice.task]!.energy === input.currentEnergy ? .01 : 0)
      - (params.gapMinutes === 0 && params.maxDailyShare >= 1 ? .0001 * choice.slot / slots.length : .00001)
      - (choice.minutes ? 0 : SHORT_COST_PER_MINUTE * choice.short * choice.duration), choice.presence]);
    // A minute short of the energy needed costs a little, so a matching hour is taken first; never more than placing the work is worth.
    if (choice.minutes && choice.short) objective.push([-SHORT_COST_PER_MINUTE * choice.short, choice.minutes]);
  }
  const model = ["Maximize", `score: ${expression(objective)}`, "Subject To", ...rows,
    "Bounds", ...bounds, "Binaries", ...binary, ...(general.length ? ["Generals", ...general] : []), "End"].join("\n");

  try {
    const limit = options.timeLimitSeconds ?? 2;
    const result = typeof options.solver === "function" ? await options.solver(model, limit)
      : (await highsReady).solve(model, { output_flag: false, time_limit: limit });
    if (result.Status !== "Optimal" && result.Status !== "Time limit reached")
      return greedyFallback(input, tasks, slots, emergency);
    const columns = result.Columns as Record<string, { Primal?: number }>;
    if (!columns || !Object.keys(columns).length ||
      (result.Status === "Time limit reached" && !tasks.some((_, i) => valueOf(columns, `a${i}`) > .5 ||
        Boolean(progress[i] && valueOf(columns, progress[i]!) > .5))))
      return greedyFallback(input, tasks, slots, emergency);
    const blocks: ScheduleBlock[] = input.frozenBlocks.map((block) => ({ ...block, frozen: true }));
    for (const [s, slot] of slots.entries()) {
      const picked = choices.filter((choice) => choice.slot === s && valueOf(columns, choice.presence) > .5)
        .sort((a, b) => tasks[a.task]!.dependsOn?.includes(tasks[b.task]!.id) ? 1
          : tasks[b.task]!.dependsOn?.includes(tasks[a.task]!.id) ? -1
            : input.currentEnergy && s === currentSlot &&
              (tasks[a.task]!.energy === input.currentEnergy) !== (tasks[b.task]!.energy === input.currentEnergy)
              ? tasks[a.task]!.energy === input.currentEnergy ? -1 : 1
            : compareTasks(tasks[a.task]!, tasks[b.task]!));
      let cursor = slot.start;
      for (const choice of picked) {
        // The solver's continuous answer is often exactly a half minute, and its last digits are numerical noise
        // (25.4999999 on one run, 25.5000001 on the next). Rounding that directly made the same plan 25 minutes
        // long on one run and 26 on the next; a half is rounded up, noise or not.
        const minutes = choice.minutes ? Math.round(valueOf(columns, choice.minutes) + 1e-6) : choice.duration;
        if (minutes <= 0) continue;
        const progressOnly = Boolean(progress[choice.task] && valueOf(columns, progress[choice.task]!) > .5);
        sessions(minutes, choice.cap).forEach((length, index) => {
          if (index) cursor += rest * 60_000;
          blocks.push({ taskId: tasks[choice.task]!.id, start: new Date(cursor).toISOString(),
            end: new Date(cursor + length * 60_000).toISOString(), ...(choice.efficiency < 1 ? { efficiency: choice.efficiency } : {}),
            ...(progressOnly ? { progressOnly: true } : {}) });
          cursor += length * 60_000;
        });
        cursor += gap * 60_000;
      }
    }
    if (!validBlocks(blocks, slots, input, gap)) return greedyFallback(input, tasks, slots, emergency);
    const solved = makeResult(input, tasks, slots, blocks, result.Status === "Optimal" ? "optimal" : "feasible_time_limit");
    if (result.Status === "Optimal") return solved;
    // Out of time, the solver hands back whatever it had, which can be far worse than the greedy pass: on the real account it gave the
    // afternoon to line-share filler and left the homework due that night unplaced. The two are compared on the solver's own terms.
    const greedy = greedyFallback(input, tasks, slots, emergency);
    return worth(greedy, tasks) > worth(solved, tasks) ? greedy : solved;
  } catch {
    return greedyFallback(input, tasks, slots, emergency);
  }
}

/** The greedy pass alone, as used when the solver gives no usable answer; exported so its rules can be tested directly. */
export function fallbackSchedule(input: PlanningInput): PlanResult {
  return greedyFallback(input, input.tasks, freeSlots(input));
}

export async function planSchedule(original: PlanningInput, options: SolveOptions = {}): Promise<PlanResult> {
  const { input, notes } = clampContinuousBuffers(original);
  const result = await schedule(input, options);
  return notes.length ? { ...result, notes } : result;
}

async function schedule(input: PlanningInput, options: SolveOptions): Promise<PlanResult> {
  const slots = freeSlots(input);
  const lookaheadSlots = input.lookaheadAvailability
    ? freeSlots({ ...input, availability: input.lookaheadAvailability }) : slots;
  const beyondHorizon = (task: PlannerTask) => Boolean(input.lookaheadAvailability && task.deadline
    && Date.parse(task.deadline) > (lookaheadSlots.at(-1)?.end ?? input.now.getTime()));
  const latestStart = (task: PlannerTask): number => {
    const deadline = Date.parse(task.deadline!);
    let remaining = durationOf(task);
    for (const slot of [...lookaheadSlots].reverse()) {
      const end = Math.min(slot.end, deadline);
      const room = Math.max(0, Math.floor((end - slot.start) / 60_000));
      if (task.interruptible === false) {
        if (room >= remaining) return end - remaining * 60_000;
      } else {
        remaining -= room;
        if (remaining <= 0) return slot.start + -remaining * 60_000;
      }
    }
    return input.now.getTime();
  };
  const deferred = input.tasks.filter((task) => task.deadlineTier === 4 &&
    (!task.deadline || beyondHorizon(task) || latestStart(task) > input.now.getTime()));
  const eligible = { ...input, tasks: input.tasks.filter((task) => !deferred.includes(task)) };
  // The deadline buffer: work is aimed to finish this many days early, only where that day is still ahead. The relaxed run below
  // uses the real deadlines, so a buffer never makes a deadline impossible.
  const params = paramsFor(input);
  const buffered = params.deadlineBufferDays ? { ...eligible, tasks: eligible.tasks.map((task) => {
    if (!task.deadline) return task;
    const early = Date.parse(task.deadline) - params.deadlineBufferDays * 86_400_000;
    return early > input.now.getTime() ? { ...task, deadline: new Date(early).toISOString() } : task;
  }) } : eligible;
  const first = await optimize(buffered, false, options.solver !== "none", options);
  let result = first;
  const relaxable = params.gapMinutes > 0 || params.maxDailyShare < 1 || params.deadlineBufferDays > 0;
  if (relaxable && first.blockers.some((blocker) => eligible.tasks.some((task) =>
    task.id === blocker.taskId && task.deadline))) {
    // The relaxation is for the work with a deadline only (and what it waits on): that is placed first without the gap and the daily
    // share, then everything else is placed around it on the person's own packing rules. Relaxing the whole plan packed a day from
    // 09:00 to 22:50 without a break with undated work, because one homework needed the room.
    // Unless the solver finished this model in time, both passes are the greedy pass: the same model again would spend another two
    // seconds of every page load and run out of time all the same (105 tasks, ~9,500 rows on the real account).
    const urgent = new Set(eligible.tasks.filter((task) => task.deadline).map((task) => task.id));
    for (let grew = true; grew;) {
      grew = false;
      for (const task of eligible.tasks) if (urgent.has(task.id)) for (const id of task.dependsOn ?? [])
        if (!urgent.has(id) && eligible.tasks.some((item) => item.id === id)) { urgent.add(id); grew = true; }
    }
    const solverFits = first.solver === "optimal";
    const pressed = await optimize({ ...eligible, tasks: eligible.tasks.filter((task) => urgent.has(task.id)) }, true, solverFits, options);
    const placedFirst = pressed.plan.blocks.filter((block) => !block.frozen);
    const around = await optimize({ ...buffered, tasks: buffered.tasks.filter((task) => !urgent.has(task.id)),
      frozenBlocks: [...eligible.frozenBlocks, ...placedFirst.map(({ taskId, start, end }) => ({ taskId, start, end }))] }, false, solverFits, options);
    const blocks = [...eligible.frozenBlocks.map((block) => ({ ...block, frozen: true })), ...placedFirst,
      ...around.plan.blocks.filter((block) => !block.frozen)].sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    const blockers = [...pressed.blockers, ...around.blockers];
    const relaxed: PlanResult = { status: statusFor(blocks, blockers, eligible.frozenBlocks.length), plan: { blocks }, blockers, solver: pressed.solver };
    const hardPlaced = (value: PlanResult) => eligible.tasks.filter((task) => task.deadline &&
      value.plan.blocks.some((block) => block.taskId === task.id)).length;
    if (hardPlaced(relaxed) > hardPlaced(first)) result = { ...relaxed, bufferRelaxed: true };
  }
  if (!deferred.length) return result;
  const blockers = [...result.blockers, ...deferred.map((task) => ({ taskId: task.id,
    code: !task.deadline ? "Q4_NEEDS_DATE_OR_PROMOTION"
      : beyondHorizon(task) ? "Q4_BEYOND_FORECAST_HORIZON" : "Q4_WAITING_LATEST_START",
    message: task.deadline ? beyondHorizon(task) ? `${task.title}的截止日期超出 8 周预测窗口，暂不唤醒`
      : `${task.title}暂缓；按剩余可用时间计算，最迟 ${new Date(latestStart(task)).toISOString()} 开工`
      : `${task.title}暂无已确认截止时间；请补日期或手动提升重要性` }))];
  return { ...result, blockers, status: statusFor(result.plan.blocks, blockers, input.frozenBlocks.length) };
}
