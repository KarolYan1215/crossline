import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { MAIL_REMINDER_REPAIR, mailReminderRepair, moneyAskRepair } from "./mail-reminder-repair";

let store: CrosslineStore;
afterEach(() => store?.close());
const estimate = { p25Minutes: 10, p50Minutes: 15, p85Minutes: 20, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

test("mail check to-dos nobody started become one reminder, once; work and other captures stay", () => {
  store = new CrosslineStore(":memory:");
  const { workspace, principal } = store.createPrincipalWithWorkspace("u", "w");
  const order = (id: string, intent: string, state = "approved") => store.saveWorkOrder({ id, ownerId: principal.id, workspaceId: workspace.id, identityId: "startup",
    projectId: "", milestoneId: "", intent, state: state as never, riskTier: "routine", estimate, payload: { title: intent } });
  order("cap-mail-a", "核实美国银行无卡交易");
  order("cap-mail-b", "核查 Render 公告涉及应用", "awaiting_plan_approval");
  order("cap-mail-c", "10/30 前交 ECE 555 HW4");
  order("cap-typed", "核查实验数据");
  order("cap-mail-started", "核实 HSBC 账单");
  const base = { deliverable: "x.md", doneCriterion: "完成", share: 0.5, estimate: { p25Minutes: 5, p50Minutes: 10, p85Minutes: 15 }, dependsOn: [], notBefore: "", dueBy: "", tickOutcome: "", schedulable: true };
  store.saveStepPlan(workspace.id, "cap-mail-a", { archetypeId: "errand", quantity: { basis: "项", amount: 1, unit: "项" }, rationale: "", steps: [
    { ...base, id: "s1", role: "gather", title: "核查清单", executor: "agent" }] }, principal.id, "planned");
  store.saveStepPlan(workspace.id, "cap-mail-started", { archetypeId: "errand", quantity: { basis: "项", amount: 1, unit: "项" }, rationale: "", steps: [
    { ...base, id: "s1", role: "act", title: "登录核对", executor: "human" }] }, principal.id, "planned");
  for (const id of ["cap-mail-a", "cap-mail-started"]) { const step = store.getStepPlan(workspace.id, id)!.steps[0]!; store.updateStepProgress(workspace.id, id, step.id, { status: "done" }, principal.id, "test"); }
  expect(mailReminderRepair(store, workspace.id).sort()).toEqual(["cap-mail-a", "cap-mail-b"]);
  const states = new Map(store.listWorkOrders(workspace.id).map((item) => [item.id, item.state]));
  expect(states.get("cap-mail-a")).toBe("archived");
  expect(states.get("cap-mail-c")).toBe("approved");
  expect(states.get("cap-typed")).toBe("approved");
  expect(store.getSetting(workspace.id, MAIL_REMINDER_REPAIR)).toBeTruthy();
  expect(store.listRecentNudges(workspace.id, "2000-01-01").length).toBe(1);
  expect(mailReminderRepair(store, workspace.id)).toEqual([]);
});

test("preparation that waited for the person's account records becomes the assistant's, once; other questions stay", () => {
  store = new CrosslineStore(":memory:");
  const { workspace, principal } = store.createPrincipalWithWorkspace("u", "w");
  const order = (id: string, intent: string, state = "approved") => store.saveWorkOrder({ id, ownerId: principal.id, workspaceId: workspace.id, identityId: "investment",
    projectId: "", milestoneId: "", intent, state: state as never, riskTier: "routine", estimate, payload: { title: intent, owner: "ask" } });
  order("a", "汇集10月至12月账户记录", "awaiting_plan_approval");
  order("b", "整理月末账户基线");
  order("c", "确定 Crossline 试用者口径");
  expect(moneyAskRepair(store, workspace.id).sort()).toEqual(["a", "b"]);
  const byId = new Map(store.listWorkOrders(workspace.id).map((item) => [item.id, item]));
  expect((byId.get("a")!.payload as { owner?: string }).owner).toBe("assistant");
  expect(byId.get("a")!.state).toBe("approved");
  expect((byId.get("c")!.payload as { owner?: string }).owner).toBe("ask");
  expect(moneyAskRepair(store, workspace.id)).toEqual([]);
});
