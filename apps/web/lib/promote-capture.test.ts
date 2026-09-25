import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { TEST_CTX } from "./test-support";
import { addCapturedTaskWithId, ensureSeeded, promoteCaptureManually } from "./crossline";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const capture = () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  ensureSeeded(TEST_CTX);
  addCapturedTaskWithId(TEST_CTX, { title: "手工创建测试", context: "" }, "capture-1", "capture-1");
  return store;
};

const validInput = {
  identityId: "research", intent: "手工创建作业", milestoneId: "", family: "deep_work",
  estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60 },
  evidenceContract: [{ kind: "record", description: "完成记录" }]
};

test("promotes a capture straight to an approved, honestly-labelled WorkOrder, skipping Codex entirely", () => {
  const store = capture();
  expect(promoteCaptureManually(TEST_CTX, "capture-1", validInput)).toEqual({ ok: true });
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.intent === "手工创建作业");
  expect(order?.state).toBe("approved");
  expect(order?.estimate).toMatchObject({ source: "manual", p25Minutes: 30, p85Minutes: 60 });
  expect(order?.payload).toMatchObject({ manualPromotion: true, family: "deep_work" });
  expect(store.listCaptures(TEST_CTX.workspaceId).find((item) => item.id === "capture-1")?.state).toBe("promoted");
});

// Found while manually clicking through the form: the milestone dropdown offered every approved
// milestone regardless of which identity was selected, and nothing on the server caught a mismatch —
// a research-identity WorkOrder could be silently bound to a startup milestone.
test("refuses to bind a WorkOrder to a milestone that belongs to a different identity", () => {
  capture();
  const result = promoteCaptureManually(TEST_CTX, "capture-1",
    { ...validInput, identityId: "research", milestoneId: "startup-starter" });
  expect(result).toEqual({ ok: false, code: "MILESTONE_NOT_APPROVED" });
});

test("accepts a milestone that does belong to the chosen identity", () => {
  const store = capture();
  expect(promoteCaptureManually(TEST_CTX, "capture-1",
    { ...validInput, identityId: "research", milestoneId: "research-starter" })).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.intent === "手工创建作业")?.milestoneId)
    .toBe("research-starter");
});

test("rejects an unknown identity, an empty intent, an inverted estimate and a missing evidence contract", () => {
  capture();
  expect(promoteCaptureManually(TEST_CTX, "capture-1", { ...validInput, identityId: "not-a-pack" }))
    .toEqual({ ok: false, code: "IDENTITY_UNKNOWN" });
  expect(promoteCaptureManually(TEST_CTX, "capture-1", { ...validInput, intent: "  " }))
    .toEqual({ ok: false, code: "INTENT_INVALID" });
  expect(promoteCaptureManually(TEST_CTX, "capture-1",
    { ...validInput, estimate: { p25Minutes: 60, p50Minutes: 45, p85Minutes: 30 } }))
    .toEqual({ ok: false, code: "ESTIMATE_INVALID" });
  expect(promoteCaptureManually(TEST_CTX, "capture-1", { ...validInput, evidenceContract: [] }))
    .toEqual({ ok: false, code: "EVIDENCE_CONTRACT_REQUIRED" });
});

test("a capture already promoted cannot be promoted again", () => {
  capture();
  expect(promoteCaptureManually(TEST_CTX, "capture-1", validInput)).toEqual({ ok: true });
  expect(promoteCaptureManually(TEST_CTX, "capture-1",
    { ...validInput, intent: "第二次尝试" })).toEqual({ ok: false, code: "CAPTURE_ALREADY_PROMOTED" });
});
