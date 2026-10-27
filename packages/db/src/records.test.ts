import { expect, test } from "vitest";
import { CrosslineStore, judgeFromRecords, recordAndJudge } from "./index";

const record = (over: Record<string, unknown> = {}) => ({ domain: "wealth" as const, kind: "expense" as const, at: "2026-10-19", value: 35, unit: "元",
  currency: "CNY", category: "餐饮", note: "", source: "input" as const, sourceRef: "", dedupeKey: "input:m1", ...over });
const now = new Date("2026-10-20T12:00:00Z");

test("a record is kept once per real event, stays in its workspace, and a removed one leaves every sum", () => {
  const store = new CrosslineStore(":memory:");
  expect(store.addRecord("w", record()).inserted).toBe(true);
  // The same mail or shortcut a second time is not a second payment.
  expect(store.addRecord("w", record({ value: 99 })).inserted).toBe(false);
  expect(store.listRecords("w").map((item) => item.value)).toEqual([35]);
  store.addRecord("other", record());
  expect(store.listRecords("w")).toHaveLength(1);
  const id = store.listRecords("w")[0]!.id;
  expect(store.setRecordDeleted("w", id, true)).toBe(true);
  expect(store.listRecords("w")).toEqual([]);
  expect(store.listRecords("w", { includeDeleted: true })).toHaveLength(1);
  // Exported with the workspace, so a backup or a move to the server carries the bookkeeping.
  expect(store.exportSnapshot("w").tables.domain_records).toHaveLength(1);
  store.close();
});

test("a record out of range is refused before it is written; a valid one reads the wealth line's approved milestone once per change", () => {
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId: "o", workspaceId: "w", identityId: "line-wealth", projectId: "p", title: "储蓄率达到 20%", version: 1, status: "approved",
    successCriteria: [{ id: "rate", statement: "本月储蓄率不低于 20%", required: true, evidenceOf: "outcome", measure: { kind: "threshold", unit: "%", comparator: "gte", value: 20 } }] });
  expect(recordAndJudge(store, "w", "o", record({ value: -5 }), { lineId: "line-wealth", now })).toEqual({ ok: false, code: "RECORD_INVALID", message: "数值超出合理范围" });
  expect(recordAndJudge(store, "w", "o", record({ kind: "income", value: 10000, dedupeKey: "input:salary" }), { lineId: "line-wealth", now })).toMatchObject({ ok: true, inserted: true });
  const judged = () => store.listEvents("w", { type: "milestone_gate.judged" }).map((event) => (event.payload as { verdict: string; source: string }));
  expect(judged()).toEqual([expect.objectContaining({ verdict: "pass", source: "records" })]);
  // Unchanged readings write nothing new; spending past the line turns it partial.
  expect(judgeFromRecords(store, "w", "o", "wealth", "line-wealth", "2026-10-20")).toBe(0);
  recordAndJudge(store, "w", "o", record({ value: 9000, dedupeKey: "input:rent" }), { lineId: "line-wealth", now });
  expect(judged().at(-1)).toMatchObject({ verdict: "partial" });
  store.close();
});
