import "server-only";
import { planSchedule, type ModelSolver, type PlanningInput, type PlanResult } from "@crossline/planner";
import type { AccessContext } from "@crossline/core";
import { getStore } from "./crossline";

/**
 * The page shows the greedy plan at once and the optimal one when it is ready (docs/loop-and-scout.md §2). The optimal plan is solved
 * in the background — on the solver thread, up to 20 seconds — and cached under the hash of the planner's input, so the next read of
 * the same input gets it without solving. Only the background writes this setting; it is never written inside an impact preview.
 */
export const OPTIMAL_SETTING = "schedule.optimal";
export const OPTIMAL_TIME_LIMIT_SECONDS = 20;

/**
 * Bumped whenever the planner's answer for the same input can change (a fixed solver or validator): the cache is keyed on the input,
 * so without this a result from before a fix — the fallback the half-frozen-step bug forced (2026-10-13) — is served forever.
 */
export const OPTIMAL_VERSION = 2;
export type OptimalEntry = { hash: string; result: PlanResult; at: string; version?: number };

/** The cached plan for this input, or nothing. Blocks already over are the caller's to drop. */
export function optimalFor(ctx: AccessContext, hash: string): OptimalEntry | undefined {
  try {
    const entry = JSON.parse(getStore().getSetting(ctx.workspaceId, OPTIMAL_SETTING) ?? "") as OptimalEntry;
    return entry?.hash === hash && entry.version === OPTIMAL_VERSION && entry.result?.plan ? entry : undefined;
  } catch {
    return undefined;
  }
}

type Job = { ctx: AccessContext; input: PlanningInput; hash: string };
const running = new Map<string, string>();
const queued = new Map<string, Job>();
const listeners: Array<(workspaceId: string) => void> = [];
/** When each workspace's latest input was first asked for: the calendar waits up to a minute for its optimal plan. */
const requested = new Map<string, { hash: string; at: number }>();
let solver: ModelSolver | undefined;
// Off under vitest and e2e (their plans must not change under them mid-test) and on the hosted beta, whose 2 GB server cannot spare
// a HiGHS thread beside everyone's model runs (2026-10-16): there every schedule is the greedy pass. `CROSSLINE_BACKGROUND_SOLVE=on|off`
// overrides either way.
let enabled = process.env.CROSSLINE_BACKGROUND_SOLVE ? process.env.CROSSLINE_BACKGROUND_SOLVE !== "off"
  : !process.env.VITEST && !process.env.CROSSLINE_E2E_DATA_DIR && process.env.CROSSLINE_PUBLIC_BETA !== "1";

/** Tests: switch the background solve on with a solver of their own (or off). */
export function configureOptimal(options: { enabled: boolean; solver?: ModelSolver }): void {
  enabled = options.enabled;
  solver = options.solver;
}

/** Called after an optimal plan is written — the calendar publishes it at once (docs/loop-and-scout.md §2). */
export function onOptimalWritten(listener: (workspaceId: string) => void): void {
  listeners.push(listener);
}

async function defaultSolver(): Promise<ModelSolver> {
  return solver ?? (await import("./solver-pool")).solveInThread;
}

async function run(job: Job): Promise<void> {
  const { workspaceId } = job.ctx;
  running.set(workspaceId, job.hash);
  const started = Date.now();
  try {
    const result = await planSchedule(job.input, { solver: await defaultSolver(), timeLimitSeconds: OPTIMAL_TIME_LIMIT_SECONDS });
    getStore().setSetting(workspaceId, OPTIMAL_SETTING, JSON.stringify({ hash: job.hash, result, at: new Date().toISOString(), version: OPTIMAL_VERSION } satisfies OptimalEntry));
    console.info(JSON.stringify({ type: "solver.optimal", workspaceId, ms: Date.now() - started, solver: result.solver }));
    for (const listener of listeners) {
      try { listener(workspaceId); } catch { /* a listener's failure is its own */ }
    }
  } catch (error) {
    console.warn(JSON.stringify({ type: "solver.optimal_failed", workspaceId, message: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
  } finally {
    running.delete(workspaceId);
    const next = queued.get(workspaceId);
    queued.delete(workspaceId);
    if (next) void run(next);
  }
}

/**
 * Asks for the optimal plan of this input. One solve per workspace at a time; while one runs, a newer request replaces whatever was
 * waiting, so only the latest input is solved next. Nothing is queued for an input already cached or already being solved.
 */
export function requestOptimal(ctx: AccessContext, input: PlanningInput, hash: string): void {
  if (!enabled) return;
  const { workspaceId } = ctx;
  if (requested.get(workspaceId)?.hash !== hash) requested.set(workspaceId, { hash, at: Date.now() });
  if (running.get(workspaceId) === hash || optimalFor(ctx, hash)) return;
  if (running.has(workspaceId)) {
    queued.set(workspaceId, { ctx, input, hash });
    return;
  }
  void run({ ctx, input, hash });
}

/** How long ago this input was first asked for, while its optimal plan is not cached yet; undefined once cached or never asked. */
export function optimalWaitingMs(ctx: AccessContext, hash: string): number | undefined {
  if (optimalFor(ctx, hash)) return undefined;
  const asked = requested.get(ctx.workspaceId);
  return asked?.hash === hash ? Date.now() - asked.at : undefined;
}

/** Tests: wait until nothing is running or waiting. */
export async function optimalIdle(): Promise<void> {
  while (running.size || queued.size) await new Promise((resolve) => setTimeout(resolve, 5));
}
