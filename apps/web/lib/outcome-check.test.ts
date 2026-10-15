import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { completeWorkOrderExecution, saveSchedulePreferences, startWorkOrderExecution } from "./crossline";
import { answerAsk, collectAsks, loadAsks } from "./asks";
import { countPending } from "./pending";
import { outcomeAsks, outcomeNudgeInputs } from "./outcome-check";
import { TEST_CTX } from "./test-support";

/** Following up work whose result was not known at completion (the owner's decision of 2026-10-15), on a real store. */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId;
const HOUR = 3_600_000;

function setup() {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" }], importance: {} });
  store.saveMilestone({ id: "mid1", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "ece548", title: "ECE 548 期中 1 ≥ 85",
    version: 1, status: "approved", successCriteria: [{ id: "score", statement: "期中 1 成绩 ≥ 85", required: true, measure: { kind: "threshold", unit: "分", comparator: "gte", value: 85 } }] });
  const order = (id: string, title: string) => store.saveWorkOrder({ id, ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "ece548",
    milestoneId: "mid1", intent: title, state: "ready_for_human", riskTier: "milestone", payload: { title, family: "deep_work" },
    estimate: { p25Minutes: 60, p50Minutes: 90, p85Minutes: 120, source: "llm_prior", observationCount: 0, confidence: "low" } });
  return { store, order };
}

test("an exam's score is asked about the day after; the answer is read against the milestone's line and closes the question", async () => {
  const { store, order } = setup();
  order("exam", "ECE 548 期中考试 1");
  startWorkOrderExecution(TEST_CTX, "exam");
  const done = new Date("2026-10-27T20:00:00.000Z");
  completeWorkOrderExecution(TEST_CTX, "exam", [], [], done.toISOString());
  // Not before its time: a score is not known the same evening.
  expect(outcomeAsks(TEST_CTX, new Date(done.getTime() + 2 * HOUR))).toEqual([]);
  const next = new Date(done.getTime() + 25 * HOUR);
  const [ask] = outcomeAsks(TEST_CTX, next);
  expect(ask).toMatchObject({ kind: "outcome_check", entityId: "exam", title: "「ECE 548 期中考试 1」的成绩或结果出来了吗？" });
  expect(ask!.options.map((option) => option.id)).toEqual(["result", "later", "stop"]);
  // The 小帮手's buttons for a score are only a cue to type: a number needs words.
  expect(outcomeNudgeInputs(TEST_CTX, next)[0]).toMatchObject({ askId: ask!.id, options: [], laterLabel: "说一下成绩，或哪天出结果" });
  expect(collectAsks(TEST_CTX, next).some((item) => item.id === ask!.id)).toBe(true);
  // Asked only by the 小帮手 (decided 2026-10-15): never on 待决, Today's stack or any count.
  expect((await loadAsks(TEST_CTX, next)).some((item) => item.kind === "outcome_check")).toBe(false);
  vi.stubEnv("CROSSLINE_FIXED_NOW", next.toISOString());
  expect(countPending(TEST_CTX).asks).toBe(0);
  vi.unstubAllEnvs();

  expect(await answerAsk(TEST_CTX, ask!.id, "later", { date: "2026-11-03" }, next)).toMatchObject({ ok: true });
  expect(outcomeAsks(TEST_CTX, new Date("2026-11-02T20:00:00.000Z"))).toEqual([]);
  const back = new Date("2026-11-03T15:00:00.000Z");
  const [again] = outcomeAsks(TEST_CTX, back);
  expect(again!.fingerprint).not.toBe(ask!.fingerprint);

  expect(await answerAsk(TEST_CTX, again!.id, "result", { score: "88/100" }, back)).toMatchObject({ ok: true });
  expect(outcomeAsks(TEST_CTX, back)).toEqual([]);
  expect(store.listEvents(ws, { type: "milestone_gate.judged", entityId: "exam" })[0]?.payload).toMatchObject({ milestoneId: "mid1", verdict: "pass",
    source: "person_outcome", criteriaVerdict: [{ criterionId: "score", met: "met", observed: "本人报告：88/100" }] });
  expect(store.getWorkOrder(ws, "exam")!.state).toBe("accepted");
});

test("how a draft went is asked with three one-tap levels; a level is a task record, not milestone progress", async () => {
  const { store, order } = setup();
  order("draft", "起草组会报告");
  startWorkOrderExecution(TEST_CTX, "draft");
  const done = new Date("2026-10-20T18:00:00.000Z");
  completeWorkOrderExecution(TEST_CTX, "draft", [], [], done.toISOString());
  const later = new Date(done.getTime() + 3 * HOUR);
  const [ask] = outcomeAsks(TEST_CTX, later);
  expect(outcomeNudgeInputs(TEST_CTX, later)[0]!.options.map((option) => option.label)).toEqual(["顺利", "勉强", "有遗漏"]);
  expect(await answerAsk(TEST_CTX, ask!.id, "gaps", { note: "少了一张图" }, later)).toMatchObject({ ok: true });
  expect(store.listEvents(ws, { type: "assessment.answered", entityId: "draft" })[0]?.payload).toMatchObject({ level: "gaps", note: "少了一张图" });
  expect(store.listEvents(ws, { type: "milestone_gate.judged", entityId: "draft" })).toEqual([]);
  expect(outcomeAsks(TEST_CTX, later)).toEqual([]);
});

test("homework handed in leaves nothing to ask", () => {
  const { order } = setup();
  order("hw2", "完成 ECE 555 作业 2");
  startWorkOrderExecution(TEST_CTX, "hw2");
  completeWorkOrderExecution(TEST_CTX, "hw2", []);
  expect(outcomeAsks(TEST_CTX, new Date(Date.now() + 48 * HOUR))).toEqual([]);
});

test("撤销合并 from the drawer brings the absorbed task back and the kept one's payload, at any time", async () => {
  const { store, order } = setup();
  const { archiveWorkOrder } = await import("./crossline");
  const { undoMerge } = await import("./undo");
  order("keep", "汇集 ECE 548 复习材料");
  order("ask", "确认 ECE 548 期中考查范围");
  const before = store.getWorkOrder(ws, "keep")!.payload;
  store.saveWorkOrder({ ...store.getWorkOrder(ws, "keep")!, payload: { ...(before as object), mergedFrom: [{ id: "ask" }] } });
  archiveWorkOrder(TEST_CTX, "ask", "与「汇集 ECE 548 复习材料」合并", { bySystem: true });
  // The worker's record of the merge (apps/worker/src/dedupe.ts), written days ago.
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: ws, idempotencyKey: "op.applied:op-m", type: "op.applied", entityId: "op-m",
    payload: { label: "合并任务", inverse: { kind: "task.unmerge", keepId: "keep", payload: before, plan: null, restore: ["ask"] } } });
  expect(undoMerge(TEST_CTX, "ask")).toEqual({ ok: true });
  expect(store.getWorkOrder(ws, "ask")!.state).toBe("ready_for_human");
  expect(store.getWorkOrder(ws, "keep")!.payload).toEqual(before);
  expect(undoMerge(TEST_CTX, "nothing")).toEqual({ ok: false, code: "MERGE_NOT_FOUND" });
});
