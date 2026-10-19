import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createOnboardingSessionRunner, ONBOARDING_SKILL } from "./onboarding-session";
import { ONBOARDING_EXTRACT_SKILL } from "./onboarding-extract";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

const turn = () => JSON.stringify({ reply: "收到。", questions: [{ id: "q1", text: "这学期的课什么时候结束？", kind: "single", allowOther: true, identityId: "research", projectId: "",
  options: [{ id: "a", label: "12 月中", detail: "" }, { id: "b", label: "1 月初", detail: "" }] }], slotUpdates: [], projectsDetected: [], flywheelCandidates: [], coverage: [], nextAction: "ask" });
const runtime = (item: Record<string, unknown>) => fakeRuntime([turn(), turn(), turn()], [ONBOARDING_SKILL, ONBOARDING_EXTRACT_SKILL], {
  script: async ({ emit, threadId, turnId }) => {
    emit({ method: "item/started", params: { threadId, turnId, item: { ...item, status: "inProgress", error: null } } });
    emit({ method: "item/completed", params: { threadId, turnId, item } });
  } });

test("a tool the run never offered, which the runtime answered with an error, does not end the turn; one that completed does", async () => {
  // 2026-10-19: two sponsor candidates called a tool the interview never offers; the runtime found no such server and the call failed.
  const failed = runtime({ type: "mcpToolCall", id: "m1", server: "functions", tool: "search_evidence", status: "failed", error: { message: "unknown MCP server" } });
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => failed.rpc, { checklist: false, extract: "off" });
  expect(await run({ sessionId: "s", text: "我在读研。" })).toMatchObject({ state: "asked" });

  const done = runtime({ type: "mcpToolCall", id: "m2", server: "notion", tool: "search", status: "completed", error: null, result: { content: [] } });
  const refused = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => done.rpc, { checklist: false, extract: "off" });
  expect(await refused({ sessionId: "s2", text: "第二段对话。" })).toMatchObject({ state: "blocked", code: "SKILL_TOOL_FORBIDDEN", detail: "item:mcpToolCall" });
});

test("the runtime's own features a run asks for: code mode with its tools, read-only connectors, the plan tool, a provider's context window", async () => {
  const { runCodexSkill, contextWindowConfig } = await import("@crossline/codex");
  const plans: unknown[] = [];
  const answer = JSON.stringify({ ok: true });
  const runtime = fakeRuntime([answer], "crossline:crossline-agent-tools", { script: async ({ emit, threadId, turnId }) => {
    emit({ method: "turn/plan/updated", params: { threadId, turnId, explanation: "先读后写", plan: [{ step: "读材料", status: "completed" }, { step: "写清单", status: "inProgress" }] } });
    // A connector read the run was allowed, as a completed call.
    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "mcpToolCall", id: "g1", server: "codex_apps", tool: "gmail__search", status: "completed", error: null } } });
  } });
  const result = await runCodexSkill(runtime.rpc, {}, { skillName: "crossline:crossline-agent-tools", cwd: "/repo", developerInstructions: "x", outputSchema: { type: "object" },
    prepareInput: (input) => input, validateOutput: (output) => output, onAudit: () => {},
    tools: { specs: [{ name: "read_file", description: "r", inputSchema: { type: "object" } }], call: () => "" },
    codeMode: true, connectors: true, onPlan: (plan) => plans.push(plan) });
  expect(result.ok).toBe(true);
  const config = runtime.threadStarts()[0]!.config as Record<string, unknown>;
  expect(config).toMatchObject({ "features.code_mode": true, "features.apps": true, "features.goals": false, "tools.update_plan.enabled": true,
    "apps._default.default_tools_approval_mode": "writes", "apps._default.destructive_enabled": false });
  expect(plans).toEqual([{ explanation: "先读后写", steps: [{ step: "读材料", status: "completed" }, { step: "写清单", status: "inProgress" }] }]);
  // Without asking for them, none of it is on.
  const plain = fakeRuntime([answer], "crossline:crossline-agent-tools");
  await runCodexSkill(plain.rpc, {}, { skillName: "crossline:crossline-agent-tools", cwd: "/repo", developerInstructions: "x", outputSchema: { type: "object" },
    prepareInput: (input) => input, validateOutput: (output) => output, onAudit: () => {} });
  expect(plain.threadStarts()[0]!.config).toMatchObject({ "features.code_mode": false, "features.apps": false, "tools.update_plan.enabled": false });
  // A provider's window: the sponsor's list says it; an unknown one is taken as 128k so compaction comes before overflow.
  expect(contextWindowConfig({ id: "p", model: "m", definition: {}, contextWindow: 1_024_000 })).toEqual({ model_context_window: 1_024_000, model_auto_compact_token_limit: 819_200 });
  expect(contextWindowConfig({ id: "p", model: "m", definition: {} })).toEqual({ model_context_window: 128_000, model_auto_compact_token_limit: 102_400 });
});

test("a question the run asks mid-turn goes to the person and the answer comes back on the same turn; the third is not asked", async () => {
  const { runCodexSkill } = await import("@crossline/codex");
  const { personAsker } = await import("./agent-task");
  const { ledgerQuestion, QUESTION_UNANSWERED } = await import("./agent-dispatch");
  const { answerAgentQuestion, pendingAgentQuestions } = await import("@crossline/db");
  const replies: unknown[] = [];
  const question = (id: string) => ({ questions: [{ id, header: "导师", question: "导师要的是 A 稿还是 B 稿？", isOther: true, isSecret: false,
    options: [{ label: "A 稿", description: "上周的结构" }, { label: "B 稿", description: "按新数据重写" }] }], isBlocking: true });
  const runtime = fakeRuntime([JSON.stringify({ ok: true })], "crossline:crossline-agent-tools", { script: async ({ ask }) => {
    for (const id of ["q1", "q2", "q3"]) replies.push(await ask("item/tool/requestUserInput", { itemId: id, ...question(id) }));
  } });
  // The person answers the first question on 待确认; nobody answers the second, which expires.
  let polls = 0;
  const asker = ledgerQuestion(store, workspaceId, "agent-1", "整理导师要的稿子", { timeoutMs: 9, pollMs: 3, sleep: async () => {
    polls += 1;
    const open = pendingAgentQuestions(store, workspaceId)[0];
    if (open && polls === 1) expect(answerAgentQuestion(store, workspaceId, open.id, { q1: ["B 稿"] })).toBe(true);
  } });
  const audit = { commands: [], filesChanged: [], mcpCalls: [], searches: [], decisions: [], requests: { total: 0, allowed: 0 } };
  const result = await runCodexSkill(runtime.rpc, {}, { skillName: "crossline:crossline-agent-tools", cwd: "/repo", developerInstructions: "x", outputSchema: { type: "object" },
    prepareInput: (input) => input, validateOutput: (output) => output, onAudit: () => {},
    tools: { specs: [{ name: "read_file", description: "r", inputSchema: { type: "object" } }], call: () => "" }, askPerson: personAsker(asker, audit, () => {})! });
  expect(result.ok).toBe(true);
  expect(runtime.threadStarts()[0]!.config).toMatchObject({ "tools.experimental_request_user_input.enabled": true, "features.default_mode_request_user_input": true });
  expect(replies[0]).toEqual({ answers: { q1: { answers: ["B 稿"] } } });
  expect(replies[1]).toEqual({ answers: { q2: { answers: [QUESTION_UNANSWERED] } } });
  // The third is answered without asking anyone.
  expect((replies[2] as { answers: { q3: { answers: string[] } } }).answers.q3.answers[0]).toContain("不再提问");
  expect(store.listEvents(workspaceId, { type: "agent.question.requested" })).toHaveLength(2);
  expect(store.listEvents(workspaceId, { type: "agent.question.expired" })).toHaveLength(1);
  expect(pendingAgentQuestions(store, workspaceId)).toEqual([]);
  expect(audit).toMatchObject({ questions: [{ question: "导师要的是 A 稿还是 B 稿？", answers: ["B 稿"] }, { answers: [QUESTION_UNANSWERED] }, { answers: [expect.stringContaining("不再提问")] }] });
  // An answer after it expired, or to a question it never asked, is refused.
  const expired = store.listEvents(workspaceId, { type: "agent.question.expired" })[0]!.entityId;
  expect(answerAgentQuestion(store, workspaceId, expired, { q2: ["A 稿"] })).toBe(false);
  // Without a way to ask, the runtime is not offered the tool.
  const plain = fakeRuntime([JSON.stringify({ ok: true })], "crossline:crossline-agent-tools");
  await runCodexSkill(plain.rpc, {}, { skillName: "crossline:crossline-agent-tools", cwd: "/repo", developerInstructions: "x", outputSchema: { type: "object" },
    prepareInput: (input) => input, validateOutput: (output) => output, onAudit: () => {} });
  expect(plain.threadStarts()[0]!.config).toMatchObject({ "tools.experimental_request_user_input.enabled": false });
});
