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
 * - Each waiter is told how many runs are ahead of it, so a page can say 「排队中，前面还有 N 个」.
 */

export type ModelPriority = "interactive" | "background";
/** Bytes in use (without reclaimable page cache) and the ceiling they are measured against. */
export type MemoryReading = { used: number; limit: number };

/** Skills a person is looking at a spinner for. Everything else is background and waits behind them. */
export const INTERACTIVE_SKILLS: readonly string[] = ["crossline-onboarding", "crossline-concierge"];
export const priorityForSkill = (skillName: string): ModelPriority =>
  INTERACTIVE_SKILLS.some((name) => skillName === name || skillName.endsWith(`:${name}`)) ? "interactive" : "background";

export function modelGateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CROSSLINE_MODEL_CONCURRENCY);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return env.CROSSLINE_PUBLIC_BETA === "1" ? 2 : Number.POSITIVE_INFINITY;
}

export function interactiveReserve(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CROSSLINE_MODEL_INTERACTIVE_RESERVE);
  if (env.CROSSLINE_MODEL_INTERACTIVE_RESERVE?.trim() && Number.isInteger(raw) && raw >= 0) return raw;
  return env.CROSSLINE_PUBLIC_BETA === "1" ? 1 : 0;
}

export function memoryHighWater(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CROSSLINE_MEMORY_HIGH_WATER);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.75;
}

type GateConfig = {
  limit: number;
  /** Slots background runs may not take (kept for interactive ones); never below one slot for background. */
  reserve: number;
  highWater: number;
  probe?: () => MemoryReading | undefined;
  /** Frees what can be freed (idle runtimes) while memory is high. */
  reclaim?: () => void;
  /** With nothing running and memory still high this long, the next run goes anyway. */
  maxMemoryWaitMs: number;
  pollMs: number;
  now: () => number;
  log: (event: Record<string, unknown>) => void;
};

type Waiter = { skill: string; priority: ModelPriority; seq: number; queuedAt: number; grant: () => void; onQueued?: (ahead: number) => void; told?: number };

let config: GateConfig = defaults();
let active = 0;
let activeBackground = 0;
let seq = 0;
let waiters: Waiter[] = [];
let blockedSince: number | undefined;
let reclaimedAt: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function defaults(): GateConfig {
  return { limit: modelGateLimit(), reserve: interactiveReserve(), highWater: memoryHighWater(), maxMemoryWaitMs: 60_000, pollMs: 5_000, now: Date.now,
    log: (event) => console.info(JSON.stringify(event)) };
}

/** The worker sets the memory probe and the reclaimer; tests set everything and reset with `resetModelGate`. */
export function configureModelGate(options: Partial<GateConfig>): void {
  config = { ...config, ...options };
  pump();
}

export function resetModelGate(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  config = defaults();
  active = 0;
  activeBackground = 0;
  waiters = [];
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

function memoryHigh(): boolean {
  const reading = readMemory();
  return Boolean(reading && reading.limit > 0 && reading.used / reading.limit >= config.highWater);
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = undefined; pump(); }, config.pollMs);
  // A waiting queue must not keep a finished process (or a test run) alive on its own.
  (timer as { unref?: () => void }).unref?.();
}

function tellPositions(): void {
  waiters.forEach((waiter, index) => {
    const ahead = active + index;
    if (waiter.told === ahead) return;
    waiter.told = ahead;
    try { waiter.onQueued?.(ahead); } catch { /* a page's bookkeeping must never stop the queue */ }
  });
}

/** How many background runs may hold a slot at once: the limit less the reserve, but at least one. */
function backgroundLimit(): number {
  return Number.isFinite(config.limit) ? Math.max(1, config.limit - config.reserve) : config.limit;
}

function pump(): void {
  while (waiters.length && active < config.limit) {
    // Waiters are ordered interactive first, so a background head means only background work waits.
    if (waiters[0]!.priority === "background" && activeBackground >= backgroundLimit()) break;
    if (memoryHigh()) {
      const now = config.now();
      blockedSince ??= now;
      if (config.reclaim && (reclaimedAt === undefined || now - reclaimedAt >= config.pollMs * 6)) {
        reclaimedAt = now;
        try { config.reclaim(); } catch { /* best effort */ }
      }
      // Something is running: its end is the likeliest thing to free memory, so wait for it (and poll meanwhile).
      if (active > 0 || now - blockedSince < config.maxMemoryWaitMs) {
        if (now - blockedSince < config.pollMs) config.log({ type: "model.gate.memory_wait", active, queued: waiters.length, memory: readMemory() });
        schedule();
        break;
      }
      config.log({ type: "model.gate.memory_forced", waitedMs: now - blockedSince, memory: readMemory() });
    }
    blockedSince = undefined;
    const next = waiters.shift()!;
    active += 1;
    if (next.priority === "background") activeBackground += 1;
    const waitedMs = config.now() - next.queuedAt;
    if (waitedMs > 0) config.log({ type: "model.gate", skill: next.skill, priority: next.priority, waitedMs, queued: waiters.length });
    // A waiter that was told it had runs ahead hears 0 when its own run starts, so a page stops saying it is queued.
    if (next.told) { try { next.onQueued?.(0); } catch { /* bookkeeping only */ } }
    next.grant();
  }
  tellPositions();
}

/**
 * Runs `run` once a slot is free. `onQueued` hears how many runs are ahead each time that changes while it waits, and 0 when a run that
 * had to wait starts. A run aborted
 * by `signal` before it got a slot leaves the queue and resolves to `undefined` without running.
 */
export async function withModelSlot<T>(input: { skill: string; priority?: ModelPriority; onQueued?: (ahead: number) => void; signal?: AbortSignal },
  run: () => Promise<T>): Promise<T | undefined> {
  const priority = input.priority ?? priorityForSkill(input.skill);
  const granted = await new Promise<boolean>((resolve) => {
    const waiter: Waiter = { skill: input.skill, priority, seq: ++seq, queuedAt: config.now(),
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
    // Interactive before background; first come, first served within each.
    const at = waiters.findIndex((other) => waiter.priority === "interactive" && other.priority === "background");
    if (at < 0) waiters.push(waiter); else waiters.splice(at, 0, waiter);
    pump();
  });
  if (!granted) return undefined;
  try { return await run(); }
  finally { active -= 1; if (priority === "background") activeBackground -= 1; pump(); }
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
