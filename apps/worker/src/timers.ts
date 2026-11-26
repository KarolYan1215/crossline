/**
 * The worker's own repeating background clocks, kept in one place so the one-shot run can stop them before it closes the ledger.
 *
 * They are unref'd, so on their own they never keep the process alive — but anything else that does (the model gateway's listening
 * socket was one) lets them fire after `analysisStore.close()`, and the first one that read the ledger ended the smoke run with
 * 「The database connection is not open」. `stop()` clears every handle, so none can fire after the ledger is gone, whatever else
 * still holds the event loop.
 */
export type WorkerTimers = {
  /** `setInterval(run, ms).unref()`, remembered until `stop()`. */
  every: (run: () => void, ms: number) => NodeJS.Timeout;
  /** Clears every remembered handle; a clock added after this is refused, since nothing would stop it. */
  stop: () => void;
};

export function createWorkerTimers(): WorkerTimers {
  const handles = new Set<NodeJS.Timeout>();
  let stopped = false;
  return {
    every: (run, ms) => {
      if (stopped) throw new Error("WORKER_TIMERS_STOPPED");
      const handle = setInterval(run, ms).unref();
      handles.add(handle);
      return handle;
    },
    stop: () => {
      stopped = true;
      for (const handle of handles) clearInterval(handle);
      handles.clear();
    }
  };
}
