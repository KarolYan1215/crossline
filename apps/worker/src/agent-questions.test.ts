import { afterEach, beforeEach, expect, test } from "vitest";
import { runCodexSkill } from "@crossline/codex";
import { answerAgentQuestion, CrosslineStore, pendingAgentQuestions, requestAgentQuestion } from "@crossline/db";
import { ledgerQuestion, QUESTION_UNANSWERED } from "./agent-dispatch";
import { agentQuestionsProbe } from "./self-check-agent";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let ws: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人").workspace.id;
});
afterEach(() => store.close());

const question = { id: "q1", header: "导师", question: "A 稿还是 B 稿？", options: [{ label: "A 稿", description: "" }] };
const ended = (taskId: string) => store.appendEvent({ ownerId: store.getWorkspaceOwnerId(ws)!, workspaceId: ws, idempotencyKey: `blocked:${taskId}`,
  type: "agent.task.blocked", entityId: taskId, payload: { code: "AGENT_CANCELLED" } });

test("a cancelled run stops waiting at once and leaves no question open", async () => {
  const control = new AbortController();
  let polls = 0;
  const asker = ledgerQuestion(store, ws, "agent-1", "稿子", { timeoutMs: 60_000, pollMs: 1_000, signal: control.signal,
    sleep: async () => { polls += 1; control.abort(); } });
  expect(await asker([question])).toEqual({ q1: [QUESTION_UNANSWERED] });
  expect(polls).toBe(1);
  expect(store.listEvents(ws, { type: "agent.question.expired" })).toHaveLength(1);
  expect(pendingAgentQuestions(store, ws)).toEqual([]);
});

test("a run that ended (its blocked event in the ledger) stops waiting too", async () => {
  let polls = 0;
  const asker = ledgerQuestion(store, ws, "agent-2", "稿子", { timeoutMs: 60_000, pollMs: 1_000, sleep: async () => { polls += 1; ended("agent-2"); } });
  expect(await asker([question])).toEqual({ q1: [QUESTION_UNANSWERED] });
  expect(polls).toBe(1);
  expect(pendingAgentQuestions(store, ws)).toEqual([]);
});

test("an answer given after the last poll is used, and the question is not also expired", async () => {
  const asker = ledgerQuestion(store, ws, "agent-3", "稿子", { timeoutMs: 0, pollMs: 1, sleep: async () => {
    const open = pendingAgentQuestions(store, ws)[0]!;
    expect(answerAgentQuestion(store, ws, open.id, { q1: ["B 稿"] })).toBe(true);
  } });
  expect(await asker([question])).toEqual({ q1: ["B 稿"] });
  expect(store.listEvents(ws, { type: "agent.question.expired" })).toHaveLength(0);
});

test("the runtime's own MCP tool approval is declined by itself and never reaches the person", async () => {
  const asked: string[][] = [];
  const replies: unknown[] = [];
  const runtime = fakeRuntime([JSON.stringify({ ok: true })], "crossline:crossline-agent-tools", { script: async ({ ask }) => {
    replies.push(await ask("item/tool/requestUserInput", { itemId: "i1", isBlocking: true, questions: [
      { id: "mcp_tool_call_approval_call-1", header: "Approve", question: "Allow Calendar to create an event?", isOther: false, isSecret: false,
        options: [{ label: "Allow", description: "" }, { label: "Allow for this session", description: "" }, { label: "Cancel", description: "" }] },
      { id: "other", header: "x", question: "Run it?", isOther: false, isSecret: false, options: [{ label: "Allow and don't ask me again", description: "" }] },
      { id: "q1", header: "导师", question: "A 稿还是 B 稿？", isOther: true, isSecret: false, options: [{ label: "A 稿", description: "" }] }] }));
  } });
  const result = await runCodexSkill(runtime.rpc, {}, { skillName: "crossline:crossline-agent-tools", cwd: "/repo", developerInstructions: "x", outputSchema: { type: "object" },
    prepareInput: (input) => input, validateOutput: (output) => output, onAudit: () => {},
    tools: { specs: [{ name: "read_file", description: "r", inputSchema: { type: "object" } }], call: () => "" },
    askPerson: async (questions) => { asked.push(questions.map((item) => item.id)); return { q1: ["A 稿"] }; } });
  expect(result.ok).toBe(true);
  expect(asked).toEqual([["q1"]]);
  expect(replies[0]).toEqual({ answers: { q1: { answers: ["A 稿"] }, "mcp_tool_call_approval_call-1": { answers: ["Cancel"] }, other: { answers: ["Cancel"] } } });
});

test("the self-check closes questions left open by an ended run or past their wait; skipped when none was ever asked", async () => {
  const probe = agentQuestionsProbe(store);
  const now = new Date();
  expect(await probe.run(ws, now)).toMatchObject({ status: "skipped" });
  requestAgentQuestion(store, ws, "agent-4", "稿子", [question]);
  expect(await probe.run(ws, now)).toMatchObject({ status: "ok" });
  ended("agent-4");
  expect(await probe.run(ws, now)).toMatchObject({ status: "repaired", code: "QUESTION_ORPHANED" });
  requestAgentQuestion(store, ws, "agent-5", "稿子", [question]);
  expect(await probe.run(ws, new Date(now.getTime() + 20 * 60_000))).toMatchObject({ status: "repaired", code: "QUESTION_STUCK" });
  expect(store.listEvents(ws, { type: "agent.question.expired" })).toHaveLength(2);
  expect(await probe.run(ws, new Date(now.getTime() + 20 * 60_000))).toMatchObject({ status: "ok" });
});
