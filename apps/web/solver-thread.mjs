// HiGHS off the request thread (docs/loop-and-scout.md §2). Loaded by `lib/solver-pool.ts` as a plain file, outside the Next bundle,
// so `highs` finds its wasm beside itself. One model at a time: a message is { id, model, limit }, the answer { id, result } or { id, error }.
import { parentPort } from "node:worker_threads";
import highsLoader from "highs";

const ready = highsLoader();
parentPort.on("message", async ({ id, model, limit }) => {
  try {
    const highs = await ready;
    parentPort.postMessage({ id, result: highs.solve(model, { output_flag: false, time_limit: limit }) });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
