import { afterEach, expect, test } from "vitest";
import { configureModelGate, continueSkillTurn, createRuntimePool, resetModelGate, runCodexSkill, setProviderResolver, withModelSlot,
  type CodexRpcBoundary, type PoolMember } from "@crossline/codex";
import { scriptedRuntime } from "../testing/fake-runtime";

afterEach(() => { resetModelGate(); setProviderResolver(() => undefined); });

const stub = (): CodexRpcBoundary => ({ request: async () => ({}), onNotification: () => () => {} });
const SKILL = "crossline:crossline-task-titler";
const SCHEMA = { type: "object", additionalProperties: false, properties: { titles: { type: "array", items: { type: "string" } } }, required: ["titles"] };
const run = (client: CodexRpcBoundary) => runCodexSkill(client, {}, { skillName: SKILL, cwd: "C:\\repo", developerInstructions: "x", outputSchema: SCHEMA,
  prepareInput: () => ({}), validateOutput: (output) => output as { titles: string[] }, onAudit: () => {} });
const turnOptions = { skillName: SKILL, cwd: "C:\\repo", outputSchema: SCHEMA, validateOutput: (output: unknown) => output as { titles: string[] }, onAudit: () => {} };

test("a run goes to a node with room, the linked device before the standalone node and the less loaded of a kind; with every node full, to the server", () => {
  const local = stub();
  const device = stub(), standalone = stub();
  const members: PoolMember[] = [{ id: "standalone:pc2", client: standalone, capacity: 1, priority: 1 }, { id: "device:pc", client: device, capacity: 2, priority: 2 }];
  const pool = createRuntimePool(local, () => members);
  const first = pool.bindRun();
  expect(first.member).toBe("device:pc");
  const second = pool.bindRun();
  expect(second.member).toBe("device:pc");
  // The device is full: the standalone node takes the next, then the server.
  expect(pool.bindRun().member).toBe("standalone:pc2");
  const overflow = pool.bindRun();
  expect(overflow.member).toBe("server");
  expect(overflow.client).toBe(local);
  expect(pool.load()).toEqual({ "device:pc": 2, "standalone:pc2": 1, server: 1 });
  first.release(); first.release();
  expect(pool.load()["device:pc"]).toBe(1);
  expect(pool.bindRun().member).toBe("device:pc");
  // A node's wrapper is one object per node: the runner keys its per-runtime state (locks, held threads) by it.
  const again = createRuntimePool(local, () => [members[1]!]);
  expect(again.bindRun().client).toBe(again.bindRun().client);
});

test("through the runner: runs land on the node, an extra one at the same time on the server, and a conversation stays on its node", async () => {
  const local = scriptedRuntime([SKILL], () => JSON.stringify({ titles: ["server"] }));
  const node = scriptedRuntime([SKILL], () => JSON.stringify({ titles: ["node"] }));
  // A later turn first asks which threads the runtime still holds (the run let its thread go when it ended).
  const ask = node.rpc.request.bind(node.rpc);
  node.rpc.request = ((method: string, params?: unknown) => method === "thread/loaded/list" ? Promise.resolve({ data: ["thread-1"] })
    : ask(method, params as never)) as typeof node.rpc.request;
  let present: PoolMember[] = [{ id: "device:pc", client: node.rpc, capacity: 1, priority: 2 }];
  const pool = createRuntimePool(local.rpc, () => present);

  const alone = await run(pool);
  expect(alone.ok && alone.output.titles).toEqual(["node"]);
  expect(local.prompts()).toHaveLength(0);

  const [a, b] = await Promise.all([run(pool), run(pool)]);
  expect([a.ok && a.output.titles[0], b.ok && b.output.titles[0]].sort()).toEqual(["node", "server"]);
  expect(local.prompts()).toHaveLength(1);

  // A later turn on a thread the node started goes back to the node.
  const threadId = alone.audit.threadId!;
  const before = node.prompts().length;
  const turn = await continueSkillTurn(pool, threadId, "again", turnOptions);
  expect(turn.ok ? "ok" : turn.blocker.code).toBe("ok");
  expect(node.prompts()).toHaveLength(before + 1);

  // Its node gone, the same conversation's turn lands on the server (which answers for the thread as its own runtime would).
  present = [];
  const serverBefore = local.prompts().length;
  await continueSkillTurn(pool, threadId, "once more", turnOptions);
  expect(local.prompts().length).toBeGreaterThanOrEqual(serverBefore);
});

test("the gate counts the owner's node capacity on top of its share, and a node with room is not held by this process's memory", async () => {
  let room = true;
  configureModelGate({ limit: 2, reserve: 1, perTenant: 2, highWater: 0.75, probe: () => ({ used: 900, limit: 1000 }), pollMs: 5, maxMemoryWaitMs: 60_000,
    extraCapacity: (tenant) => tenant === "owner" ? 3 : 0, nodeRoom: (tenant) => tenant === "owner" && room, log: () => {} });
  const holds: Array<() => void> = [];
  const started: string[] = [];
  const slot = (tenant: string, name: string) => withModelSlot({ skill: "crossline:crossline-due-diligence", tenant }, () => new Promise<void>((resolve) => {
    started.push(name); holds.push(resolve);
  }));
  // Memory is past the mark: the owner's runs start anyway while a node has room, up to its share plus the nodes' three.
  const owner = [slot("owner", "o1"), slot("owner", "o2"), slot("owner", "o3"), slot("owner", "o4"), slot("owner", "o5")];
  const other = slot("guest", "g1");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(started.filter((name) => name.startsWith("o"))).toHaveLength(4);
  expect(started).not.toContain("g1");
  room = false;
  for (const release of holds.splice(0)) release();
  await Promise.all(owner.slice(0, 4));
  // With no node room and memory high, the rest waits like anyone's.
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(started).not.toContain("g1");
  configureModelGate({ probe: () => ({ used: 100, limit: 1000 }) });
  // Memory back under the mark: what waited goes, one after another (each run let go as it starts).
  for (let round = 0; round < 10 && !(started.includes("g1") && started.includes("o5")); round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const release of holds.splice(0)) release();
  }
  for (const release of holds.splice(0)) release();
  await Promise.all([...owner, other]);
  expect(started).toContain("g1");
  expect(started).toContain("o5");
});
