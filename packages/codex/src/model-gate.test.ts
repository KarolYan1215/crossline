import { afterEach, expect, test } from "vitest";
import { clientBusy, configureModelGate, markClientBusy, modelGateLimit, priorityForSkill, resetModelGate, withModelSlot } from "./model-gate";

afterEach(() => resetModelGate());

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

test("the hosted beta runs two model turns at a time; elsewhere there is no limit unless one is set", () => {
  expect(modelGateLimit({ CROSSLINE_PUBLIC_BETA: "1" })).toBe(2);
  expect(modelGateLimit({})).toBe(Number.POSITIVE_INFINITY);
  expect(modelGateLimit({ CROSSLINE_PUBLIC_BETA: "1", CROSSLINE_MODEL_CONCURRENCY: "1" })).toBe(1);
  expect(priorityForSkill("crossline:crossline-onboarding")).toBe("interactive");
  expect(priorityForSkill("crossline:crossline-milestone-architect")).toBe("background");
});

test("with one slot, runs wait in line, a person's interview goes before background work, and each waiter hears what is ahead", async () => {
  configureModelGate({ limit: 1, log: () => {} });
  const order: string[] = [];
  const told: Record<string, number[]> = { b: [], c: [], i: [] };
  const first = deferred();
  const running = withModelSlot({ skill: "crossline-milestone-architect" }, async () => { order.push("a"); await first.promise; });
  const b = withModelSlot({ skill: "crossline-backplanner", onQueued: (ahead) => told.b!.push(ahead) }, async () => { order.push("b"); });
  const c = withModelSlot({ skill: "crossline-portrait-writer", onQueued: (ahead) => told.c!.push(ahead) }, async () => { order.push("c"); });
  const i = withModelSlot({ skill: "crossline-onboarding", onQueued: (ahead) => told.i!.push(ahead) }, async () => { order.push("i"); });
  await tick();
  expect(order).toEqual(["a"]);
  // The interview jumped the two background runs: one run in progress ahead of it.
  expect(told.i).toEqual([1]);
  expect(told.b).toEqual([1, 2]);
  expect(told.c).toEqual([2, 3]);
  first.resolve();
  await Promise.all([running, b, c, i]);
  expect(order).toEqual(["a", "i", "b", "c"]);
});

test("above the memory high-water mark nothing new starts while a run is going; idle runtimes are reclaimed meanwhile", async () => {
  let used = 900;
  let reclaimed = 0;
  configureModelGate({ limit: 2, probe: () => ({ used, limit: 1000 }), reclaim: () => { reclaimed += 1; }, pollMs: 5, log: () => {} });
  const first = deferred();
  const order: string[] = [];
  const a = withModelSlot({ skill: "x" }, async () => { order.push("a"); await first.promise; });
  await tick();
  // Memory was already high, but nothing was running: the first run waits up to the limit, so it has not started yet either.
  expect(order).toEqual([]);
  used = 500;
  await tick();
  expect(order).toEqual(["a"]);
  used = 900;
  const b = withModelSlot({ skill: "y" }, async () => { order.push("b"); });
  await tick();
  expect(order).toEqual(["a"]);
  expect(reclaimed).toBeGreaterThan(0);
  first.resolve();
  await a;
  used = 400;
  await b;
  expect(order).toEqual(["a", "b"]);
});

test("with nothing running and memory that never drops, the next run goes after the wait instead of stopping the service", async () => {
  const events: Array<Record<string, unknown>> = [];
  configureModelGate({ limit: 1, probe: () => ({ used: 990, limit: 1000 }), pollMs: 5, maxMemoryWaitMs: 30, log: (event) => events.push(event) });
  let ran = false;
  await withModelSlot({ skill: "x" }, async () => { ran = true; });
  expect(ran).toBe(true);
  expect(events.some((event) => event.type === "model.gate.memory_forced")).toBe(true);
});

test("a run cancelled while it waits leaves the line without running; a runtime with a run in flight is busy", async () => {
  configureModelGate({ limit: 1, log: () => {} });
  const first = deferred();
  const a = withModelSlot({ skill: "x" }, () => first.promise);
  const controller = new AbortController();
  let ran = false;
  const b = withModelSlot({ skill: "y", signal: controller.signal }, async () => { ran = true; });
  controller.abort();
  expect(await b).toBeUndefined();
  first.resolve();
  await a;
  expect(ran).toBe(false);

  const client = {};
  markClientBusy(client, 1);
  expect(clientBusy(client)).toBe(true);
  markClientBusy(client, -1);
  expect(clientBusy(client)).toBe(false);
});
