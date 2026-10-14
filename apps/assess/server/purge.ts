import { purgeExpired } from "./store";

/**
 * The 90-day retention (docs/beta-launch.md §6): expired results are removed when the server starts and every hour after. Reads already
 * treat an expired result as gone, so the hour between runs never shows one.
 */

export const PURGE_INTERVAL_MS = 60 * 60_000;

let timer: ReturnType<typeof setInterval> | undefined;

export function runPurge(now = new Date()): number {
  try {
    const removed = purgeExpired(now);
    if (removed) console.info(JSON.stringify({ event: "assess.purged", removed }));
    return removed;
  } catch (error) {
    console.error(JSON.stringify({ event: "assess.purge_failed", error: error instanceof Error ? error.message : String(error) }));
    return 0;
  }
}

/** Starts the schedule once per process. */
export function startPurgeSchedule(): void {
  if (timer) return;
  runPurge();
  timer = setInterval(() => runPurge(), PURGE_INTERVAL_MS);
  timer.unref();
}

export function stopPurgeSchedule(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
