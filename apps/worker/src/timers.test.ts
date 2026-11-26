import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { runtimeOwner } from "./owner";
import { createWorkerTimers } from "./timers";

afterEach(() => { vi.useRealTimers(); });

describe("worker timers and the one-shot exit", () => {
  // The order the smoke run hit: the ledger closed, then the form watcher's 30-second beat read it.
  it("a clock left running reads a closed ledger", () => {
    vi.useFakeTimers();
    const store = new CrosslineStore(":memory:");
    const timers = createWorkerTimers();
    timers.every(() => { runtimeOwner(store); }, 30_000);
    store.close();
    expect(() => vi.advanceTimersByTime(30_000)).toThrow(/database connection is not open/);
    timers.stop();
  });

  it("stopping the clocks before the close leaves nothing to fire", () => {
    vi.useFakeTimers();
    const store = new CrosslineStore(":memory:");
    const timers = createWorkerTimers();
    const beat = vi.fn(() => { runtimeOwner(store); });
    timers.every(beat, 30_000);
    timers.every(beat, 60_000);
    timers.stop();
    store.close();
    expect(() => vi.advanceTimersByTime(5 * 60_000)).not.toThrow();
    expect(beat).not.toHaveBeenCalled();
    expect(() => timers.every(beat, 1_000)).toThrow("WORKER_TIMERS_STOPPED");
  });

  // A discovery guard, like csrf-protection.test.ts: a clock added to index.ts before the one-shot exit without going through
  // workerTimers would fire after the close again, so the source is read rather than trusted.
  it("index.ts starts no bare interval before the one-shot exit, and that exit stops clocks and listeners before the ledger", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const exitAt = source.indexOf("await tick({ waitForWorkspaces");
    expect(exitAt).toBeGreaterThan(0);
    expect(source.slice(0, exitAt).match(/\bsetInterval\(/g) ?? []).toEqual([]);
    const exit = source.slice(exitAt, source.indexOf("} else {", exitAt));
    const at = (text: string) => exit.indexOf(text);
    expect(at("workerTimers.stop()")).toBeGreaterThan(0);
    expect(at("modelGateway.close()")).toBeGreaterThan(0);
    expect(at("analysisStore.close()")).toBeGreaterThan(at("workerTimers.stop()"));
    expect(at("analysisStore.close()")).toBeGreaterThan(at("modelGateway.close()"));
    expect(at("analysisStore.close()")).toBeGreaterThan(at("nodeHub?.close()"));
  });
});
