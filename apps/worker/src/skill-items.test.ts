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
