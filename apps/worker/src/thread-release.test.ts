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
