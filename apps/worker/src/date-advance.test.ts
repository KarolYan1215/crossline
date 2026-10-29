import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { goalSettingKey } from "@crossline/core";
import { CrosslineStore, listAgentTasks, resultsAwaitingReview } from "@crossline/db";
import { ADVANCE_DAY_SETTING, advanceMessage, dateAdvancePass, MILESTONE_FORECAST_SETTING } from "./date-advance";

let store: CrosslineStore;
let ws: string;
let owner: string;
let dir: string;
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const NOW = new Date("2026-10-21T15:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  store = new CrosslineStore(":memory:");
  const created = store.createPrincipalWithWorkspace("user-1", "w");
  ws = created.workspace.id; owner = created.principal.id;
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "UTC", mode: "buffered", importance: {} }));
  dir = mkdtempSync(path.join(tmpdir(), "date-advance-"));
});
afterEach(() => { store.close(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

const at = (iso: string) => vi.setSystemTime(new Date(iso));
const event = (type: string, entityId: string, payload: object, key = `${type}:${entityId}`) =>
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: key, type, entityId, payload });
const milestone = (id: string, projectId: string, deadline: string, status: "approved" | "draft" = "approved") => {
  store.saveMilestone({ id, ownerId: owner, workspaceId: ws, identityId: "media", projectId, title: id, status, version: 1 });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: id, stage: 1, deadline, baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
};
const order = (id: string, milestoneId: string, state: string, projectId = "xhs") =>
  store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "media", projectId, milestoneId, intent: id, state: state as never, riskTier: "routine", estimate, payload: {} });
/** One finished assistant run at `when`, its own record (`audit.json`) beside its files. */
const result = (taskId: string, workOrderId: string, stepId: string, title: string, when: string, over: object = {}, needsHuman: Array<{ what: string; why: string }> = []) => {
  const directory = path.join(dir, taskId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "audit.json"), JSON.stringify({ needsHuman }));
  at(when);
  event("agent.task.requested", taskId, { title, category: "read_research_organize", workOrderId, stepId });
  event("agent.task.completed", taskId, { directory, artifacts: [{ path: "a.md", sha256: "h", bytes: 1 }], needsHuman: needsHuman.length, checksPassed: true,
    inputsModified: [], reviewRequired: true, ...over });
};

test("one day's pass: old results replaced, decided or put away; overdue milestones moved or asked about; old proposals and drafts archived; all in one undo and one message", () => {
  // The work and its results.
  order("t-steps", "pack", "approved");
  const base = { deliverable: "x.md", doneCriterion: "完成", share: 0.5, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50 }, dependsOn: [], notBefore: "", dueBy: "", tickOutcome: "", schedulable: true };
  store.saveStepPlan(ws, "t-steps", { archetypeId: "exam_prep", quantity: { basis: "项", amount: 2, unit: "项" }, rationale: "", steps: [
    { ...base, id: "a", role: "gather", title: "盘点文件", executor: "agent" }, { ...base, id: "b", role: "practice", title: "写初稿", executor: "human" }] }, owner, "planned");
  const [stepA] = store.getStepPlan(ws, "t-steps")!.steps;
  result("old-run", "t-steps", stepA!.id, "任务 · 盘点文件", "2026-10-05T10:00:00Z");
  result("new-run", "t-steps", stepA!.id, "任务 · 盘点文件", "2026-10-12T10:00:00Z", {}, [{ what: "提供原始数据", why: "只有本人有" }]);
  result("young", "t-steps", "", "任务 · 起草邮件", "2026-10-21T02:00:00Z");
  result("failed", "t-steps", "", "任务 · 核对来源", "2026-10-05T10:00:00Z", { checksPassed: false });
  result("failed-young", "t-steps", "", "任务 · 核对日期", "2026-10-12T10:00:00Z", { checksPassed: false });
  expect(resultsAwaitingReview(store, ws).map((row) => row.taskId).sort()).toEqual(["failed", "failed-young", "new-run", "young"]);

  // Milestones: the person's own one overdue with a chain behind it, a course's and one whose date the person typed.
  milestone("pack", "xhs", "2026-10-17");
  milestone("feedback", "xhs", "2026-10-24");
  milestone("hw", "ece555", "2026-10-16");
  milestone("talk", "talks", "2026-10-19");
  milestone("done-ms", "xhs2", "2026-10-10");
  store.upsertProfileFact({ workspaceId: ws, identityId: "media", projectId: "ece555", slot: "grading", value: "作业 30%", status: "confirmed", sourceRef: "doc", sourceQuote: "", updatedAt: "2026-10-01T00:00:00Z" });
  store.setSetting(ws, goalSettingKey("talk"), JSON.stringify({ confirmedDeadline: "2026-10-19" }));
  event("goal.settings_confirmed", "talk", { previous: null, next: { confirmedDeadline: "2026-10-19" } });
  order("t-feedback", "feedback", "approved");
  order("t-hw", "hw", "approved", "ece555");
  order("t-talk", "talk", "ready_for_human", "talks");
  order("t-done", "done-ms", "accepted", "xhs2");
  store.setSetting(ws, MILESTONE_FORECAST_SETTING, JSON.stringify({ at: "2026-10-21T08:00:00Z", goals: { pack: { p50Day: "2026-10-25", p85Day: "2026-10-27" } } }));

  // Old proposals and drafts.
  at("2026-10-01T10:00:00Z");
  order("t-proposal", "", "awaiting_plan_approval");
  store.transitionWorkOrder(ws, "t-proposal", { type: "blocked", reason: "x" }, "x1");
  store.transitionWorkOrder(ws, "t-proposal", { type: "plan.approved", approvalId: "a" }, "x2");
  store.transitionWorkOrder(ws, "t-proposal", { type: "approval.revoked", reason: "x" }, "x3");
  milestone("old-draft", "xhs", "2026-12-01", "draft");
  event("milestone.proposed", "old-draft", {});

  // The person acted yesterday.
  at("2026-10-20T18:00:00Z");
  event("op.undone", "x", {});
  at(NOW.toISOString());
  const outcome = dateAdvancePass(store, ws)!;

  expect(outcome.superseded).toEqual(["old-run"]);
  expect(outcome.adopted).toEqual([{ taskId: "new-run", title: "任务 · 盘点文件", left: 1 }]);
  expect(outcome.expired).toEqual(["failed"]);
  const rows = new Map(listAgentTasks(store, ws).map((row) => [row.taskId, row]));
  expect(rows.get("new-run")).toMatchObject({ status: "accepted", reviewedBy: "system" });
  expect(rows.get("old-run")).toMatchObject({ status: "needs_review", settled: "superseded" });
  expect(resultsAwaitingReview(store, ws).map((row) => row.taskId).sort()).toEqual(["failed-young", "young"]);
  // Accepting it did the step, as the person's 采纳 would; what it left is on the task.
  expect(store.getStepPlan(ws, "t-steps")!.steps[0]!.status).toBe("done");
  expect(store.listEvents(ws, { type: "task.note", entityId: "t-steps" }).map((note) => note.payload)).toEqual([
    { text: "助手留下的待补：提供原始数据（只有本人有）", kind: "agent_left", agentTaskId: "new-run" }]);

  // The person's own milestone goes to the forecast's cautious finish plus two days, its chain after it; course and typed dates stay.
  expect(Object.fromEntries(outcome.shifted.map((item) => [item.id, `${item.from}→${item.to}`]))).toEqual({
    pack: "2026-10-17→2026-10-29", feedback: "2026-10-24→2026-11-05" });
  expect(store.getSetting(ws, goalSettingKey("hw"))).toBeUndefined();
  expect(JSON.parse(store.getSetting(ws, goalSettingKey("talk"))!)).toEqual({ confirmedDeadline: "2026-10-19" });
  expect(outcome.asked.map((item) => item.id).sort()).toEqual(["hw", "talk"]);
  expect(store.listEvents(ws, { type: "milestone.overdue" }).map((item) => [item.entityId, (item.payload as { why: string }).why]).sort())
    .toEqual([["hw", "course"], ["talk", "person"]]);

  expect(outcome.archived.map((item) => item.id)).toEqual(["t-proposal"]);
  expect(outcome.drafts.map((item) => item.id)).toEqual(["old-draft"]);
  expect(store.listMilestones(ws).find((item) => item.id === "old-draft")!.status).toBe("archived");

  // One undo, written by the system; one message with 撤销.
  const op = store.listEvents(ws, { type: "op.applied" }).at(-1)!;
  expect(op.entityId).toBe(outcome.opId);
  const items = (op.payload as { inverse: { kind: string; items: Array<{ kind: string }> } }).inverse.items.map((item) => item.kind);
  expect(items).toEqual(["step.status", "agent.reopen", "settings.restore", "work_order.restore", "milestones.status"]);
  expect(store.lastPersonActivity(ws)).toBe("2026-10-20T18:00:00.000Z");
  const said = store.listConversationMessages(ws, store.conversationFor(ws, "2026-10-21").id).at(-1)!;
  const card = (said.payload as { card: { clarify: { question: string; options: Array<{ label: string }> }; actions: Array<{ action: string; args: { opId: string } }> } }).card;
  expect(card.clarify.question).toContain("已代为采纳");
  expect(card.clarify.options.map((option) => option.label)).toEqual(["撤销", "去待确认", "知道了"]);
  expect(card.actions[0]).toMatchObject({ action: "undo", args: { opId: outcome.opId } });
  expect(store.getSetting(ws, ADVANCE_DAY_SETTING)).toBe("2026-10-21");

  // Once a day; the asks are not repeated the next day.
  expect(dateAdvancePass(store, ws)).toBeUndefined();
  at("2026-10-22T15:00:00Z");
  const next = dateAdvancePass(store, ws)!;
  expect(next.asked).toEqual([]);
  expect(next.shifted).toEqual([]);
});

test("a milestone of the person's own is moved by itself twice at most; the third time its deadline passes it is asked about, once", () => {
  milestone("pack", "xhs", "2026-10-17");
  order("t-pack", "pack", "approved");
  // The person acts every day (the pass leaves a dormant account to the return tidy-up), but never on this work.
  const day = (iso: string) => { at(iso); event("op.undone", "x", {}, `undo:${iso}`); return dateAdvancePass(store, ws)!; };
  const dayAfter = (date: string) => `${new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T15:00:00Z`;
  const first = day("2026-10-21T15:00:00Z");
  expect(first.shifted.map((item) => item.id)).toEqual(["pack"]);
  const movedTo = first.shifted[0]!.to;
  // The next pass after that day: moved a second time.
  const second = day(dayAfter(movedTo));
  expect(second.shifted.map((item) => item.id)).toEqual(["pack"]);
  const again = second.shifted[0]!.to;
  // Third time past: not moved, asked — why "stalled", with how many times it moved.
  const third = day(dayAfter(again));
  expect(third.shifted).toEqual([]);
  expect(third.asked.map((item) => item.id)).toEqual(["pack"]);
  expect(store.listEvents(ws, { type: "milestone.overdue" }).map((item) => item.payload)).toEqual([{ deadline: again, why: "stalled", shifts: 2 }]);
  // The next day it is neither moved nor asked again.
  const fourth = day(dayAfter(dayAfter(again).slice(0, 10)));
  expect(fourth.shifted).toEqual([]);
  expect(fourth.asked).toEqual([]);
});

test("a whole task the assistant did is handed in when it left nothing for the person; one that left something stays the person's", () => {
  order("t-clean", "", "approved");
  order("t-left", "", "approved");
  for (const [taskId, orderId, left] of [["d-clean", "t-clean", []], ["d-left", "t-left", [{ what: "补充账户截图", why: "" }]]] as const) {
    const directory = path.join(dir, taskId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "audit.json"), JSON.stringify({ needsHuman: left }));
    at("2026-10-10T10:00:00Z");
    event("agent.task.requested", taskId, { title: `整件事 ${taskId}`, category: "read_research_organize", workOrderId: orderId, delegated: true });
    event("agent.task.completed", taskId, { directory, artifacts: [{ path: "a.md", sha256: "h", bytes: 1 }], needsHuman: left.length, checksPassed: true,
      inputsModified: [], reviewRequired: true });
  }
  at("2026-10-20T18:00:00Z");
  event("op.undone", "x", {});
  at(NOW.toISOString());
  const outcome = dateAdvancePass(store, ws)!;
  expect(outcome.adopted.map((item) => item.taskId).sort()).toEqual(["d-clean", "d-left"]);
  const state = (id: string) => store.listWorkOrders(ws).find((item) => item.id === id)!.state;
  expect(state("t-clean")).toBe("evidence_review");
  expect(state("t-left")).toBe("approved");
});

test("a dormant account is left for the return tidy-up", () => {
  at("2026-10-01T10:00:00Z");
  event("op.undone", "x", {});
  at(NOW.toISOString());
  expect(dateAdvancePass(store, ws)).toBeUndefined();
  expect(store.getSetting(ws, ADVANCE_DAY_SETTING)).toBeUndefined();
});

test("the message says what moved and why, and nothing when nothing did", () => {
  const empty = { superseded: [], adopted: [], expired: [], shifted: [], asked: [], archived: [], drafts: [] };
  expect(advanceMessage(empty)).toBe("");
  expect(advanceMessage({ ...empty, adopted: [{ taskId: "a", title: "x", left: 2 }], shifted: [{ id: "m", title: "样本包", from: "2026-10-17", to: "2026-10-29" }] }))
    .toBe("按今天的日期整理了待办：1 个助手成果交付超过 1 天无人审阅、自检都通过，已代为采纳，留给本人的 2 件事写在各自任务的记录里；"
      + "1 个里程碑已过截止、还有没做完的工作，按保守完成日留 2 天余量顺延：「样本包」10/17 → 10/29。助手成果的文件都还在「助手产出」里；24 小时内可撤销。");
});

test("a result made on another machine still leaves its items on the task: read from this data folder by name, else counted in one line", () => {
  vi.stubEnv("CROSSLINE_DATA_DIR", dir);
  order("t", "pack", "approved");
  // Its record was moved with the ledger into <data>/ai-output/<run>, under a Windows path the ledger still names.
  mkdirSync(path.join(dir, "ai-output", "moved"), { recursive: true });
  writeFileSync(path.join(dir, "ai-output", "moved", "audit.json"), JSON.stringify({ needsHuman: [{ what: "确认数据版本", why: "" }] }));
  at("2026-10-05T10:00:00Z");
  event("agent.task.requested", "moved", { title: "任务 · 整理", category: "read_research_organize", workOrderId: "t", stepId: "" });
  event("agent.task.completed", "moved", { directory: "C:\\Users\\karol\\Crossline\\ai-output\\moved", artifacts: [], needsHuman: 1, checksPassed: true, inputsModified: [], reviewRequired: true });
  event("agent.task.requested", "gone", { title: "任务 · 汇总", category: "read_research_organize", workOrderId: "t", stepId: "s2" });
  event("agent.task.completed", "gone", { directory: "C:\\Users\\karol\\Crossline\\ai-output\\gone", artifacts: [], needsHuman: 2, checksPassed: true, inputsModified: [], reviewRequired: true });
  at(NOW.toISOString());
  dateAdvancePass(store, ws, { now: NOW });
  const notes = store.listEvents(ws, { type: "task.note" }).map((item) => (item.payload as { text: string }).text);
  expect(notes).toContain("助手留下的待补：确认数据版本");
  expect(notes).toContain("助手留下 2 件待补，列在助手结果「任务 · 汇总」里（原记录不在这台机器上）");
  vi.unstubAllEnvs();
});

test("a proposal whose own due day went by unapproved is archived by the system the next day", () => {
  at("2026-10-19T10:00:00Z");
  store.saveWorkOrder({ id: "late-proposal", ownerId: owner, workspaceId: ws, identityId: "media", projectId: "xhs", milestoneId: "", intent: "确定周五会议议题",
    state: "awaiting_plan_approval", riskTier: "routine", estimate, payload: { dueDate: "2026-10-20" } });
  store.saveWorkOrder({ id: "fresh-proposal", ownerId: owner, workspaceId: ws, identityId: "media", projectId: "xhs", milestoneId: "", intent: "选定首轮选题",
    state: "awaiting_plan_approval", riskTier: "routine", estimate, payload: { dueDate: "2026-10-25" } });
  event("op.undone", "x", {});
  at(NOW.toISOString());
  const outcome = dateAdvancePass(store, ws)!;
  expect(outcome.archived.map((item) => item.id)).toEqual(["late-proposal"]);
});

test("an exam whose day has passed puts its preparation away and asks how it went, once", () => {
  // A course (its grading on record) and a midterm two days ago, with practice still open and one being timed.
  store.upsertProfileFact({ workspaceId: ws, identityId: "media", projectId: "ece548", slot: "grading", value: "期中 25%", status: "confirmed", sourceRef: "doc", sourceQuote: "", updatedAt: "2026-10-01T00:00:00Z" });
  milestone("ECE 548 期中考试 1 达到 A− 支撑线", "ece548", "2026-10-19");
  order("t-practice", "ECE 548 期中考试 1 达到 A− 支撑线", "approved", "ece548");
  order("t-proposal-prep", "ECE 548 期中考试 1 达到 A− 支撑线", "awaiting_plan_approval", "ece548");
  order("t-timing", "ECE 548 期中考试 1 达到 A− 支撑线", "active", "ece548");
  event("op.undone", "x", {});
  at(NOW.toISOString());
  const outcome = dateAdvancePass(store, ws)!;
  expect(outcome.archived.map((item) => item.id).sort()).toEqual(["t-practice", "t-proposal-prep"]);
  expect(store.listWorkOrders(ws).find((item) => item.id === "t-timing")!.state).toBe("active");
  expect(outcome.asked.map((item) => item.id)).toEqual(["ECE 548 期中考试 1 达到 A− 支撑线"]);
  expect(store.listEvents(ws, { type: "milestone.overdue" }).map((item) => (item.payload as { why: string }).why)).toEqual(["sitting"]);
  // Not moved like the person's own milestones: an exam's date is the course's.
  expect(outcome.shifted).toEqual([]);
});
