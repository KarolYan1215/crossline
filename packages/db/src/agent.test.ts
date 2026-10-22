import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  agentApprovalDecision, approveCategory, CLEAN_RUNS_TO_TRUST, CrosslineStore, declineCategory, decideAgentApproval, isPaused, listAgentTasks, pendingAgentApprovals,
  pendingCategoryRequests, readCategories, reopenAgentResult, requestAgentApproval, requestCategory, resultsAwaitingReview, reviewAgentTask, setPaused,
  settleAgentResult
} from "./index";

let store: CrosslineStore;
let ws: string;
beforeEach(() => { store = new CrosslineStore(":memory:"); ws = store.createPrincipalWithWorkspace("u", "w").workspace.id; });
afterEach(() => store.close());

const event = (type: string, taskId: string, payload: object) => store.appendEvent({ ownerId: store.getWorkspaceOwnerId(ws)!, workspaceId: ws, idempotencyKey: `${type}:${taskId}:${JSON.stringify(payload).length}`, type, entityId: taskId, payload });
const finish = (taskId: string, over: object = {}) => {
  event("agent.task.requested", taskId, { title: "整理", category: "read_research_organize", workOrderId: "wo-1" });
  event("agent.task.completed", taskId, { directory: "C:\\ai\\t", durationMs: 5000, commands: 4, denied: 1, artifacts: [{ path: "n.md", sha256: "x", bytes: 3 }], needsHuman: 0,
    checksPassed: true, inputsModified: [], reviewRequired: true, ...over });
};

test("a task's life is read back from the events: running, then waiting for review, then the person's verdict", () => {
  event("agent.task.requested", "t1", { title: "整理", category: "read_research_organize", workOrderId: "wo-1" });
  expect(listAgentTasks(store, ws)[0]).toMatchObject({ taskId: "t1", status: "running", workOrderId: "wo-1" });
  event("agent.task.completed", "t1", { directory: "C:\\ai\\t1", durationMs: 9000, commands: 5, denied: 2, artifacts: [{ path: "a.md", sha256: "h", bytes: 10 }], needsHuman: 1, checksPassed: true, inputsModified: [], reviewRequired: true });
  expect(listAgentTasks(store, ws)[0]).toMatchObject({ status: "needs_review", commands: 5, denied: 2, needsHuman: 1, artifacts: [{ path: "a.md" }] });
});

test("a run with no outcome long after it started was lost with the process, not still going", () => {
  event("agent.task.requested", "t2", { title: "x", category: "draft_text" });
  expect(listAgentTasks(store, ws, new Date(Date.now() + 9 * 3_600_000))[0]?.status).toBe("stale");
  expect(listAgentTasks(store, ws, new Date(Date.now() + 3_600_000))[0]?.status).toBe("running");
});

test("a result that needs no review is accepted by its checks, and a blocked run says why", () => {
  finish("t3", { reviewRequired: false });
  expect(listAgentTasks(store, ws)[0]?.status).toBe("accepted");
  event("agent.task.requested", "t4", { title: "y", category: "draft_text" });
  event("agent.task.blocked", "t4", { code: "SKILL_USAGE_LIMIT" });
  expect(listAgentTasks(store, ws).find((task) => task.taskId === "t4")).toMatchObject({ status: "blocked", blockerCode: "SKILL_USAGE_LIMIT" });
});

test("the person's verdict moves the kind's trust, and only a clean, accepted result counts", () => {
  approveCategory(store, ws, "read_research_organize");
  for (let i = 0; i < CLEAN_RUNS_TO_TRUST; i += 1) {
    finish(`ok-${i}`);
    expect(reviewAgentTask(store, ws, `ok-${i}`, "accepted")).toMatchObject({ ok: true });
  }
  expect(readCategories(store, ws).read_research_organize).toMatchObject({ trust: "auto_checked", cleanRuns: CLEAN_RUNS_TO_TRUST });
  // Kind words do not make a result that failed its own checks count towards trust, and a rejection takes it all away.
  finish("bad", { checksPassed: false });
  reviewAgentTask(store, ws, "bad", "accepted");
  expect(readCategories(store, ws).read_research_organize).toMatchObject({ trust: "review_all", cleanRuns: 0 });
  expect(listAgentTasks(store, ws).find((task) => task.taskId === "bad")?.status).toBe("accepted");
});

test("a task that is still running, or does not exist, cannot be reviewed", () => {
  event("agent.task.requested", "t5", { title: "z", category: "draft_text" });
  expect(reviewAgentTask(store, ws, "t5", "accepted")).toEqual({ ok: false, code: "TASK_NOT_REVIEWABLE" });
  expect(reviewAgentTask(store, ws, "nope", "accepted")).toEqual({ ok: false, code: "TASK_NOT_FOUND" });
});

test("a kind the assistant wants but is not allowed is asked about once, and goes away when answered", () => {
  requestCategory(store, ws, "data_code_sim", "wo-1", "AI 部分指向数据");
  requestCategory(store, ws, "data_code_sim", "wo-2", "again");
  expect(pendingCategoryRequests(store, ws)).toEqual([{ category: "data_code_sim", workOrderId: "wo-1", why: "AI 部分指向数据" }]);
  approveCategory(store, ws, "data_code_sim");
  expect(pendingCategoryRequests(store, ws)).toEqual([]);
  declineCategory(store, ws, "draft_text");
  requestCategory(store, ws, "draft_text", "wo-3", "no");
  expect(pendingCategoryRequests(store, ws)).toEqual([]);
  // Approving what was declined undoes the decline.
  approveCategory(store, ws, "draft_text");
  expect(readCategories(store, ws).draft_text).toBeDefined();
});

test("the pause switch", () => {
  expect(isPaused(store, ws)).toBe(false);
  setPaused(store, ws, true);
  expect(isPaused(store, ws)).toBe(true);
});

test("a question from the guard waits for the person, is answered once, and expires if nobody does", () => {
  const id = requestAgentApproval(store, ws, "t1", { kind: "command", subject: "winget install X", rule: "install.global", reason: "系统级安装" })!;
  expect(pendingAgentApprovals(store, ws)).toMatchObject([{ id, subject: "winget install X", rule: "install.global" }]);
  expect(agentApprovalDecision(store, ws, id)).toBeUndefined();
  expect(decideAgentApproval(store, ws, id, "accepted")).toBe(true);
  expect(decideAgentApproval(store, ws, id, "declined")).toBe(false);
  expect(agentApprovalDecision(store, ws, id)).toBe("accepted");
  expect(pendingAgentApprovals(store, ws)).toEqual([]);
  const old = requestAgentApproval(store, ws, "t1", { kind: "command", subject: "later", rule: "git.remote", reason: "" })!;
  expect(pendingAgentApprovals(store, ws, new Date(Date.now() + 60 * 60_000))).toEqual([]);
  expect(old).toBeTruthy();
  expect(decideAgentApproval(store, ws, "unknown", "accepted")).toBe(false);
});

test("a result is no longer a decision once its task is finished or archived, or a later run of the same work replaced it", () => {
  vi.useFakeTimers();
  try {
    const order = (id: string, state: "approved" | "archived") => store.saveWorkOrder({ id, ownerId: store.getWorkspaceOwnerId(ws)!, workspaceId: ws, identityId: "research",
      projectId: "p", milestoneId: "m", intent: id, state, riskTier: "routine", payload: {},
      estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" } });
    order("live", "approved");
    order("gone", "archived");
    const run = (taskId: string, workOrderId: string, title: string, at: string) => {
      vi.setSystemTime(new Date(at));
      event("agent.task.requested", taskId, { title, category: "read_research_organize", workOrderId });
      event("agent.task.completed", taskId, { directory: "C:\\ai\\t", artifacts: [], needsHuman: 1, checksPassed: true, inputsModified: [], reviewRequired: true });
    };
    run("old", "live", "清单 · 汇集讲义", "2026-10-09T00:00:00Z");
    run("new", "live", "清单 · 汇集讲义", "2026-10-15T00:00:00Z");
    run("other-step", "live", "清单 · 起草邮件", "2026-10-10T00:00:00Z");
    run("dead", "gone", "别的", "2026-10-11T00:00:00Z");
    run("flow-a", "", "每周整理收藏夹", "2026-10-16T00:00:00Z");
    run("flow-b", "", "每周整理收藏夹", "2026-10-20T00:00:00Z");
    expect(resultsAwaitingReview(store, ws).map((task) => task.taskId).sort()).toEqual(["flow-b", "new", "other-step"]);
    // The replaced and the dead keep their own status: their files are still shown with the task.
    expect(listAgentTasks(store, ws).filter((task) => task.status === "needs_review")).toHaveLength(6);
    // Steps of one task whose titles have no step part (「任务 · 」) are different work, each still the person's to look at.
    run("s4", "live", "两个案例 · ", "2026-10-17T00:00:00Z");
    event("agent.task.requested", "s5", { title: "两个案例 · ", category: "read_research_organize", workOrderId: "live", stepId: "v1s5" });
    event("agent.task.completed", "s5", { directory: "C:\\ai\\t", artifacts: [], needsHuman: 1, checksPassed: true, inputsModified: [], reviewRequired: true });
    expect(resultsAwaitingReview(store, ws).map((task) => task.taskId)).toEqual(expect.arrayContaining(["s4", "s5"]));
  } finally { vi.useRealTimers(); }
});

test("the daily pass puts a result away or accepts it in the person's place, earning no trust, and an undo hands it back", () => {
  approveCategory(store, ws, "read_research_organize");
  finish("put-away", { reviewReasons: ["涉及对外发送、发布、上传或付款"] });
  expect(listAgentTasks(store, ws)[0]).toMatchObject({ external: true, completedAt: expect.any(String) });
  expect(settleAgentResult(store, ws, "put-away", "expired", { day: "2026-10-21" })).toBe(true);
  expect(settleAgentResult(store, ws, "put-away", "expired", { day: "2026-10-21" })).toBe(false);
  expect(listAgentTasks(store, ws)[0]).toMatchObject({ status: "needs_review", settled: "expired" });
  expect(resultsAwaitingReview(store, ws)).toEqual([]);
  finish("adopted");
  expect(reviewAgentTask(store, ws, "adopted", "accepted", "代为采纳", { by: "system" })).toMatchObject({ ok: true });
  expect(listAgentTasks(store, ws).find((task) => task.taskId === "adopted")).toMatchObject({ status: "accepted", reviewedBy: "system" });
  expect(readCategories(store, ws).read_research_organize).toMatchObject({ cleanRuns: 0 });
  const principal = store.getWorkspaceOwnerId(ws)!;
  reopenAgentResult(store, ws, "put-away", principal);
  reopenAgentResult(store, ws, "adopted", principal);
  expect(listAgentTasks(store, ws).map((task) => [task.taskId, task.status, task.settled ?? ""]).sort()).toEqual([["adopted", "needs_review", ""], ["put-away", "needs_review", ""]]);
  // The person's own acceptance is never reopened by an undo of the pass.
  reviewAgentTask(store, ws, "adopted", "accepted");
  reopenAgentResult(store, ws, "adopted", principal);
  expect(listAgentTasks(store, ws).find((task) => task.taskId === "adopted")?.status).toBe("accepted");
});

test("only an account made from 2026-10-22 has the three kinds on by default; an older one that never chose has none", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  const old = store.createPrincipalWithWorkspace("u-old", "old").workspace.id;
  vi.useRealTimers();
  expect(readCategories(store, old)).toEqual({});
  expect(Object.keys(readCategories(store, ws)).sort()).toEqual(["draft_text", "files_calendar_prep", "read_research_organize"]);
});
