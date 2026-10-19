import { afterEach, expect, test } from "vitest";
import { accountConcurrency, clientBusy, configureModelGate, guestRuntimeLimit, interactiveReserve, markClientBusy, modelGateLimit, priorityForSkill, resetModelGate, withModelSlot } from "./model-gate";

afterEach(() => resetModelGate());

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

test("the hosted beta runs two model turns at a time; elsewhere there is no limit unless one is set", () => {
  expect(modelGateLimit({ CROSSLINE_PUBLIC_BETA: "1" })).toBe(2);
  expect(modelGateLimit({})).toBe(Number.POSITIVE_INFINITY);
  expect(modelGateLimit({ CROSSLINE_PUBLIC_BETA: "1", CROSSLINE_MODEL_CONCURRENCY: "1" })).toBe(1);
  expect(priorityForSkill("crossline:crossline-onboarding")).toBe("interactive");
  // Guest runtimes follow the model slots on the hosted beta unless set themselves (the 4 GB host sets both to 4).
  expect(guestRuntimeLimit({ CROSSLINE_PUBLIC_BETA: "1" })).toBe(2);
  expect(guestRuntimeLimit({ CROSSLINE_PUBLIC_BETA: "1", CROSSLINE_MODEL_CONCURRENCY: "4" })).toBe(4);
  expect(guestRuntimeLimit({ CROSSLINE_PUBLIC_BETA: "1", CROSSLINE_MODEL_CONCURRENCY: "4", CROSSLINE_GUEST_RUNTIMES: "3" })).toBe(3);
  expect(guestRuntimeLimit({})).toBeUndefined();
  expect(priorityForSkill("crossline:crossline-milestone-architect")).toBe("planning");
  expect(priorityForSkill("crossline:crossline-due-diligence")).toBe("background");
});

test("with one slot, background runs wait in line and hear what is ahead; a person's turn starts at once while memory allows", async () => {
  configureModelGate({ limit: 1, log: () => {} });
  const order: string[] = [];
  const told: Record<string, number[]> = { b: [], c: [] };
  const first = deferred();
  const running = withModelSlot({ skill: "crossline-milestone-architect" }, async () => { order.push("a"); await first.promise; });
  const b = withModelSlot({ skill: "crossline-backplanner", onQueued: (ahead) => told.b!.push(ahead) }, async () => { order.push("b"); });
  const c = withModelSlot({ skill: "crossline-portrait-writer", onQueued: (ahead) => told.c!.push(ahead) }, async () => { order.push("c"); });
  const i = withModelSlot({ skill: "crossline-onboarding" }, async () => { order.push("i"); });
  await tick();
  // The interview did not wait for the one slot: slots count background work only (2026-10-19).
  expect(order).toEqual(["a", "i"]);
  expect(told.b).toEqual([1]);
  expect(told.c).toEqual([2]);
  first.resolve();
  await Promise.all([running, b, c, i]);
  expect(order).toEqual(["a", "i", "b", "c"]);
});

test("above the memory mark a person's turn waits first in line, ahead of every background run", async () => {
  let used = 900;
  configureModelGate({ limit: 3, probe: () => ({ used, limit: 1000 }), pollMs: 5, maxMemoryWaitMs: 10_000, log: () => {} });
  const order: string[] = [];
  used = 100;
  const first = deferred();
  const a = withModelSlot({ skill: "x", tenant: "w1" }, async () => { order.push("a"); await first.promise; });
  await tick();
  used = 900;
  const b = withModelSlot({ skill: "y", tenant: "w2" }, async () => { order.push("b"); });
  const told: number[] = [];
  const i = withModelSlot({ skill: "crossline-concierge", tenant: "w3", onQueued: (ahead) => told.push(ahead) }, async () => { order.push("i"); });
  await tick();
  expect(order).toEqual(["a"]);
  // Waiting for memory: the one run going is ahead of the person, the background run is not.
  expect(told[0]).toBe(1);
  first.resolve();
  await a;
  used = 100;
  await Promise.all([b, i]);
  expect(order).toEqual(["a", "i", "b"]);
});

test("accounts take turns within a priority, and one account holds at most its share of background slots", async () => {
  configureModelGate({ limit: 4, perTenant: 2, log: () => {} });
  const order: string[] = [];
  const gate = deferred();
  const runs = [
    ...["w1-a", "w1-b", "w1-c", "w1-d"].map((name) => withModelSlot({ skill: "crossline-step-planner", tenant: "w1" }, async () => { order.push(name); await gate.promise; })),
    withModelSlot({ skill: "crossline-step-planner", tenant: "w2" }, async () => { order.push("w2-a"); await gate.promise; })
  ];
  await tick();
  // Four slots, but the first account holds only two of them, and the second account's run did not wait behind its backlog.
  expect(order.sort()).toEqual(["w1-a", "w1-b", "w2-a"]);
  gate.resolve();
  await Promise.all(runs);
  expect(order).toHaveLength(5);
});

test("within one account the shorter job goes first, and a long wait moves a run up a priority", async () => {
  let now = 0;
  configureModelGate({ limit: 1, agingMs: 1000, now: () => now, log: () => {} });
  // Teach the gate how long each Skill takes: the classifier is quick, the planner slow.
  await withModelSlot({ skill: "crossline-calendar-classifier" }, async () => { now += 5; });
  await withModelSlot({ skill: "crossline-material-writer" }, async () => { now += 500; });
  const order: string[] = [];
  const first = deferred();
  const running = withModelSlot({ skill: "hold" }, async () => { await first.promise; });
  const slow = withModelSlot({ skill: "crossline-material-writer" }, async () => { order.push("slow"); });
  const quick = withModelSlot({ skill: "crossline-calendar-classifier" }, async () => { order.push("quick"); });
  first.resolve();
  await Promise.all([running, slow, quick]);
  expect(order).toEqual(["quick", "slow"]);

  // A discretionary run that has waited past the aging time goes before a planning run that just arrived.
  const order2: string[] = [];
  const second = deferred();
  const hold = withModelSlot({ skill: "hold" }, async () => { await second.promise; });
  const research = withModelSlot({ skill: "crossline:crossline-due-diligence" }, async () => { order2.push("research"); });
  now += 1500;
  const backplan = withModelSlot({ skill: "crossline:crossline-goal-backplanner" }, async () => { order2.push("backplan"); });
  second.resolve();
  await Promise.all([hold, research, backplan]);
  expect(order2).toEqual(["research", "backplan"]);
  expect(accountConcurrency({})).toBe(2);
  expect(accountConcurrency({ CROSSLINE_ACCOUNT_CONCURRENCY: "3" })).toBe(3);
});

test("planning work goes before discretionary background work, behind a person's turn, and still leaves the person's slot free", async () => {
  configureModelGate({ limit: 2, reserve: 1, log: () => {} });
  const order: string[] = [];
  const first = deferred();
  const running = withModelSlot({ skill: "crossline:crossline-due-diligence" }, async () => { order.push("research"); await first.promise; });
  const tutorial = withModelSlot({ skill: "crossline:crossline-material-researcher" }, async () => { order.push("tutorial"); });
  const backplan = withModelSlot({ skill: "crossline:crossline-goal-backplanner" }, async () => { order.push("backplan"); });
  await tick();
  // The free slot is the person's: neither background run takes it.
  expect(order).toEqual(["research"]);
  first.resolve();
  await Promise.all([running, tutorial, backplan]);
  expect(order).toEqual(["research", "backplan", "tutorial"]);
});

test("on the hosted beta one slot is kept for a person: background work never takes every slot", async () => {
  expect(interactiveReserve({ CROSSLINE_PUBLIC_BETA: "1" })).toBe(1);
  expect(interactiveReserve({})).toBe(0);
  expect(interactiveReserve({ CROSSLINE_PUBLIC_BETA: "1", CROSSLINE_MODEL_INTERACTIVE_RESERVE: "0" })).toBe(0);
  configureModelGate({ limit: 2, reserve: 1, log: () => {} });
  const order: string[] = [];
  const first = deferred();
  const a = withModelSlot({ skill: "crossline-milestone-architect" }, async () => { order.push("a"); await first.promise; });
  const b = withModelSlot({ skill: "crossline-backplanner" }, async () => { order.push("b"); });
  await tick();
  // The second background run waits although a slot is free: that slot belongs to the person.
  expect(order).toEqual(["a"]);
  const second = deferred();
  const i = withModelSlot({ skill: "crossline-concierge" }, async () => { order.push("i"); await second.promise; });
  await tick();
  expect(order).toEqual(["a", "i"]);
  first.resolve();
  await a;
  await tick();
  // A background slot freed: the waiting background run takes it while the person's turn still runs.
  expect(order).toEqual(["a", "i", "b"]);
  second.resolve();
  await Promise.all([b, i]);
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

test("a person's turns running do not keep background work from its slots", async () => {
  configureModelGate({ limit: 2, reserve: 1, log: () => {} });
  const order: string[] = [];
  const hold = deferred();
  const people = [withModelSlot({ skill: "crossline-onboarding", tenant: "w1" }, async () => { order.push("i1"); await hold.promise; }),
    withModelSlot({ skill: "crossline-concierge", tenant: "w2" }, async () => { order.push("i2"); await hold.promise; })];
  const background = withModelSlot({ skill: "crossline-step-planner", tenant: "w3" }, async () => { order.push("b"); await hold.promise; });
  await tick();
  expect(order).toEqual(["i1", "i2", "b"]);
  hold.resolve();
  await Promise.all([...people, background]);
});
