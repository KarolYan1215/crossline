import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { applyTaskOp, postponeTask } from "./task-ops";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId;
function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-08T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "w1", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "处理 MoS₂ 实测数据",
    state: "approved", riskTier: "routine", estimate: { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { materialContract: [], evidenceContract: [] } });
  return store;
}

test("推迟 because someone owes something opens a waiting item; low energy is recorded with when it happened and moves the start", () => {
  const store = setup();
  expect(postponeTask(TEST_CTX, "w1", { reason: "waiting", date: "2026-10-12", who: "师兄", what: "实测数据", text: "" })).toEqual({ ok: true });
  expect(store.listWaitingItems(ws)).toEqual([expect.objectContaining({ who: "师兄", title: "实测数据", followUpAt: "2026-10-12", blocks: ["w1"] })]);
  expect(postponeTask(TEST_CTX, "w1", { reason: "waiting", date: "2026-10-12", who: "", what: " ", text: "" })).toEqual({ ok: false, code: "POSTPONE_WHAT_REQUIRED" });

  expect(postponeTask(TEST_CTX, "w1", { reason: "energy", date: "2026-10-10", who: "", what: "", text: "熬夜后注意力差" })).toEqual({ ok: true });
  expect(store.listWorkOrders(ws)[0]?.payload).toMatchObject({ notBefore: "2026-10-10" });
  expect(store.listEvents(ws, { type: "energy.observed" }).at(-1)?.payload).toMatchObject({ level: "low", note: "熬夜后注意力差" });
  expect(store.listPreferences(ws).some((entry) => entry.source === "postpone" && entry.text.includes("精力低"))).toBe(true);
  // Every postponement is on the task's record, reason included.
  expect(store.listEvents(ws, { type: "task.note", entityId: "w1" }).map((event) => (event.payload as { text: string }).text))
    .toEqual(["推迟至 2026-10-12 · 等待他人提供：师兄 · 实测数据", "推迟至 2026-10-10 · 精力不足：熬夜后注意力差"]);
});

test("a note from the task's record is kept in the person's words", async () => {
  const store = setup();
  expect(await applyTaskOp(TEST_CTX, "w1", { type: "note", date: "", minutes: 0, stepId: "", text: "跑通了第一组数据", who: "", energy: "", summary: "记录" })).toEqual({ ok: true });
  expect(store.listEvents(ws, { type: "task.note" })[0]?.payload).toEqual({ text: "跑通了第一组数据", kind: "note" });
});
