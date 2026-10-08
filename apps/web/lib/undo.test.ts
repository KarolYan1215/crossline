import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { answerAsk, collectAsks } from "./asks";
import { archiveWorkOrder } from "./crossline";
import { applyChange } from "./impact";
import { TEST_CTX } from "./test-support";
import { recentOps, undoOp, withUndo } from "./undo";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const NOW = new Date("2026-10-08T15:00:00.000Z");
const ws = TEST_CTX.workspaceId;
const estimate = { p25Minutes: 30, p50Minutes: 60, p85Minutes: 120, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "w1", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "整理实验数据",
    state: "ready_for_human", riskTier: "routine", estimate, payload: { materialContract: [], evidenceContract: [], dueDate: "2026-10-20" } });
  return store;
}

test("「不等了」 pressed by mistake is undone: the waiting item is open again on its day and asked about again", async () => {
  const store = setup();
  store.saveWaitingItem({ id: "wait-1", ownerId: TEST_CTX.principalId, workspaceId: ws, title: "西湖 MoS2 真实测量数据", who: "师兄",
    expectedAt: "2026-10-08", approximate: true, followUpAt: "2026-10-08", state: "open", blocks: ["w1"], source: "manual" });
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "waiting_due")!;
  const answered = await answerAsk(TEST_CTX, ask.id, "cancelled", {}, NOW);
  expect(answered).toMatchObject({ ok: true, op: { id: expect.any(String) } });
  expect(store.listWaitingItems(ws)[0]?.state).toBe("cancelled");
  const op = recentOps(TEST_CTX)[0]!;
  expect(op.label).toContain("西湖 MoS2 真实测量数据");
  expect(undoOp(TEST_CTX, op.id)).toMatchObject({ ok: true });
  expect(store.listWaitingItems(ws)[0]).toMatchObject({ state: "open", followUpAt: "2026-10-08" });
  expect(collectAsks(TEST_CTX, NOW).some((item) => item.id === ask.id)).toBe(true);
  // Undone once: it leaves the list and cannot be undone twice.
  expect(recentOps(TEST_CTX)).toEqual([]);
  expect(undoOp(TEST_CTX, op.id)).toEqual({ ok: false, code: "OP_NOT_UNDOABLE" });
});

test("archiving and a duration change are undone to exactly what they were", async () => {
  const store = setup();
  await withUndo(TEST_CTX, "归档：整理实验数据", () => archiveWorkOrder(TEST_CTX, "w1", ""));
  expect(store.listWorkOrders(ws)[0]?.state).toBe("archived");
  expect(undoOp(TEST_CTX, recentOps(TEST_CTX)[0]!.id)).toMatchObject({ ok: true });
  expect(store.listWorkOrders(ws)[0]?.state).toBe("ready_for_human");

  await withUndo(TEST_CTX, "修改时长", () => applyChange(TEST_CTX, { kind: "estimate", workOrderId: "w1", p50Minutes: 240 }));
  await withUndo(TEST_CTX, "修改截止日", () => applyChange(TEST_CTX, { kind: "due", workOrderId: "w1", date: "2026-10-25" }));
  expect(store.listWorkOrders(ws)[0]).toMatchObject({ estimate: { p50Minutes: 240 }, payload: { dueDate: "2026-10-25" } });
  const [due, duration] = recentOps(TEST_CTX);
  expect(undoOp(TEST_CTX, due!.id)).toMatchObject({ ok: true });
  expect(undoOp(TEST_CTX, duration!.id)).toMatchObject({ ok: true });
  expect(store.listWorkOrders(ws)[0]).toMatchObject({ estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 120 }, payload: { dueDate: "2026-10-20" } });
});

test("an operation that failed or changed nothing records nothing to undo", async () => {
  setup();
  await withUndo(TEST_CTX, "归档：不存在", () => archiveWorkOrder(TEST_CTX, "missing", ""));
  await withUndo(TEST_CTX, "无变化", () => ({ ok: true }));
  expect(recentOps(TEST_CTX)).toEqual([]);
});
