import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DELIVERABLE_JUDGED } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { answerGap, gapAsks, settleDeliverables } from "./deliverables";
import { undoOp } from "./undo";
import { TEST_CTX } from "./test-support";

/** The web's half of the system's acceptance (docs/plans/attention-ledger-1120.md §7.2). */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId, owner = TEST_CTX.principalId;
const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
const NOW = new Date("2026-11-21T12:00:00.000Z");

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const order = (id: string, state: string, milestoneId = "") => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId,
    intent: `任务 ${id}`, state: state as "approved", riskTier: "routine", estimate, payload: { materialContract: [], family: "deep_work" } });
  const judged = (doc: string, task: string, verdict: string, criterion: string, extra: Record<string, unknown> = {}) => store.appendEvent({ ownerId: owner, workspaceId: ws,
    idempotencyKey: `${DELIVERABLE_JUDGED}:${doc}`, type: DELIVERABLE_JUDGED, entityId: doc,
    payload: { doc, task, verdict, criterion, quote: "Q5", gap: "", external: false, why: "五题齐全", fileName: `${doc}.pdf`, uri: `file:///C:/${doc}.pdf`, folderId: "f1", ...extra } });
  return { store, order, judged };
}

test("a passing deliverable closes its open task once, said with 撤销; evidence and unrelated files close nothing", () => {
  const { store, order, judged } = setup();
  order("hw", "approved"); order("other", "approved");
  judged("d1", "hw", "deliverable", "pass"); judged("d2", "other", "evidence", "pass"); judged("d3", "", "unrelated", "cannot_read");
  expect(settleDeliverables(TEST_CTX, NOW)).toEqual(["hw"]);
  expect(store.getWorkOrder(ws, "hw")!.state).toBe("accepted");
  expect(store.getWorkOrder(ws, "other")!.state).toBe("approved");
  const said = store.listRecentNudges(ws, "2026-11-01T00:00:00.000Z").filter((message) => (message.payload.nudge as { kind?: string }).kind === "deliverable_closed");
  expect(said).toHaveLength(1);
  expect(JSON.stringify(said[0]!.payload)).toContain("d1.pdf");
  expect(settleDeliverables(TEST_CTX, NOW)).toEqual([]);
});

test("撤销 opens the task again, is learned as a preference, and the same file does not close it a second time", () => {
  const { store, order, judged } = setup();
  order("hw", "approved");
  judged("d1", "hw", "deliverable", "pass");
  settleDeliverables(TEST_CTX, NOW);
  const op = store.listEvents(ws, { type: "op.applied" }).at(-1)!;
  expect(undoOp(TEST_CTX, op.entityId)).toMatchObject({ ok: true });
  expect(store.getWorkOrder(ws, "hw")!.state).toBe("approved");
  expect(store.listPreferences(ws).some((item) => item.source === "correction")).toBe(true);
  expect(settleDeliverables(TEST_CTX, NOW)).toEqual([]);
  expect(store.getWorkOrder(ws, "hw")!.state).toBe("approved");
});

test("finished work without a milestone waiting in evidence review is accepted by the system, undoably", () => {
  const { store, order } = setup();
  order("loose", "evidence_review"); order("gated", "evidence_review", "m1");
  // The assistant's result is decided where its results are, never accepted here.
  store.saveWorkOrder({ ...store.getWorkOrder(ws, "loose")!, id: "agent", payload: { materialContract: [], family: "deep_work", owner: "assistant" } });
  settleDeliverables(TEST_CTX, NOW);
  expect(store.getWorkOrder(ws, "agent")!.state).toBe("evidence_review");
  expect(store.getWorkOrder(ws, "loose")!.state).toBe("accepted");
  expect(store.getWorkOrder(ws, "gated")!.state).toBe("evidence_review");
});

test("a gap in finished work is asked only at a key place, once; 我补一下 reopens it, 不适用 is kept as a preference", () => {
  const { store, order, judged } = setup();
  order("plain", "accepted"); order("ms", "accepted", "m1"); order("ext", "accepted"); order("open", "approved", "m1");
  judged("d1", "plain", "deliverable", "gap", { gap: "缺第 5 题" });
  judged("d2", "ms", "deliverable", "gap", { gap: "缺第 5 题" });
  judged("d3", "ext", "deliverable", "gap", { gap: "没附参考文献", external: true });
  judged("d4", "open", "deliverable", "gap", { gap: "缺第 5 题" });
  const asks = gapAsks(TEST_CTX);
  expect(asks.map((ask) => ask.entityId).sort()).toEqual(["ext", "ms"]);
  expect(asks.find((ask) => ask.entityId === "ext")!.options.find((option) => option.recommended)!.id).toBe("fix");
  expect(answerGap(TEST_CTX, asks.find((ask) => ask.entityId === "ext")!, "fix")).toEqual({ ok: true });
  expect(store.getWorkOrder(ws, "ext")!.state).toBe("approved");
  expect(answerGap(TEST_CTX, asks.find((ask) => ask.entityId === "ms")!, "na")).toEqual({ ok: true });
  expect(store.listPreferences(ws).some((item) => item.text.includes("缺第 5 题"))).toBe(true);
  expect(gapAsks(TEST_CTX)).toEqual([]);
});
