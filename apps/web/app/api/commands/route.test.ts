import { expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "local-owner", workspaceId: "personal-crossline", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "local-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

const startWorkOrderExecution = vi.fn();
const pauseWorkOrderExecution = vi.fn();
const resumeWorkOrderExecution = vi.fn();
const completeWorkOrderExecution = vi.fn();
const addCapturedTaskWithId = vi.fn();
vi.mock("../../../lib/crossline", () => ({
  addCapturedTaskWithId: (...args: unknown[]) => addCapturedTaskWithId(...args),
  startWorkOrderExecution: (...args: unknown[]) => startWorkOrderExecution(...args),
  pauseWorkOrderExecution: (...args: unknown[]) => pauseWorkOrderExecution(...args),
  resumeWorkOrderExecution: (...args: unknown[]) => resumeWorkOrderExecution(...args),
  completeWorkOrderExecution: (...args: unknown[]) => completeWorkOrderExecution(...args)
}));

const requestCodexSupervisor = vi.fn();
vi.mock("../../../lib/codex-runtime", () => ({
  requestCodexSupervisor: (...args: unknown[]) => requestCodexSupervisor(...args)
}));

const post = async (body: Record<string, unknown>) => {
  const { POST } = await import("./route");
  return POST(new Request("http://local/api/commands", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }));
};

const envelope = (type: string, payload: Record<string, unknown>) => ({
  ownerId: "local-owner", workspaceId: "personal-crossline", clientCommandId: "c1",
  clientSequence: 1, type, payload, createdAt: "2026-09-15T00:00:00.000Z"
});

test("task.capture triggers a fire-and-forget background-facts extraction call, keyed on the capture's own text", async () => {
  requestCodexSupervisor.mockResolvedValueOnce({ state: "extracted", factCount: 1 });
  const response = await post(envelope("task.capture", { title: "整理实验结果", context: "论文相关" }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ accepted: true, clientCommandId: "c1" });
  expect(addCapturedTaskWithId).toHaveBeenCalledWith(TEST_CTX, { title: "整理实验结果", context: "论文相关" }, "c1", "c1");
  expect(requestCodexSupervisor).toHaveBeenCalledWith(TEST_CTX, "/v1/background-facts/extract", expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ captureTitle: "整理实验结果", captureContext: "论文相关" })
  }));
});

test("a background-facts extraction failure never surfaces as a capture failure", async () => {
  requestCodexSupervisor.mockRejectedValueOnce(new Error("supervisor unavailable"));
  const response = await post(envelope("task.capture", { title: "整理实验结果", context: "" }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ accepted: true, clientCommandId: "c1" });
});

test("the offline boundary rejects the removed completion shortcut", async () => {
  const response = await post(envelope("task.complete", { taskId: "missing" }));
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ code: "COMMAND_TYPE_NOT_ALLOWED" });
});

test("work_order.start dispatches to the same function the online execution route uses", async () => {
  startWorkOrderExecution.mockReturnValueOnce({ ok: true });
  const response = await post(envelope("work_order.start", { workOrderId: "w1" }));
  expect(response.status).toBe(200);
  expect(startWorkOrderExecution).toHaveBeenCalledWith(TEST_CTX, "w1", undefined);
});

test("a work order that moved on under this command surfaces as a 409, not a generic failure", async () => {
  startWorkOrderExecution.mockReturnValueOnce({ ok: false, code: "EXECUTION_NOT_STARTABLE" });
  const response = await post(envelope("work_order.start", { workOrderId: "w1" }));
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({ code: "EXECUTION_NOT_STARTABLE" });
});

test("a missing work order is a 404, not a conflict", async () => {
  startWorkOrderExecution.mockReturnValueOnce({ ok: false, code: "WORK_ORDER_NOT_FOUND" });
  const response = await post(envelope("work_order.start", { workOrderId: "w1" }));
  expect(response.status).toBe(404);
});

test("an id that could never have been issued here is refused before reaching the store", async () => {
  const response = await post(envelope("work_order.start", { workOrderId: "../etc/passwd" }));
  expect(response.status).toBe(404);
  expect(startWorkOrderExecution).not.toHaveBeenCalled();
});

test("work_order.pause validates its reason the same way the online route does", async () => {
  pauseWorkOrderExecution.mockReturnValueOnce({ ok: false, code: "INTERRUPTION_REASON_REQUIRED" });
  const response = await post(envelope("work_order.pause", { workOrderId: "w1", reason: "" }));
  expect(response.status).toBe(400);
  expect(pauseWorkOrderExecution).toHaveBeenCalledWith(TEST_CTX, "w1", "", undefined);
});

test("work_order.resume dispatches with just a work order id", async () => {
  resumeWorkOrderExecution.mockReturnValueOnce({ ok: true });
  const response = await post(envelope("work_order.resume", { workOrderId: "w1" }));
  expect(response.status).toBe(200);
  expect(resumeWorkOrderExecution).toHaveBeenCalledWith(TEST_CTX, "w1", undefined);
});

test("work_order.complete rejects a malformed evidence claim before it ever reaches the store", async () => {
  const response = await post(envelope("work_order.complete", { workOrderId: "w1", evidence: [{ kind: "guess", uri: "x", description: "y" }] }));
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ code: "INVALID_EVIDENCE_CLAIM" });
  expect(completeWorkOrderExecution).not.toHaveBeenCalled();
});

test("work_order.complete forwards well-formed evidence", async () => {
  completeWorkOrderExecution.mockReturnValueOnce({ ok: true });
  const response = await post(envelope("work_order.complete", {
    workOrderId: "w1", evidence: [{ kind: "record", uri: "local://note", description: "结论记录" }]
  }));
  expect(response.status).toBe(200);
  expect(completeWorkOrderExecution).toHaveBeenCalledWith(TEST_CTX, "w1", [{ kind: "record", uri: "local://note", description: "结论记录" }], [], undefined, undefined, undefined);
});

test("a completion queued offline keeps the minutes the person tapped and the checklist they answered", async () => {
  completeWorkOrderExecution.mockReturnValueOnce({ ok: true });
  await post(envelope("work_order.complete", { workOrderId: "w1", evidence: [], reportedMinutes: 45, reportedSource: "one_tap",
    checklistAnswers: [{ questionId: "q1", answer: "做完了" }] }));
  expect(completeWorkOrderExecution).toHaveBeenCalledWith(TEST_CTX, "w1", [], [{ questionId: "q1", answer: "做完了" }], undefined,
    { minutes: 45, source: "one_tap" }, undefined);
});

test("a completion queued offline keeps the 完成情况 the person picked; a malformed one is simply left out", async () => {
  completeWorkOrderExecution.mockReturnValueOnce({ ok: true });
  await post(envelope("work_order.complete", { workOrderId: "w1", evidence: [], outcome: { level: "gaps", note: "第 4 题没做完" } }));
  expect(completeWorkOrderExecution).toHaveBeenLastCalledWith(TEST_CTX, "w1", [], [], undefined, undefined, { level: "gaps", note: "第 4 题没做完" });
  completeWorkOrderExecution.mockReturnValueOnce({ ok: true });
  await post(envelope("work_order.complete", { workOrderId: "w1", evidence: [], outcome: { level: "perfect" } }));
  expect(completeWorkOrderExecution).toHaveBeenLastCalledWith(TEST_CTX, "w1", [], [], undefined, undefined, undefined);
});
