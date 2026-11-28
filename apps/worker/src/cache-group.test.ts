import { expect, test } from "vitest";
import { runCodexSkill } from "@crossline/codex";
import { fakeRuntime } from "./testing/fake-runtime";

const SKILL = "crossline:crossline-onboarding-extract";
const options = { skillName: SKILL, cwd: "C:\\repo", developerInstructions: "x", outputSchema: {}, prepareInput: (input: unknown) => input,
  validateOutput: (output: unknown) => output, onAudit: () => {}, timeoutMs: 5_000, cacheGroup: "extract:ws:sections" };

// The owner's interview on 2026-11-28: each extraction started a thread of its own, a new prompt-cache key, and the provider sent it to a
// machine that had not seen the 60k characters it shared with the run a minute before. A fork of the lane's first thread keeps its key.
test("a group's later runs go on an ephemeral fork of its first thread, cut before that thread's first turn", async () => {
  const runtime = fakeRuntime(["{}"], SKILL);
  const first = await runCodexSkill(runtime.rpc, { n: 1 }, options);
  const second = await runCodexSkill(runtime.rpc, { n: 2 }, options);
  const third = await runCodexSkill(runtime.rpc, { n: 3 }, options);
  expect([first.ok, second.ok, third.ok]).toEqual([true, true, true]);
  expect(runtime.threadStarts()).toHaveLength(1);
  expect(runtime.forks()).toHaveLength(2);
  for (const fork of runtime.forks()) {
    expect(fork).toMatchObject({ threadId: "thread-1", beforeTurnId: first.audit.turnId, ephemeral: true, excludeTurns: true,
      sandbox: "read-only", approvalPolicy: "untrusted" });
    // The settings a fresh thread would have been given, the developer instructions included.
    expect(String(fork.developerInstructions)).toMatch(/^x\n\n/);
    expect(fork.config).toEqual(runtime.threadStarts()[0]!.config);
  }
  expect([second.audit.forkedFrom, third.audit.forkedFrom]).toEqual(["thread-1", "thread-1"]);
  expect(second.audit.threadId).not.toBe("thread-1");
});

test("a fork that fails starts a thread of its own, which becomes the group's anchor", async () => {
  const runtime = fakeRuntime(["{}"], SKILL, { forkFails: true });
  await runCodexSkill(runtime.rpc, { n: 1 }, options);
  const second = await runCodexSkill(runtime.rpc, { n: 2 }, options);
  const third = await runCodexSkill(runtime.rpc, { n: 3 }, options);
  expect([second.ok, third.ok]).toEqual([true, true]);
  expect(second.audit.forkedFrom).toBeUndefined();
  expect(runtime.threadStarts()).toHaveLength(3);
  // The third run tries the second's thread, not the first's.
  expect(runtime.forks().map((fork) => fork.threadId)).toEqual(["thread-1", "thread-2"]);
});

test("a run whose tools or instructions differ from the anchor's does not fork it: a fork keeps its parent's tools", async () => {
  const runtime = fakeRuntime(["{}"], SKILL);
  await runCodexSkill(runtime.rpc, { n: 1 }, options);
  await runCodexSkill(runtime.rpc, { n: 2 }, { ...options, developerInstructions: "y" });
  expect(runtime.forks()).toHaveLength(0);
  // The newer instructions are the anchor now.
  await runCodexSkill(runtime.rpc, { n: 3 }, { ...options, developerInstructions: "y" });
  expect(runtime.forks().map((fork) => fork.threadId)).toEqual(["thread-2"]);
});

test("without a group, or for a kept conversation, every run starts its own thread", async () => {
  const runtime = fakeRuntime(["{}"], SKILL);
  const { cacheGroup: _, ...plain } = options;
  await runCodexSkill(runtime.rpc, { n: 1 }, plain);
  await runCodexSkill(runtime.rpc, { n: 2 }, plain);
  await runCodexSkill(runtime.rpc, { n: 3 }, { ...options, keepThread: true });
  await runCodexSkill(runtime.rpc, { n: 4 }, { ...options, keepThread: true });
  expect(runtime.forks()).toHaveLength(0);
  expect(runtime.threadStarts()).toHaveLength(4);
});
