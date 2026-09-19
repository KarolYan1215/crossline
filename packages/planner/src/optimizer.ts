import { compareTasks, type PlanResult, type PlannerTask, type PlanningInput, type ScheduleBlock } from "./index";
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
    for (const dependency of task.dependsOn ?? []) {
      const prerequisite = sorted.filter((block) => block.taskId === dependency);
      if (input.tasks.some((item) => item.id === dependency) && !prerequisite.length) return false;
      if (prerequisite.length && Date.parse(prerequisite.at(-1)!.end) > Date.parse(own[0]!.start)) return false;
    }
  }
  return true;
}

function makeResult(input: PlanningInput, tasks: PlannerTask[], slots: Slot[], blocks: ScheduleBlock[],
  solver: PlanResult["solver"]): PlanResult {
  const scheduled = new Set(blocks.filter((block) => !block.progressOnly).map((block) => block.taskId));
  const blockers = tasks.filter((task) => !scheduled.has(task.id)).map((task) => ({
    taskId: task.id,
    code: blocks.some((block) => block.taskId === task.id && block.progressOnly) ? "PROGRESS_ONLY"
      : task.interruptible === false ? "NO_CONTINUOUS_SLOT" : task.deadline ? "DEADLINE_CAPACITY" : "NO_CAPACITY",
    message: blocks.some((block) => block.taskId === task.id && block.progressOnly)
      ? `${task.title}本周已留 45 分钟进度，完整作业仍待排入`
      : task.interruptible === false ? `${task.title}需要连续 ${durationOf(task)} 分钟`
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
  const gap = input.mode === "asap" || emergency ? 0 : 10;
  const pending = [...tasks].sort(compareTasks);
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
      const start = Math.max(candidate[s]!, dependencyEnd,
        prior ? Date.parse(prior.end) + gap * 60_000 : slot.start);
      const until = Math.min(slot.end, task.deadline ? Date.parse(task.deadline) : Infinity);
      const remainingCap = input.mode === "asap" || emergency ? Infinity
        : Math.floor((dayCapacity.get(slot.day) ?? 0) * .85) - (nextUsed.get(slot.day) ?? 0);
      const minutes = Math.min(left, Math.floor((until - start) / 60_000), remainingCap);
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
  if (!tasks.length || !slots.length) return greedyFallback(input, tasks, slots, emergency);

  const gap = input.mode === "asap" || emergency ? 0 : 10;
  const choices: Choice[] = [];
  const rows: string[] = [];
  const binary = tasks.map((_, i) => `a${i}`);
  const progress = tasks.map((task, i) => task.deadlineTier === 3 && !task.deadline &&
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
      if (task.energy && energyRank[slot.energy] < energyRank[task.energy]) continue;
      const end = Math.min(slot.end, task.deadline ? Date.parse(task.deadline) : Infinity);
      const maximum = Math.floor((end - slot.start) / 60_000);
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
    if (task.deadlineTier !== 3 || task.deadline) continue;
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
  if (input.mode !== "asap" && !emergency) {
    bounds.push("0 <= peak <= 1");
    for (const [day, capacity] of dayCapacity) {
      const own = choices.filter((choice) => slots[choice.slot]!.day === day);
      const terms: Array<[number, string]> = own.map((choice) => [choice.minutes ? 1 : choice.duration,
        choice.minutes ?? choice.presence]);
      const key = day.replaceAll("-", "");
      rows.push(`daily_${key}: ${expression(terms)} <= ${Math.floor(capacity * .85)}`);
      rows.push(`peak_${key}: ${expression([...terms, [-capacity, "peak"]])} <= 0`);
    }
  }

  const n = tasks.length + 1;
  const objective: Array<[number, string]> = tasks.map((task, i) => [
    (task.deadline ? n ** 4 : 0) + (4 - task.deadlineTier) * n + (task.inputsReady ? 1 : 0), `a${i}`
  ]);
  for (const name of weeklyNames) objective.push([n * n, name]);
  if (input.mode !== "asap" && !emergency) objective.push([-.1, "peak"]);
  for (const choice of choices) objective.push([
    (input.currentEnergy && choice.slot === currentSlot &&
      tasks[choice.task]!.energy === input.currentEnergy ? .01 : 0)
    - (input.mode === "asap" ? .0001 * choice.slot / slots.length : .00001), choice.presence]);
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
        const minutes = choice.minutes ? Math.round(valueOf(columns, choice.minutes)) : choice.duration;
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

export async function planSchedule(input: PlanningInput): Promise<PlanResult> {
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
  const first = await optimize(eligible);
  let result = first;
  if (input.mode !== "asap" && first.blockers.some((blocker) => eligible.tasks.some((task) =>
    task.id === blocker.taskId && task.deadline))) {
    const relaxed = await optimize(eligible, true);
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
