import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { HighsSolution } from "@crossline/planner";

/**
 * One solver thread for the web process (docs/loop-and-scout.md §2): the background optimal solve runs HiGHS here, so a 20-second
 * solve never holds a page request. Created on first use and again after it exits; models are queued by the thread itself.
 */
let thread: Worker | undefined;
let next = 0;
const waiting = new Map<number, { resolve: (value: HighsSolution) => void; reject: (error: Error) => void }>();

/** `next start` runs in `apps/web`; vitest runs from the repo root. */
function threadFile(): string {
  const here = path.join(process.cwd(), "solver-thread.mjs");
  return existsSync(here) ? here : path.join(process.cwd(), "apps", "web", "solver-thread.mjs");
}

function solverThread(): Worker {
  if (thread) return thread;
  const created = new Worker(threadFile());
  created.unref();
  created.on("message", ({ id, result, error }: { id: number; result?: HighsSolution; error?: string }) => {
    const call = waiting.get(id);
    waiting.delete(id);
    if (error !== undefined) call?.reject(new Error(error));
    else call?.resolve(result!);
  });
  const fail = (error: Error) => {
    if (thread === created) thread = undefined;
    for (const call of waiting.values()) call.reject(error);
    waiting.clear();
  };
  created.on("error", fail);
  created.on("exit", (code) => fail(new Error(`SOLVER_THREAD_EXITED ${code}`)));
  thread = created;
  return created;
}

export function solveInThread(model: string, timeLimitSeconds: number): Promise<HighsSolution> {
  const id = next++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    solverThread().postMessage({ id, model, limit: timeLimitSeconds });
  });
}

/** Tests only: end the thread so the next call has to start a new one. */
export async function stopSolverThread(): Promise<void> {
  const current = thread;
  thread = undefined;
  await current?.terminate();
}
