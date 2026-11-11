import { expect, test } from "vitest";
import { AUTOMATIONS_SETTING, readAutomations, type AutomationPlan } from "@crossline/core";
import { CrosslineStore, requestAutomation } from "@crossline/db";
import type { AutomationDeps } from "./automations";
import { AUTOMATION_DESIGNER_SKILL, designPending } from "./automations";
import { startWorkflowTurn, streamedReply } from "./workflow-thread";
import { fakeRuntime } from "./testing/fake-runtime";

const plan = (trigger: Partial<AutomationPlan["trigger"]> = {}): AutomationPlan => ({
  name: "课程邮件整理", summary: "每天早上把课程邮件整理成清单", lineId: "research",
  trigger: { type: "schedule", time: "08:00", days: "DAILY", hours: 0, from: "", keywords: "", url: "", event: "", ...trigger },
  action: { kind: "run", instructions: "读最近一天和课程有关的邮件，整理成待办清单写进 digest.md", reminder: "", category: "read_research_organize", outputs: "digest.md" },
  steps: [{ title: "读邮件并整理", by: "assistant" }], assumptions: "", replaces: "", enabled: true, runNow: false
});
const answer = (reply: string, change: "none" | "automation", trigger: Partial<AutomationPlan["trigger"]> = {}) => JSON.stringify({ reply, change, plan: plan(trigger), revision: "" });

function setup() {
  const store = new CrosslineStore(":memory:");
  const workspaceId = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  store.setSetting(workspaceId, "lines.custom", JSON.stringify([{ id: "research", label: "研究者" }]));
  const deps = (client: AutomationDeps["client"]): AutomationDeps => ({ store, cwd: "/repo", client, zone: () => "Asia/Shanghai", now: () => new Date("2026-11-10T02:00:00Z"),
    runFree: (_w, input) => ({ state: "started", taskId: input.taskId }) });
  return { store, workspaceId, deps };
}

test("a workflow is made and changed in its own conversation: each change is a version, a question is not, and tool calls are shown", async () => {
  const { store, workspaceId, deps } = setup();
  const { rpc, threadStarts, turns } = fakeRuntime([
    answer("想几点整理？", "none"),
    answer("好，每天早上 8 点整理课程邮件。", "automation"),
    answer("改成每 6 小时一次。", "automation", { type: "interval", hours: 6 })
  ], AUTOMATION_DESIGNER_SKILL, { script: async ({ ask }) => { await ask("item/tool/call", { callId: "c1", tool: "next_times", arguments: { time: "08:00", days: "DAILY" } }); } });
  const first = startWorkflowTurn(deps(() => rpc), workspaceId, { text: "帮我整理课程邮件", lineId: "research" });
  if (!first.ok) throw new Error(first.code);
  await first.done;
  let thread = store.getWorkflowThread(workspaceId, first.threadId)!;
  expect(thread.workflowId).toBe("");
  const second = startWorkflowTurn(deps(() => rpc), workspaceId, { threadId: first.threadId, text: "每天早上 8 点" });
  if (!second.ok) throw new Error(second.code);
  await second.done;
  thread = store.getWorkflowThread(workspaceId, first.threadId)!;
  expect(thread.workflowId).toMatch(/^auto-/);
  const third = startWorkflowTurn(deps(() => rpc), workspaceId, { workflowId: thread.workflowId, text: "改成每 6 小时" });
  if (!third.ok) throw new Error(third.code);
  expect(third.threadId).toBe(first.threadId);
  await third.done;

  // One Codex thread for the whole conversation: started once, continued after.
  expect(threadStarts()).toHaveLength(1);
  expect(turns()).toBe(3);
  const [automation] = readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING));
  expect(automation).toMatchObject({ id: thread.workflowId, trigger: { type: "interval", hours: 6 } });
  expect(store.listWorkflowVersions(workspaceId, "automation", thread.workflowId).map((item) => [item.version, item.source])).toEqual([[1, "thread"], [2, "thread"]]);
  const said = store.listWorkflowTurns(workspaceId, first.threadId);
  expect(said.map((turn) => [turn.role, turn.state])).toEqual([["person", "done"], ["assistant", "done"], ["person", "done"], ["assistant", "done"], ["person", "done"], ["assistant", "done"]]);
  expect(said[1]!.text).toBe("想几点整理？");
  expect(said[1]!.items).toContainEqual(expect.objectContaining({ type: "tool", name: "next_times", ok: true }));
  expect(said[3]!.items).toContainEqual({ type: "version", version: 1, note: "每天早上把课程邮件整理成清单" });
  expect(said[5]!.items).toContainEqual(expect.objectContaining({ type: "version", version: 2 }));
});

test("a request from the 小帮手 opens the conversation it is designed in", async () => {
  const { store, workspaceId, deps } = setup();
  const requestId = requestAutomation(store, workspaceId, "每天早上把课程邮件整理成清单", "research", "user-1");
  expect(store.listWorkflowTurns(workspaceId, requestId).map((turn) => turn.state)).toEqual(["done", "running"]);
  // While it is designed, the conversation waits.
  expect(startWorkflowTurn(deps(() => undefined), workspaceId, { threadId: requestId, text: "再加一条" })).toMatchObject({ ok: false, code: "WORKFLOW_TURN_RUNNING" });
  const { rpc } = fakeRuntime([JSON.stringify(plan())], AUTOMATION_DESIGNER_SKILL);
  const [designed] = await designPending(deps(() => rpc), workspaceId);
  expect(store.getWorkflowThread(workspaceId, requestId)?.workflowId).toBe(designed!.id);
  const reply = store.listWorkflowTurns(workspaceId, requestId)[1]!;
  expect(reply).toMatchObject({ state: "done", items: [{ type: "version", version: 1 }] });
  expect(reply.text).toContain("课程邮件整理");
});

test("the reply is shown while the structured answer is still being written", () => {
  expect(streamedReply('{"reply":"好，每天早')).toBe("好，每天早");
  expect(streamedReply('{"reply":"第一行\\n第二')).toBe("第一行\n第二");
  expect(streamedReply('{"reply":"半个\\')).toBe("半个");
  expect(streamedReply('{"change"')).toBe("");
});
