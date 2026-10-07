import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})) }));
import { requestCodexSupervisor } from "./codex-runtime";
import { approveMilestoneDrafts, approveWorkOrderProposals, recentAutoApprovals, revokeAutoApproval } from "./approvals";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.clearAllMocks(); });

const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
function setup() {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const add = (id: string, state: "awaiting_plan_approval" | "approved" | "active" = "awaiting_plan_approval") => store.saveWorkOrder({
    id, ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "p", milestoneId: "",
    intent: `整理 ${id}`, state, riskTier: "routine", estimate, payload: { family: "preparation" } });
  return { store, add };
}

test("全部批准 approves what it can and reports the rest instead of failing the batch", () => {
  const { store, add } = setup();
  add("a"); add("b"); add("started", "active");
  const result = approveWorkOrderProposals(TEST_CTX, ["a", "b", "started", "missing"]);
  expect(result.approved).toEqual(["a", "b"]);
  expect(result.skipped).toEqual([{ id: "started", code: "PROPOSAL_NOT_APPROVABLE" }, { id: "missing", code: "WORK_ORDER_NOT_FOUND" }]);
  expect(store.listWorkOrders(TEST_CTX.workspaceId).filter((order) => order.state === "approved").map((order) => order.id).sort()).toEqual(["a", "b"]);
});

test("an automatic approval is listed for a day, can be taken back once, and only before work starts", () => {
  const { store, add } = setup();
  add("auto");
  store.transitionWorkOrder(TEST_CTX.workspaceId, "auto", { type: "plan.approved", approvalId: "system:auto-approval" }, "auto-approved:auto");
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, idempotencyKey: "work_order.auto_approved:auto",
    type: "work_order.auto_approved", entityId: "auto", payload: { reason: "内部准备" } });
  expect(recentAutoApprovals(TEST_CTX)).toMatchObject([{ id: "auto", undoable: true }]);
  expect(recentAutoApprovals(TEST_CTX, Date.now() + 25 * 3_600_000)).toEqual([]);
  expect(revokeAutoApproval(TEST_CTX, "auto")).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]!.state).toBe("awaiting_plan_approval");
  expect(recentAutoApprovals(TEST_CTX)).toEqual([]);
  expect(revokeAutoApproval(TEST_CTX, "auto")).toEqual({ ok: false, code: "AUTO_APPROVAL_NOT_REVOCABLE" });
});

test("accepting a line's drafts approves each one as a new version and asks the worker to work backwards", () => {
  const { store } = setup();
  for (const id of ["m1", "m2"]) store.saveMilestone({ id, ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    identityId: "research", projectId: "p", title: `里程碑 ${id}`, status: "draft", version: 1, successCriteria: [] });
  const result = approveMilestoneDrafts(TEST_CTX, ["m1", "m2", "nope"]);
  expect(result.approved).toEqual(["m1", "m2"]);
  expect(result.skipped).toEqual([{ id: "nope", code: "MILESTONE_NOT_DRAFT" }]);
  expect(store.listMilestones(TEST_CTX.workspaceId).filter((item) => item.status === "approved").map((item) => [item.id, item.version]))
    .toEqual(expect.arrayContaining([["m1", 2], ["m2", 2]]));
  expect(requestCodexSupervisor).toHaveBeenCalledWith(TEST_CTX, "/v1/goals/auto-backplan", expect.objectContaining({ method: "POST" }));
});
