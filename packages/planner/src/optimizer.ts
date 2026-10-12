import { compareTasks, paramsFor, type PlanBlocker, type PlanResult, type PlannerTask, type PlanningInput, type ScheduleBlock } from "./index";
import { createRequire } from "node:module";

// Keep HiGHS outside the Next server bundle so its loader finds highs.wasm beside itself.
const loadHighs = createRequire(import.meta.url)("highs") as typeof import("highs").default;

type Slot = { start: number; end: number; energy: "low" | "medium" | "high"; day: string };
type Choice = { task: number; slot: number; presence: string; minutes?: string; duration: number; maximum: number };
const energyRank = { low: 1, medium: 2, high: 3 } as const;
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
      (task.energy && !slots.some((slot) => start >= slot.start && end <= slot.end &&
        energyRank[slot.energy] >= energyRank[task.energy!]))) return false;
  }
  for (const task of input.tasks) {
    const own = sorted.filter((block) => block.taskId === task.id);
    if (!own.length) continue;
    const expected = own.some((block) => block.progressOnly) ? 45 : durationOf(task);
    if (own.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0)
      !== expected) return false;
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
  for (const task of ordered) {
    if ((task.dependsOn ?? []).some((id) => tasks.some((item) => item.id === id) &&
      !blocks.some((block) => block.taskId === id))) continue;
    const candidate = [...cursors];
    const nextUsed = new Map(dayUsed);
    const staged: ScheduleBlock[] = [];
    let left = durationOf(task);
    for (let s = 0; s < slots.length && left > 0; s += 1) {
      const slot = slots[s]!;
      if (task.energy && energyRank[slot.energy] < energyRank[task.energy]) continue;
      const prior = [...blocks, ...staged].at(-1);
      const dependencyEnd = Math.max(0, ...(task.dependsOn ?? []).flatMap((id) =>
        blocks.filter((block) => block.taskId === id).map((block) => Date.parse(block.end))));
      const start = Math.max(candidate[s]!, dependencyEnd, task.notBefore ? Date.parse(task.notBefore) : 0,
        prior ? Date.parse(prior.end) + gap * 60_000 : slot.start);
      const until = Math.min(slot.end, task.deadline ? Date.parse(task.deadline) : Infinity);
      const remainingCap = share >= 1 ? Infinity
        : Math.floor((dayCapacity.get(slot.day) ?? 0) * share) - (nextUsed.get(slot.day) ?? 0);
      const focusCap = task.interruptible !== false && params.focusCapMinutes ? params.focusCapMinutes : Infinity;
      const minutes = Math.min(left, Math.floor((until - start) / 60_000), remainingCap, focusCap);
      if (minutes < (task.interruptible === false ? left : Math.min(left, MIN_SEGMENT))) continue;
      staged.push({ taskId: task.id, start: new Date(start).toISOString(),
        end: new Date(start + minutes * 60_000).toISOString() });
      candidate[s] = start + (minutes + gap) * 60_000;
      nextUsed.set(slot.day, (nextUsed.get(slot.day) ?? 0) + minutes);
      left -= minutes;
      if (task.interruptible === false) break;
    }
    if (left === 0) { blocks.push(...staged); cursors.splice(0, cursors.length, ...candidate);
      dayUsed.clear(); for (const [day, minutes] of nextUsed) dayUsed.set(day, minutes); }
  }
  return makeResult(input, tasks, slots, blocks, "fallback");
}

async function optimize(input: PlanningInput, emergency = false): Promise<PlanResult> {
  const frozenIds = new Set(input.frozenBlocks.map((block) => block.taskId));
  const tasks = input.tasks.filter((task) => !frozenIds.has(task.id));
  const slots = freeSlots(input);
  const currentSlot = slots.findIndex((slot) => slot.day === input.currentDay);
  // Nothing to place is not a solver failure, and saying 「优化器未给出可用解」 over an empty week made a
  // correct plan read as broken. Tasks with no free time at all is a third, different situation.
  if (!tasks.length) return { ...greedyFallback(input, tasks, slots, emergency), solver: "empty" };
  if (!slots.length) return { ...greedyFallback(input, tasks, slots, emergency), solver: "no_capacity" };

  const params = paramsFor(input);
  const gap = emergency ? 0 : params.gapMinutes;
  const share = emergency ? 1 : params.maxDailyShare;
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
      if (task.energy && energyRank[slot.energy] < energyRank[task.energy]) continue;
      const end = Math.min(slot.end, task.deadline ? Date.parse(task.deadline) : Infinity);
      // The focus cap: one task gets at most this long in a slot, and the rest goes to another slot.
      const maximum = Math.min(Math.floor((end - slot.start) / 60_000), split && params.focusCapMinutes ? params.focusCapMinutes : Infinity);
      if (maximum < (split ? Math.min(duration, MIN_SEGMENT) : duration)) continue;
      const presence = `x${i}_${s}`;
      binary.push(presence);
      if (split) {
        const minutes = `m${i}_${s}`;
        choices.push({ task: i, slot: s, presence, minutes, duration, maximum: Math.min(duration, maximum) });
        general.push(minutes);
        bounds.push(`0 <= ${minutes} <= ${Math.min(duration, maximum)}`);
        rows.push(`link_hi_${i}_${s}: ${minutes} - ${Math.min(duration, maximum)} ${presence} <= 0`);
        rows.push(`link_lo_${i}_${s}: ${minutes} - ${Math.min(duration, MIN_SEGMENT)} ${presence} >= 0`);
      } else choices.push({ task: i, slot: s, presence, duration, maximum });
    }
    const own = choices.filter((choice) => choice.task === i);
    rows.push(`assign_${i}: ${expression([
      ...own.map((choice): [number, string] => [1, choice.minutes ?? choice.presence]),
      [-(split ? duration : 1), `a${i}`],
      ...(progress[i] ? [[-45, progress[i]!] as [number, string]] : [])
    ])} = 0`);
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
    const terms: Array<[number, string]> = own.flatMap((choice) => choice.minutes
      ? [[1, choice.minutes] as [number, string], [gap, choice.presence] as [number, string]]
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
  // Urgency first (the deadline tier, lexicographic as before), then importance inside a tier: the weight moves a task by less than a
  // whole tier, so a heavier task never outranks one in a more urgent tier. Library work earns nothing of its own.
  const objective: Array<[number, string]> = tasks.map((task, i) => [task.floorOnly ? 0
    : (task.deadline ? n ** 4 : 0) + ((4 - task.deadlineTier) + .9 * (task.weight ?? 50) / 100) * n + (task.inputsReady ? 1 : 0), `a${i}`
  ]);
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
  for (const choice of choices) objective.push([
    (input.currentEnergy && choice.slot === currentSlot &&
      tasks[choice.task]!.energy === input.currentEnergy ? .01 : 0)
    - (params.gapMinutes === 0 && params.maxDailyShare >= 1 ? .0001 * choice.slot / slots.length : .00001), choice.presence]);
  const model = ["Maximize", `score: ${expression(objective)}`, "Subject To", ...rows,
    "Bounds", ...bounds, "Binaries", ...binary, ...(general.length ? ["Generals", ...general] : []), "End"].join("\n");

  try {
    const highs = await highsReady;
    const result = highs.solve(model, { output_flag: false, time_limit: 2 });
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
        const end = cursor + minutes * 60_000;
        blocks.push({ taskId: tasks[choice.task]!.id, start: new Date(cursor).toISOString(),
          end: new Date(end).toISOString(),
          ...(progress[choice.task] && valueOf(columns, progress[choice.task]!) > .5
            ? { progressOnly: true } : {}) });
        cursor = end + gap * 60_000;
      }
    }
    if (!validBlocks(blocks, slots, input, gap)) return greedyFallback(input, tasks, slots, emergency);
    return makeResult(input, tasks, slots, blocks, result.Status === "Optimal" ? "optimal" : "feasible_time_limit");
  } catch {
    return greedyFallback(input, tasks, slots, emergency);
  }
}

export async function planSchedule(original: PlanningInput): Promise<PlanResult> {
  const { input, notes } = clampContinuousBuffers(original);
  const result = await schedule(input);
  return notes.length ? { ...result, notes } : result;
}

async function schedule(input: PlanningInput): Promise<PlanResult> {
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
  const first = await optimize(buffered);
  let result = first;
  // The relaxed run also lets work with a deadline take a slot one energy level lower (high work in a medium slot): a tired hour
  // beats a missed deadline. Every step of a homework inherits the task's 「high」, and a day has three high hours, so a homework due
  // tomorrow got nothing at all while those hours went to work with no deadline.
  const lower = { high: "medium", medium: "low", low: "low" } as const;
  const energyRelaxed = { ...eligible, tasks: eligible.tasks.map((task) => task.deadline && task.energy ? { ...task, energy: lower[task.energy] } : task) };
  const relaxable = params.gapMinutes > 0 || params.maxDailyShare < 1 || params.deadlineBufferDays > 0
    || eligible.tasks.some((task) => task.deadline && task.energy && task.energy !== "low");
  if (relaxable && first.blockers.some((blocker) => eligible.tasks.some((task) =>
    task.id === blocker.taskId && task.deadline))) {
    const relaxed = await optimize(energyRelaxed, true);
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
