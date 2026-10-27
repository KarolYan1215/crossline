import { expect, test } from "vitest";
import { continueSkillTurn, runCodexSkill } from "@crossline/codex";
import { fakeRuntime } from "./testing/fake-runtime";

const SKILL = "crossline:crossline-plan-explainer";
const options = { skillName: SKILL, cwd: "C:\\repo", developerInstructions: "x", outputSchema: {}, prepareInput: (input: unknown) => input,
  validateOutput: (output: unknown) => output, onAudit: () => {}, timeoutMs: 5_000 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("a finished run lets go of its thread, so the runtime unloads it and stops the MCP servers its plugins started", async () => {
  const runtime = fakeRuntime(["{}"], SKILL);
  const result = await runCodexSkill(runtime.rpc, {}, options);
  await settle();
  expect(result.ok).toBe(true);
  expect(runtime.unsubscribed()).toEqual(["thread-1"]);
});

test("a conversation's thread is kept for its next turn, which holds it again", async () => {
  const runtime = fakeRuntime(["{}", "{}"], SKILL);
  const first = await runCodexSkill(runtime.rpc, {}, { ...options, keepThread: true });
  await settle();
  expect(runtime.unsubscribed()).toEqual([]);
  const next = await continueSkillTurn(runtime.rpc, first.audit.threadId!, "再来", { skillName: SKILL, cwd: "C:\\repo", outputSchema: {},
    validateOutput: (output: unknown) => output, onAudit: () => {}, timeoutMs: 5_000 });
  await settle();
  expect(next.ok).toBe(true);
  expect(runtime.unsubscribed()).toEqual([]);
});

const turnOptions = { skillName: SKILL, cwd: "C:\\repo", outputSchema: {}, validateOutput: (output: unknown) => output, onAudit: () => {}, timeoutMs: 5_000 };

test("a turn on a thread the client let go of subscribes to it again first, so its events reach the run (the 26-minute interview round)", async () => {
  const runtime = fakeRuntime(["{}", "{\"again\":true}"], SKILL);
  const first = await runCodexSkill(runtime.rpc, {}, options);
  await settle();
  expect(runtime.unsubscribed()).toEqual(["thread-1"]);
  // Without the resume the turn would run silently and only the stall check would end it.
  const next = await continueSkillTurn(runtime.rpc, first.audit.threadId!, "下一轮", { ...turnOptions, idleMs: 200 });
  expect(next).toMatchObject({ ok: true, output: { again: true } });
  expect(runtime.resumes()).toEqual(["thread-1"]);
  // Subscribed again, a second turn needs no second resume.
  await continueSkillTurn(runtime.rpc, first.audit.threadId!, "再一轮", { ...turnOptions, idleMs: 200 });
  expect(runtime.resumes()).toEqual(["thread-1"]);
});

test("a released thread the runtime has already unloaded is reported lost, so the caller rebuilds it", async () => {
  const runtime = fakeRuntime(["{}", "{}"], SKILL, { unloadedThreads: ["thread-1"] });
  const first = await runCodexSkill(runtime.rpc, {}, options);
  await settle();
  const next = await continueSkillTurn(runtime.rpc, first.audit.threadId!, "下一轮", { ...turnOptions, idleMs: 200 });
  expect(next).toMatchObject({ ok: false, blocker: { code: "SKILL_THREAD_LOST" } });
  expect(runtime.resumes()).toEqual([]);
  expect(runtime.turns()).toBe(1);
});
