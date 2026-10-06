import { afterEach, beforeEach, expect, test } from "vitest";
import {
  agentApprovalDecision, approveCategory, CLEAN_RUNS_TO_TRUST, CrosslineStore, declineCategory, decideAgentApproval, isPaused, listAgentTasks, pendingAgentApprovals,
  pendingCategoryRequests, readCategories, requestAgentApproval, requestCategory, reviewAgentTask, setPaused
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
