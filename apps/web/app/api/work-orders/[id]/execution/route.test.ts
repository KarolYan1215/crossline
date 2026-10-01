import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { TEST_CTX } from "../../../../../lib/test-support";
vi.mock("../../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));
import * as route from "./route";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const post = (body: unknown) => route.POST(
  new Request("http://localhost/api/work-orders/w1/execution", { method: "POST", body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: "w1" }) }
);

const seed = () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({
    id: "w1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "p", milestoneId: "m", intent: "审阅实验结论", state: "ready_for_human", riskTier: "milestone",
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { materialContract: [], evidenceContract: [] }
  });
  return store;
};

test("a malformed evidence claim is rejected instead of being written to the ledger", async () => {
  const store = seed();
  await post({ action: "start" });
  const response = await post({ action: "complete", evidence: [{ kind: "guess", uri: "x", description: "y" }] });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ ok: false, code: "INVALID_EVIDENCE_CLAIM" });
  expect(store.listEvidenceClaims(TEST_CTX.workspaceId)).toEqual([]);
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("active");
});

test("a malformed checklist answer is rejected instead of being written to the ledger", async () => {
  const store = seed();
  await post({ action: "start" });
  const response = await post({ action: "complete", evidence: [], checklistAnswers: [{ questionId: "", answer: "是" }] });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ ok: false, code: "INVALID_CHECKLIST_ANSWER" });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("active");
});

test("checklist answers submitted with completion land on the closing execution", async () => {
  const store = seed();
  await post({ action: "start" });
  const response = await post({
    action: "complete", evidence: [],
    checklistAnswers: [{ questionId: "q1", answer: "是" }, { questionId: "q2", answer: "写完了综述" }]
  });
  expect(response.status).toBe(200);
  expect(store.listExecutions(TEST_CTX.workspaceId)[0]?.checklistAnswers).toEqual([
    { questionId: "q1", answer: "是" }, { questionId: "q2", answer: "写完了综述" }
  ]);
});

test("pausing without a reason is refused, and unknown actions cannot reach the state machine", async () => {
  const store = seed();
  await post({ action: "start" });
  expect((await post({ action: "pause", reason: "  " })).status).toBe(400);
  expect((await post({ action: "demolish" })).status).toBe(400);
  expect(store.listExecutions(TEST_CTX.workspaceId)[0]?.interruptions).toEqual([]);
});

test("discarding a work order needs a reason, and the reason is kept on the ledger", async () => {
  const store = seed();
  expect((await post({ action: "archive", reason: "  " })).status).toBe(400);
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).not.toBe("archived");
  expect((await post({ action: "archive", reason: "提案读不通，重收一次" })).status).toBe(200);
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("archived");
  expect(store.listEvents(TEST_CTX.workspaceId).find((event) => event.type === "work_order.archived")?.payload)
    .toEqual({ reason: "提案读不通，重收一次" });
});
