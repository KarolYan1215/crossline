import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const { ensureSeeded } = await import("./crossline");
const { loadPendingDateBatch, decideDateBatch } = await import("./imported-dates");
const { TEST_CTX } = await import("./test-support");

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); globalThis.crosslineStore = store; ensureSeeded(TEST_CTX); });
afterEach(() => { store.close(); globalThis.crosslineStore = undefined; });

const extract = (batchId = "b1") => store.appendEvent({
  ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, idempotencyKey: `dates:extracted:${batchId}`, type: "dates.extracted", entityId: batchId,
  payload: {
    documentIds: ["d1", "d2"],
    dates: [
      { id: "exam", date: "2026-10-27", startTime: "", endTime: "", kind: "exam", title: "ECE 548 期中 1", project: "", sourceRef: "src-1", quote: "27th Oct. L15: Mid-term-1", confidence: "high", note: "" },
      { id: "quiz", date: "2026-10-09", startTime: "14:30", endTime: "15:45", kind: "quiz", title: "ECE 555 quiz", project: "", sourceRef: "src-2", quote: "10/9 Review/Slack #2 Out", confidence: "low", note: "列被拉平" }
    ],
    recurring: [{ id: "class", title: "ECE 555 上课", project: "", weekdays: [1, 5], startTime: "14:30", endTime: "15:45", from: "2026-10-05", to: "2026-10-16",
      exceptions: [], location: "Plant Sci 108", sourceRef: "src-3", quote: "Mon and Fri 2:30PM - 3:45PM", confidence: "high" }],
    questions: ["#2 是作业还是 quiz？"], dropped: [{ id: "x" }]
  }
});

const planBlocks = () => ((store.listPlanVersions(TEST_CTX.workspaceId)[0]?.payload as { blocks: Array<{ id: string; day?: string; start: string; end: string; readOnly: boolean }> }).blocks)
  .filter((block) => block.id.startsWith("import:"));

test("a pending batch lists weekly patterns and dates, with uncertain rows unchecked", () => {
  extract();
  const batch = loadPendingDateBatch(TEST_CTX)!;
  expect(batch.documentCount).toBe(2);
  const byId = Object.fromEntries(batch.items.map((item) => [item.id, item]));
  expect(byId.class).toMatchObject({ kind: "recurring", checked: true, blocks: 4 });
  expect(byId.exam).toMatchObject({ checked: true, blocks: 0 });
  expect(byId.quiz).toMatchObject({ checked: false, confidence: "low" });
  expect(batch.questions).toEqual(["#2 是作业还是 quiz？"]);
  expect(batch.dropped).toBe(1);
});

test("confirming writes only the chosen items: timed ones become blocks, untimed ones become facts", () => {
  extract();
  const result = decideDateBatch(TEST_CTX, "b1", ["exam", "class"]);
  expect(result).toEqual({ ok: true, blocks: 4, facts: 1 });
  expect(planBlocks().map((block) => block.day).sort()).toEqual(["2026-10-05", "2026-10-09", "2026-10-12", "2026-10-16"]);
  expect(planBlocks().every((block) => block.readOnly && block.start === "14:30")).toBe(true);
  const fact = store.listProfileFacts(TEST_CTX.workspaceId).find((item) => item.slot === "date_20261027_exam");
  expect(fact).toMatchObject({ status: "confirmed", sourceRef: "src-1", sourceQuote: "27th Oct. L15: Mid-term-1" });
  // The unchecked, uncertain quiz never reached the calendar or the profile.
  expect(store.listProfileFacts(TEST_CTX.workspaceId).some((item) => item.slot.includes("quiz"))).toBe(false);
});

test("a decided batch is no longer pending and cannot be decided twice", () => {
  extract();
  decideDateBatch(TEST_CTX, "b1", ["exam"]);
  expect(loadPendingDateBatch(TEST_CTX)).toBeNull();
  expect(decideDateBatch(TEST_CTX, "b1", ["exam"])).toEqual({ ok: false, code: "DATE_BATCH_ALREADY_DECIDED" });
});

test("choosing nothing is a valid answer and writes nothing", () => {
  extract();
  expect(decideDateBatch(TEST_CTX, "b1", [])).toEqual({ ok: true, blocks: 0, facts: 0 });
  expect(planBlocks()).toEqual([]);
  expect(loadPendingDateBatch(TEST_CTX)).toBeNull();
});

test("an unknown batch is refused", () => {
  expect(decideDateBatch(TEST_CTX, "nope", ["x"])).toEqual({ ok: false, code: "DATE_BATCH_NOT_FOUND" });
});
