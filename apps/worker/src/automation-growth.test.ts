import { expect, test } from "vitest";
import { AUTOMATIONS_SETTING, readAutomations, type AutomationPlan } from "@crossline/core";
import { CrosslineStore, requestAutomation } from "@crossline/db";
import { AUTOMATION_DESIGNER_SKILL, designPending, suggestFromRepeats, type AutomationDeps } from "./automations";
import { fakeRuntime } from "./testing/fake-runtime";
import { growCandidates } from "./workflow-smith";

/**
 * The growth of an automation from use (docs/personal-agent.md §4, the owner asked on 2026-10-19 for 「工作流生长自动提议测试」): two
 * accepted errands of one kind on one line → one suggestion, said once, whose button is the input box's own `workflow.request` → the
 * designer builds it → an active automation on that line.
 */
const NOW = new Date("2026-10-19T14:00:00Z");

function setup() {
  const store = new CrosslineStore(":memory:");
  const { workspace, principal } = store.createPrincipalWithWorkspace("user-1", "w");
  store.setSetting(workspace.id, "lines.custom", JSON.stringify([{ id: "research", label: "研究者" }, { id: "media", label: "创作者" }]));
  const order = (id: string, identityId: string, intent: string) => store.saveWorkOrder({ id, ownerId: principal.id, workspaceId: workspace.id, identityId,
    projectId: "", milestoneId: "", intent, state: "approved", riskTier: "routine", estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 60, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: {} } as never);
  const errand = (taskId: string, workOrderId: string, title: string, category = "read_research_organize") => {
    store.appendEvent({ ownerId: principal.id, workspaceId: workspace.id, idempotencyKey: `req-${taskId}`, type: "agent.task.requested", entityId: taskId,
      payload: { taskId, title, category, workOrderId } });
    store.appendEvent({ ownerId: principal.id, workspaceId: workspace.id, idempotencyKey: `done-${taskId}`, type: "agent.task.completed", entityId: taskId,
      payload: { taskId, reviewRequired: false, directory: "/tmp/none", artifacts: [{ path: "清单.md", sha256: "x", bytes: 10 }] } });
  };
  return { store, workspaceId: workspace.id, ownerId: principal.id, order, errand };
}

test("two accepted errands of one kind on one line are offered as an automation once, and its button builds one on that line", async () => {
  const { store, workspaceId, ownerId, order, errand } = setup();
  order("wo-1", "research", "整理本周课程邮件");
  order("wo-2", "research", "整理上周课程邮件");
  order("wo-3", "media", "整理选题");
  errand("t1", "wo-1", "整理本周课程邮件成待办清单");
  // One errand is not a pattern yet.
  expect(suggestFromRepeats(store, workspaceId, growCandidates(store, workspaceId, NOW), NOW)).toBe(0);
  errand("t2", "wo-2", "整理上周课程邮件成待办清单");
  // An errand of the same kind on another line does not count towards this one.
  errand("t3", "wo-3", "整理课程邮件成待办清单");
  const candidates = growCandidates(store, workspaceId, NOW);
  expect(candidates.filter((item) => item.origin.kind === "repeated").map((item) => item.lineId)).toEqual(["research"]);
  expect(suggestFromRepeats(store, workspaceId, candidates, NOW)).toBe(1);
  // Said once: the same pair is not offered again.
  expect(suggestFromRepeats(store, workspaceId, growCandidates(store, workspaceId, NOW), NOW)).toBe(0);

  const [nudge] = store.listEvents(workspaceId, { type: "automation.suggested" });
  expect(nudge!.payload).toMatchObject({ lineId: "research" });
  expect([...(nudge!.payload as { taskIds: string[] }).taskIds].sort()).toEqual(["t1", "t2"]);
  const card = store.listConversationMessages(workspaceId, store.conversationFor(workspaceId, "2026-10-19").id).find((message) => message.role === "nudge")!.payload as {
    card: { actions: Array<{ action: string; args: { text: string; lineId: string } }>; clarify: { options: Array<{ label: string; kind: string }> } } };
  expect(card.card.clarify.options.map((option) => option.label)).toEqual(["建成自动化", "去设置里写清楚", "知道了"]);
  const button = card.card.actions[0]!;
  expect(button).toMatchObject({ action: "workflow.request", args: { lineId: "research" } });

  // Pressing it is the input box's action: the request is written, the designer builds it.
  requestAutomation(store, workspaceId, button.args.text, button.args.lineId, ownerId);
  const plan: AutomationPlan = { name: "课程邮件待办", summary: "每周一把课程邮件整理成待办清单", lineId: "research",
    trigger: { type: "schedule", time: "08:00", days: "MO", hours: 0, from: "", keywords: "", url: "", event: "" },
    action: { kind: "run", instructions: "读上周和课程有关的邮件，整理成待办清单写进 待办.md", reminder: "", category: "read_research_organize", outputs: "待办.md" },
    steps: [{ title: "整理成清单", by: "assistant" }], assumptions: "按每周一 08:00 理解", replaces: "", enabled: true };
  const { rpc } = fakeRuntime([JSON.stringify(plan)], AUTOMATION_DESIGNER_SKILL);
  const deps: AutomationDeps = { store, cwd: "/repo", client: () => rpc, zone: () => "America/Chicago", now: () => NOW,
    runFree: () => ({ state: "started", taskId: "x" }), fetch: { isPublicHost: async () => true, fetchImpl: fetch } };
  expect((await designPending(deps, workspaceId))[0]).toMatchObject({ state: "created" });
  expect(readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING))).toEqual([expect.objectContaining({ status: "active", lineId: "research", name: "课程邮件待办" })]);
});
