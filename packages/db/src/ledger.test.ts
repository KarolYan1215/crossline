import { expect, test } from "vitest";
import type { MoneyEvidence } from "@crossline/core";
import { CrosslineStore, mergeRecords, recordMoneyEvidence, resolvePossibleDuplicate, setRecordCategory, splitRecordEvidence, voidByEvidence } from "./index";

const now = new Date("2026-10-28T12:00:00Z");
const piece = (over: Partial<MoneyEvidence>): MoneyEvidence => ({ sourceKey: "m1", source: "mail", sourceRef: "acct:1", kind: "expense", value: 86.4, currency: "USD", at: "2026-10-20",
  merchant: "Amazon", merchantKey: "amazon", category: "购物", refs: [], last4: "", instrument: "", role: "receipt", senderKey: "amazon", note: "", ...over });
const keep = (store: CrosslineStore, over: Partial<MoneyEvidence>) => recordMoneyEvidence(store, "w", "o", piece(over), { now });
const booked = (store: CrosslineStore) => store.listRecords("w").filter((record) => record.status === "booked");

test("the same mail seen twice, in two mailboxes, is one piece of evidence and one record", () => {
  const store = new CrosslineStore(":memory:");
  expect(keep(store, {})).toMatchObject({ state: "booked" });
  expect(keep(store, { sourceRef: "acct:2" })).toMatchObject({ state: "seen" });
  expect(store.listRecords("w")).toHaveLength(1);
  expect(store.exportSnapshot("w").tables.record_evidence).toHaveLength(1);
  store.close();
});

test("an order confirmation, its shipping mail and the bank alert with the order number are one record with three pieces", () => {
  const store = new CrosslineStore(":memory:");
  keep(store, { refs: ["112-3345"] });
  expect(keep(store, { sourceKey: "m2", role: "shipping", refs: ["1123345"], at: "2026-10-22" })).toMatchObject({ state: "attached" });
  expect(keep(store, { sourceKey: "m3", role: "charge", senderKey: "chase", merchant: "AMZN Mktp", refs: ["112-3345"], last4: "1234", instrument: "card", at: "2026-10-22" }))
    .toMatchObject({ state: "attached", record: { account: "card ••1234" } });
  expect(store.listRecords("w")).toHaveLength(1);
  expect(store.listRecordEvidence("w")).toHaveLength(3);
  store.close();
});

test("two coffees from one shop on one day are two records; a receipt and a bank alert two days apart wait for the person", () => {
  const store = new CrosslineStore(":memory:");
  keep(store, { sourceKey: "c1", merchantKey: "starbucks", senderKey: "starbucks", value: 5.2 });
  expect(keep(store, { sourceKey: "c2", merchantKey: "starbucks", senderKey: "starbucks", value: 5.2 })).toMatchObject({ state: "booked" });
  keep(store, { sourceKey: "a1" });
  const maybe = keep(store, { sourceKey: "a2", role: "charge", senderKey: "chase", at: "2026-10-22" });
  expect(maybe).toMatchObject({ state: "possible_duplicate" });
  expect(booked(store)).toHaveLength(3);
  // 「是两笔」: both count.
  expect(resolvePossibleDuplicate(store, "w", maybe.state === "possible_duplicate" ? maybe.record.id : "", false)).toBe(true);
  expect(booked(store)).toHaveLength(4);
  store.close();
});

test("a possible duplicate answered as the same one merges, and a wrong merge can be split again", () => {
  const store = new CrosslineStore(":memory:");
  const first = keep(store, { sourceKey: "a1" });
  const maybe = keep(store, { sourceKey: "a2", role: "charge", senderKey: "chase", at: "2026-10-22" });
  if (first.state === "invalid" || maybe.state === "invalid") throw new Error("unexpected");
  expect(resolvePossibleDuplicate(store, "w", maybe.record.id, true, now)).toBe(true);
  expect(store.listRecords("w").map((record) => record.id)).toEqual([first.record.id]);
  const moved = store.listRecordEvidence("w").find((item) => item.sourceKey === "a2")!;
  const split = splitRecordEvidence(store, "w", moved.id, now)!;
  expect(store.listRecords("w")).toHaveLength(2);
  expect(store.listRecordEvidence("w", [split.id]).map((item) => item.sourceKey)).toEqual(["a2"]);
  expect(mergeRecords(store, "w", first.record.id, split.id, now)).toBe(true);
  expect(store.listRecords("w")).toHaveLength(1);
  store.close();
});

test("a refund is linked to the expense it returns and keeps its category; one larger than any expense stands alone", () => {
  const store = new CrosslineStore(":memory:");
  const order = keep(store, { refs: ["A77"], value: 80, category: "购物" });
  const refund = keep(store, { sourceKey: "r1", kind: "refund", role: "refund", refs: ["A77"], value: 20, category: "", at: "2026-10-25" });
  expect(refund).toMatchObject({ state: "refund_linked", record: { refundOf: order.state !== "invalid" ? order.record.id : "", category: "购物" } });
  expect(keep(store, { sourceKey: "r2", kind: "refund", role: "refund", value: 100, at: "2026-10-26" })).toMatchObject({ state: "booked", record: { refundOf: "" } });
  store.close();
});

test("a failed payment voids the record it matches", () => {
  const store = new CrosslineStore(":memory:");
  keep(store, { refs: ["9981"], value: 48.2, merchantKey: "shell", senderKey: "shell", role: "charge" });
  expect(voidByEvidence(store, "w", { ...piece({ refs: ["9981"], value: 48.2, merchantKey: "shell", role: "failed" }) }, "付款未成功", now)).toBeDefined();
  expect(store.listRecords("w")).toEqual([]);
  expect(store.listRecords("w", { includeDeleted: true })[0]!.voidReason).toBe("付款未成功");
  store.close();
});

test("the person's category for a merchant is kept for its other and future records", () => {
  const store = new CrosslineStore(":memory:");
  const first = keep(store, { merchantKey: "traderjoes", senderKey: "", category: "其他" });
  keep(store, { sourceKey: "m2", merchantKey: "traderjoes", senderKey: "", category: "其他", value: 30, at: "2026-10-01" });
  if (first.state === "invalid") throw new Error("unexpected");
  setRecordCategory(store, "w", first.record.id, "买菜日用", true);
  expect(store.listRecords("w").map((record) => record.category)).toEqual(["买菜日用", "买菜日用"]);
  expect(keep(store, { sourceKey: "m3", merchantKey: "traderjoes", senderKey: "", category: "购物", value: 12, at: "2026-10-27" })).toMatchObject({ record: { category: "买菜日用", categoryBy: "rule" } });
  store.close();
});
