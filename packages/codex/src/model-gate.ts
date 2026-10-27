/**
 * One gate for every model run in this process (decided 2026-10-16, after the hosted beta's 2 GB server froze with one person on it:
 * milestone design, a portrait rewrite and a figure ran at once). Slower is acceptable, falling over is not, so:
 *
 * - At most `CROSSLINE_MODEL_CONCURRENCY` runs at a time across every account and tier (default 2 on the hosted beta — two people's
 *   turns at once, the memory mark below holding back a third process — no limit elsewhere). The rest wait in one queue; work a person is waiting on (the interview, the input box) goes before background work.
 * - `CROSSLINE_MODEL_INTERACTIVE_RESERVE` slots (default 1 on the hosted beta, 0 elsewhere) are kept for that work: background runs
 *   never hold more than `limit − reserve`, so a person who sends a line waits for at most the runs of other people, never behind a
 *   milestone design that took every slot (decided 2026-10-17).
 * - While the process uses more than `CROSSLINE_MEMORY_HIGH_WATER` (75%) of its memory ceiling, nothing new starts: a run already
 *   going finishes first, idle runtimes are reclaimed, and only after a minute of that with nothing running does the next run go anyway
 *   (a reading that never drops must not stop the service for good).
 * - Memory held for a heavy job outside the gate (the collection's browser, `reserved`) counts as in use for background work, and while
 *   any is held nothing is started past the mark by that minute's rule: the room was promised to the job (2026-10-23, after the browser
 *   was killed twice by the container's ceiling). A person's turn is measured on what is really in use.
 * - An account with compute nodes connected (docs/compute-node.md) has their capacity on top of its share and of the background limit
 *   (`extraCapacity`): those runs go to the nodes, not to this process. While a node has room (`nodeRoom`) the account's next run is not
 *   held by this process's memory either, since it will not use it.
 * - Each waiter is told how many runs are ahead of it, so a page can say 「排队中，前面还有 N 个」.
 *
 * Who goes next (decided with the owner on 2026-10-19, docs/model-scheduling.md):
 * - A person's turn starts at once while memory is below the mark, whatever else runs: the slots count background work only; above the
 *   mark it waits first in line.
 * - Background work of one account holds at most `CROSSLINE_ACCOUNT_CONCURRENCY` (2) slots, and accounts take turns within a priority, so
 *   one person approving twelve milestones does not fill every slot ahead of another person's capture.
 * - Background work goes in three priorities: intake (what arrived is read and recorded), then planning, then everything else
 *   (preparation: tutorials, research, the assistant) — `INTAKE_SKILLS`, `PLANNING_SKILLS` (2026-10-21).
 * - Within a priority and an account the shorter job goes first, by the Skill's recent service times here; anything that has waited
 *   `AGING_MS` (15 minutes) moves up one priority, and again after every further 15, so nothing waits for ever.
 */

export type ModelPriority = "interactive" | "intake" | "planning" | "background";
/** Bytes in use (without reclaimable page cache) and the ceiling they are measured against. */
export type MemoryReading = { used: number; limit: number };

/** Skills a person is looking at a spinner for. Everything else is background and waits behind them. */
export const INTERACTIVE_SKILLS: readonly string[] = ["crossline-onboarding", "crossline-concierge"];
/**
 * Background Skills that take in what arrived — new mail, a capture, calendar events, an authorized folder, a recording's transcript, the
 * interview's replies — and record it. Information first, then planning, then preparation (the owner, 2026-10-21: 「整个系统的逻辑是先获取
 * 信息再进行规划和准备」; mail sorting had not run once while 20 step plans and 43 tutorial runs went ahead): a plan made before the mail
 * that changes it is read is made twice. They wait behind a person's turn and still count as background for the slot kept for a person.
 */
export const INTAKE_SKILLS: readonly string[] = ["crossline-mail-triage", "crossline-automation-stripper", "crossline-calendar-classifier",
  "crossline-folder-classifier", "crossline-recording-digest", "crossline-onboarding-extract", "crossline-background-facts"];
/**
 * Background Skills that turn what the person just did (approved milestones, a finished interview, an analysed capture) into work on their
 * board. They go after intake and before discretionary runs (tutorials, research, the assistant): after 12 milestones were approved the
 * first task took 22 minutes, queued behind web research and tutorials nobody was waiting for (2026-10-17 walkthrough, W-28).
 */
export const PLANNING_SKILLS: readonly string[] = ["crossline-goal-backplanner", "crossline-step-planner", "crossline-milestone-architect",
  "crossline-artifact-planner"];
const named = (list: readonly string[], skillName: string) => list.some((name) => skillName === name || skillName.endsWith(`:${name}`));
export const priorityForSkill = (skillName: string): ModelPriority =>
  named(INTERACTIVE_SKILLS, skillName) ? "interactive" : named(INTAKE_SKILLS, skillName) ? "intake"
    : named(PLANNING_SKILLS, skillName) ? "planning" : "background";
const RANK: Record<ModelPriority, number> = { interactive: 0, intake: 1, planning: 2, background: 3 };

export function modelGateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CROSSLINE_MODEL_CONCURRENCY);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return env.CROSSLINE_PUBLIC_BETA === "1" ? 2 : Number.POSITIVE_INFINITY;
}

/**
 * Other accounts' Codex processes kept up at once on the hosted beta (`CROSSLINE_GUEST_RUNTIMES`): as many as model runs may go at once,
 * so a free model slot is never left idle for want of a runtime. Undefined elsewhere (the registry's own default).
 */
export function guestRuntimeLimit(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = Number(env.CROSSLINE_GUEST_RUNTIMES);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return env.CROSSLINE_PUBLIC_BETA === "1" ? modelGateLimit(env) : undefined;
}

export function interactiveReserve(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CROSSLINE_MODEL_INTERACTIVE_RESERVE);
  if (env.CROSSLINE_MODEL_INTERACTIVE_RESERVE?.trim() && Number.isInteger(raw) && raw >= 0) return raw;
  return env.CROSSLINE_PUBLIC_BETA === "1" ? 1 : 0;
}

/** Background runs one account may hold at once (`CROSSLINE_ACCOUNT_CONCURRENCY`, default 2; the owner's decision of 2026-10-19). */
export function accountConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CROSSLINE_ACCOUNT_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 2;
}

/** A waiter moves up one priority after waiting this long, and again after as long again. */
export const AGING_MS = 15 * 60_000;
/** What a Skill not yet seen here is assumed to take, for ordering only. */
const DEFAULT_SERVICE_MS = 60_000;
/** Recent service times kept per Skill: enough for a median, short enough to follow a model change. */
const SERVICE_SAMPLES = 20;

export function memoryHighWater(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CROSSLINE_MEMORY_HIGH_WATER);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.75;
}

type GateConfig = {
  limit: number;
  /** Background runs one account may hold at once. */
  perTenant: number;
  /** Tenants held to another limit (the developer's model being measured is no person's account: it may use the whole background share). */
  tenantLimits?: Record<string, number>;
  agingMs: number;
  /** Slots background runs may not take (kept for interactive ones); never below one slot for background. */
  reserve: number;
  highWater: number;
  probe?: () => MemoryReading | undefined;
  /** Bytes promised to heavy jobs outside the gate and not yet taken by them (apps/worker/src/memory.ts `heldMemory`). */
  reserved?: () => number;
  /** Runs an account's compute nodes take at once (added to its share and to the background limit). */
  extraCapacity?: (tenant: string) => number;
  /** Whether an account's compute nodes have room now, so its next run will not run in this process. */
  nodeRoom?: (tenant: string) => boolean;
  /** Frees what can be freed (idle runtimes) while memory is high. */
  reclaim?: () => void;
  /** With nothing running and memory still high this long, the next run goes anyway. */
  maxMemoryWaitMs: number;
  pollMs: number;
  now: () => number;
  log: (event: Record<string, unknown>) => void;
};

type Waiter = { skill: string; priority: ModelPriority; tenant: string; seq: number; queuedAt: number; grant: () => void;
  onQueued?: (ahead: number) => void; told?: number };

let config: GateConfig = defaults();
let active = 0;
let activeBackground = 0;
let seq = 0;
let waiters: Waiter[] = [];
/** Background runs in flight per account, and when each account was last given a slot (a counter, for taking turns). */
const activeByTenant = new Map<string, number>();
const lastServed = new Map<string, number>();
let served = 0;
/** Recent service times per Skill (milliseconds), newest last. */
const serviceTimes = new Map<string, number[]>();
let blockedSince: number | undefined;
let reclaimedAt: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function defaults(): GateConfig {
  return { limit: modelGateLimit(), perTenant: accountConcurrency(), agingMs: AGING_MS, reserve: interactiveReserve(), highWater: memoryHighWater(),
    maxMemoryWaitMs: 60_000, pollMs: 5_000, now: Date.now, log: (event) => console.info(JSON.stringify(event)) };
}

/** The worker sets the memory probe and the reclaimer; tests set everything and reset with `resetModelGate`. */
export function configureModelGate(options: Partial<GateConfig>): void {
  config = { ...config, ...options };
  pump();
}

export function resetModelGate(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (agingTimer) clearTimeout(agingTimer);
  agingTimer = undefined;
  config = defaults();
  active = 0;
  activeBackground = 0;
  waiters = [];
  activeByTenant.clear();
  lastServed.clear();
  served = 0;
  serviceTimes.clear();
  blockedSince = undefined;
  reclaimedAt = undefined;
}

export function modelGateStatus(): { active: number; queued: number; limit: number; memory?: MemoryReading } {
  const memory = readMemory();
  return { active, queued: waiters.length, limit: config.limit, ...(memory ? { memory } : {}) };
}

function readMemory(): MemoryReading | undefined {
  try { return config.probe?.(); } catch { return undefined; }
}

/** Over the mark: for background work (and a new runtime process) memory promised to a heavy job counts as in use; for a person's turn it does not. */
function memoryHigh(background = true): boolean {
  const reading = readMemory();
  return Boolean(reading && reading.limit > 0 && (reading.used + (background ? reservedBytes() : 0)) / reading.limit >= config.highWater);
}

function extraFor(tenant: string): number {
  try { return Math.max(0, config.extraCapacity?.(tenant.replace(/#.*$/, "")) ?? 0); } catch { return 0; }
}
function roomOnNode(tenant: string): boolean {
  try { return Boolean(config.nodeRoom?.(tenant.replace(/#.*$/, ""))); } catch { return false; }
}

function reservedBytes(): number {
  try { return Math.max(0, config.reserved?.() ?? 0); } catch { return 0; }
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = undefined; pump(); }, config.pollMs);
  // A waiting queue must not keep a finished process (or a test run) alive on its own.
  (timer as { unref?: () => void }).unref?.();
}

/** The Skill's median recent service time here, or a minute when it has not run yet. */
export function expectedServiceMs(skill: string): number {
  const times = serviceTimes.get(skill);
  if (!times?.length) return DEFAULT_SERVICE_MS;
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
function recordService(skill: string, ms: number): void {
  const times = serviceTimes.get(skill) ?? [];
  times.push(ms);
  if (times.length > SERVICE_SAMPLES) times.shift();
  serviceTimes.set(skill, times);
}

/** A waiter's priority after aging: one step up for every `agingMs` it has waited. */
const effectiveRank = (waiter: Waiter, now: number) =>
  Math.max(0, RANK[waiter.priority] - Math.floor((now - waiter.queuedAt) / Math.max(1, config.agingMs)));

/**
 * The order waiters are considered in: a person's turn first (first come, first served among them), then by aged priority, then the
 * account served longest ago, then the shorter expected job, then arrival.
 */
function ordered(now: number): Waiter[] {
  return [...waiters].sort((a, b) => {
    const ai = a.priority === "interactive" ? 0 : 1, bi = b.priority === "interactive" ? 0 : 1;
    if (ai !== bi) return ai - bi;
    if (ai === 0) return a.seq - b.seq;
    return effectiveRank(a, now) - effectiveRank(b, now)
      || (lastServed.get(a.tenant) ?? 0) - (lastServed.get(b.tenant) ?? 0)
      || expectedServiceMs(a.skill) - expectedServiceMs(b.skill)
      || a.seq - b.seq;
  });
}

function tellPositions(): void {
  if (!waiters.some((waiter) => waiter.onQueued)) return;
  const high = memoryHigh(false);
  ordered(config.now()).forEach((waiter, index) => {
    // A person's turn waits only for memory, behind other people's turns; background work waits behind background runs going and
    // everything ahead of it in line (a person's turn takes no background slot).
    const ahead = waiter.priority === "interactive" ? index + (high ? active : 0) : activeBackground + index;
    if (waiter.told === ahead) return;
    waiter.told = ahead;
    try { waiter.onQueued?.(ahead); } catch { /* a page's bookkeeping must never stop the queue */ }
  });
}

/** How many background runs may hold a slot at once: the limit less the reserve, but at least one. */
function backgroundLimit(): number {
  return Number.isFinite(config.limit) ? Math.max(1, config.limit - config.reserve) : config.limit;
}

/**
 * Whether a waiter may start now, slots and its account's share considered (memory is checked apart). A person's turn takes no slot, so
 * background work counts only background runs: the memory mark is what bounds the two together.
 */
function eligible(waiter: Waiter): boolean {
  if (waiter.priority === "interactive") return true;
  const extra = extraFor(waiter.tenant);
  return activeBackground < backgroundLimit() + extra && (activeByTenant.get(waiter.tenant) ?? 0) < (config.tenantLimits?.[waiter.tenant] ?? config.perTenant) + extra;
}

function pump(): void {
  for (;;) {
    const now = config.now();
    const next = ordered(now).find(eligible);
    if (!next) break;
    if (memoryHigh(next.priority !== "interactive") && !roomOnNode(next.tenant)) {
      blockedSince ??= now;
      if (config.reclaim && (reclaimedAt === undefined || now - reclaimedAt >= config.pollMs * 6)) {
        reclaimedAt = now;
        try { config.reclaim(); } catch { /* best effort */ }
      }
      // Something is running: its end is the likeliest thing to free memory, so wait for it (and poll meanwhile).
      if (active > 0 || now - blockedSince < config.maxMemoryWaitMs || (next.priority !== "interactive" && reservedBytes() > 0)) {
        if (now - blockedSince < config.pollMs) config.log({ type: "model.gate.memory_wait", active, queued: waiters.length, memory: readMemory() });
        schedule();
        break;
      }
      config.log({ type: "model.gate.memory_forced", waitedMs: now - blockedSince, memory: readMemory() });
    }
    blockedSince = undefined;
    waiters.splice(waiters.indexOf(next), 1);
    active += 1;
    if (next.priority !== "interactive") {
      activeBackground += 1;
      activeByTenant.set(next.tenant, (activeByTenant.get(next.tenant) ?? 0) + 1);
      lastServed.set(next.tenant, ++served);
    }
    const waitedMs = now - next.queuedAt;
    if (waitedMs > 0) config.log({ type: "model.gate", skill: next.skill, priority: next.priority, waitedMs, queued: waiters.length });
    // A waiter that was told it had runs ahead hears 0 when its own run starts, so a page stops saying it is queued.
    if (next.told) { try { next.onQueued?.(0); } catch { /* bookkeeping only */ } }
    next.grant();
  }
  // Aging moves a waiter up while nothing finishes: look again after a while even when nothing else would wake the queue.
  if (waiters.some((waiter) => waiter.priority !== "interactive")) scheduleAging();
  tellPositions();
}

let agingTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAging(): void {
  if (agingTimer) return;
  agingTimer = setTimeout(() => { agingTimer = undefined; pump(); }, Math.min(config.agingMs, 60_000));
  (agingTimer as { unref?: () => void }).unref?.();
}

/**
 * Runs `run` once a slot is free. `onQueued` hears how many runs are ahead each time that changes while it waits, and 0 when a run that
 * had to wait starts. A run aborted
 * by `signal` before it got a slot leaves the queue and resolves to `undefined` without running.
 */
export async function withModelSlot<T>(input: { skill: string; priority?: ModelPriority; onQueued?: (ahead: number) => void; signal?: AbortSignal;
  /** The account the run is for (accounts take turns and each holds at most `perTenant` background slots). */
  tenant?: string;
  /** Hears how long the run waited for its slot, once it has one. */
  onGranted?: (waitedMs: number) => void },
  run: () => Promise<T>): Promise<T | undefined> {
  const priority = input.priority ?? priorityForSkill(input.skill);
  const tenant = input.tenant || "-";
  const queuedAt = config.now();
  const granted = await new Promise<boolean>((resolve) => {
    const waiter: Waiter = { skill: input.skill, priority, tenant, seq: ++seq, queuedAt,
      grant: () => { input.signal?.removeEventListener("abort", onAbort); resolve(true); }, ...(input.onQueued ? { onQueued: input.onQueued } : {}) };
    function onAbort() {
      const index = waiters.indexOf(waiter);
      if (index < 0) return;
      waiters.splice(index, 1);
      tellPositions();
      resolve(false);
    }
    if (input.signal?.aborted) { resolve(false); return; }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    // The order is worked out each time a slot frees (`ordered`), so a waiter only has to join the queue.
    waiters.push(waiter);
    pump();
  });
  if (!granted) return undefined;
  const startedAt = config.now();
  try { input.onGranted?.(startedAt - queuedAt); } catch { /* bookkeeping only */ }
  try { return await run(); }
  finally {
    recordService(input.skill, config.now() - startedAt);
    active -= 1;
    if (priority !== "interactive") {
      activeBackground -= 1;
      const held = (activeByTenant.get(tenant) ?? 1) - 1;
      if (held > 0) activeByTenant.set(tenant, held); else activeByTenant.delete(tenant);
    }
    pump();
  }
}

/** Waits (polling) while memory is above the high-water mark, at most `maxMs`; used before starting another runtime process. */
export async function waitForMemory(maxMs = 60_000): Promise<boolean> {
  const started = config.now();
  while (memoryHigh()) {
    if (config.now() - started >= maxMs) return false;
    try { config.reclaim?.(); } catch { /* best effort */ }
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
  return true;
}

/**
 * Runs in flight per runtime client. A runtime is reclaimed after ten idle minutes on the hosted beta, which is shorter than a Skill's
 * own stall limit (20 minutes): a turn that is thinking quietly must not lose its process, so a client with a run in flight is never idle.
 */
const inFlight = new WeakMap<object, number>();
export function markClientBusy(client: object, delta: 1 | -1): void {
  inFlight.set(client, Math.max(0, (inFlight.get(client) ?? 0) + delta));
}
export const clientBusy = (client: object): boolean => (inFlight.get(client) ?? 0) > 0;
