import { expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { memoByLedger, memoByLedgerAsync } from "./ledger-memo";

test("a derived value is reused until the ledger changes, and computed again after any write", () => {
  const store = new CrosslineStore(":memory:");
  let runs = 0;
  const read = () => memoByLedger(store, "k", 60_000, () => ++runs);
  expect([read(), read()]).toEqual([1, 1]);
  store.setSetting("ws", "x", "1");
  expect(read()).toBe(2);
  store.close();
});

test("a write that lands while the value is being computed is not swallowed: the next read computes again", async () => {
  const store = new CrosslineStore(":memory:");
  let runs = 0;
  // As the background solver did: it wrote its plan while the schedule was being derived from the state before it.
  const derive = () => memoByLedgerAsync(store, "plan", 60_000, async () => {
    runs += 1;
    if (runs === 1) store.setSetting("ws", "schedule.optimal", "written meanwhile");
    return runs;
  });
  expect(await derive()).toBe(1);
  expect(await derive()).toBe(2);
  expect(await derive()).toBe(2);
  store.close();
});

test("requests that arrive while a value is computed share the one computation", async () => {
  const store = new CrosslineStore(":memory:");
  let runs = 0;
  const derive = () => memoByLedgerAsync(store, "shared", 60_000, async () => { runs += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return runs; });
  expect(await Promise.all([derive(), derive(), derive()])).toEqual([1, 1, 1]);
  store.close();
});

test("a value older than its time limit is computed again even with no write", () => {
  vi.useFakeTimers();
  const store = new CrosslineStore(":memory:");
  let runs = 0;
  const read = () => memoByLedger(store, "t", 30_000, () => ++runs);
  read();
  vi.advanceTimersByTime(31_000);
  expect(read()).toBe(2);
  vi.useRealTimers();
  store.close();
});
