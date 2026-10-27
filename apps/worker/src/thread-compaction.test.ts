import { afterEach, expect, test, vi } from "vitest";
import { continueSkillTurn, runCodexSkill } from "@crossline/codex";
import { fakeRuntime } from "./testing/fake-runtime";

const SKILL = "crossline:crossline-concierge";
const options = { skillName: SKILL, cwd: "C:\\repo", developerInstructions: "x", outputSchema: {}, prepareInput: (input: unknown) => input,
  validateOutput: (output: unknown) => output, onAudit: () => {}, timeoutMs: 5_000 };
const turnOptions = { skillName: SKILL, cwd: "C:\\repo", outputSchema: {}, validateOutput: (output: unknown) => output, onAudit: () => {}, timeoutMs: 5_000 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const logged = (spy: ReturnType<typeof vi.spyOn>, type: string) => spy.mock.calls.map((call: unknown[]) => { try { return JSON.parse(String(call[0])); } catch { return undefined; } })
  
  .filter((line: Record<string, unknown> | undefined): line is Record<string, unknown> => line?.type === type);

afterEach(() => { vi.restoreAllMocks(); });

test("a conversation whose context passed 60% of the window is compacted between turns, and the next turn waits for it", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const runtime = fakeRuntime(["{}", "{\"next\":true}"], SKILL, { usage: { input: 70_000, output: 2_000 }, contextWindow: 100_000 });
  const first = await runCodexSkill(runtime.rpc, {}, { ...options, keepThread: true });
  expect(first.ok).toBe(true);
  const next = await continueSkillTurn(runtime.rpc, first.audit.threadId!, "下一句", turnOptions);
  expect(next).toMatchObject({ ok: true, output: { next: true } });
  // The compaction sits between the two turns: nothing was sent on the thread while it ran.
  const order = runtime.calls().filter((method) => method === "turn/start" || method === "thread/compact/start");
  expect(order.slice(0, 3)).toEqual(["turn/start", "thread/compact/start", "turn/start"]);
  await settle();
  const compacted = logged(info, "skill.compacted");
  expect(compacted[0]).toMatchObject({ skill: SKILL, threadId: first.audit.threadId, ok: true, beforeTokens: 72_000, window: 100_000 });
});

test("a context well inside the window is left alone, and a one-off run is never compacted", async () => {
  const small = fakeRuntime(["{}", "{}"], SKILL, { usage: { input: 20_000, output: 1_000 }, contextWindow: 100_000 });
  const first = await runCodexSkill(small.rpc, {}, { ...options, keepThread: true });
  await continueSkillTurn(small.rpc, first.audit.threadId!, "下一句", turnOptions);
  await settle();
  expect(small.calls()).not.toContain("thread/compact/start");

  const oneOff = fakeRuntime(["{}"], SKILL, { usage: { input: 90_000, output: 1_000 }, contextWindow: 100_000 });
  await runCodexSkill(oneOff.rpc, {}, options);
  await settle();
  expect(oneOff.calls()).not.toContain("thread/compact/start");
});

test("a window the runtime did not report is no reason to compact (its own automatic compaction still holds)", async () => {
  const runtime = fakeRuntime(["{}", "{}"], SKILL, { usage: { input: 900_000, output: 1_000 } });
  const first = await runCodexSkill(runtime.rpc, {}, { ...options, keepThread: true });
  await continueSkillTurn(runtime.rpc, first.audit.threadId!, "下一句", turnOptions);
  await settle();
  expect(runtime.calls()).not.toContain("thread/compact/start");
});

test("a run told to go on in a thread resumes it with the settings a new one would get, and starts none", async () => {
  const runtime = fakeRuntime(["{}", "{\"again\":true}"], SKILL);
  const first = await runCodexSkill(runtime.rpc, {}, options);
  await settle();
  const second = await runCodexSkill(runtime.rpc, {}, { ...options, resumeThreadId: first.audit.threadId! });
  expect(second).toMatchObject({ ok: true, output: { again: true }, audit: { threadId: first.audit.threadId, resumed: true } });
  expect(runtime.threadStarts()).toHaveLength(1);
  const resumed = runtime.resumeParams()[0]!;
  // The same isolation as at the start: read-only, untrusted, and the feature switches given again.
  expect(resumed).toMatchObject({ threadId: first.audit.threadId, excludeTurns: true, sandbox: "read-only", approvalPolicy: "untrusted" });
  expect(resumed.config).toMatchObject({ "features.shell_tool": false });
  expect(resumed).not.toHaveProperty("dynamicTools");
});

test("a thread the runtime no longer has is replaced by a new one, and the run says so", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const runtime = fakeRuntime(["{\"fresh\":true}"], SKILL, { lostThreads: ["thread-gone"] });
  const result = await runCodexSkill(runtime.rpc, {}, { ...options, resumeThreadId: "thread-gone" });
  expect(result).toMatchObject({ ok: true, output: { fresh: true }, audit: { threadId: "thread-1", resumed: false } });
  expect(runtime.threadStarts()).toHaveLength(1);
  expect(logged(info, "skill.resume_lost")[0]).toMatchObject({ threadId: "thread-gone" });
});
