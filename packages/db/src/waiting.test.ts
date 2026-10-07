import { expect, test } from "vitest";
import { CrosslineStore } from "./index";

const item = { id: "wait-1", ownerId: "o", workspaceId: "w", title: "西湖 MoS₂ 真实测量数据", who: "师兄",
  expectedAt: "2026-10-08", approximate: true, followUpAt: "2026-10-08", state: "open" as const, blocks: ["wo-1"], source: "analysis" as const };

test("a waiting item is recorded once, deferred, then closed by the person's answer — never by itself", () => {
  const store = new CrosslineStore(":memory:");
  expect(store.saveWaitingItem(item).inserted).toBe(true);
  expect(store.saveWaitingItem(item).inserted).toBe(false);
  expect(store.answerWaitingItem("w", "wait-1", { kind: "deferred", followUpAt: "2026-10-10" }, "o").changed).toBe(true);
  expect(store.listWaitingItems("w")[0]).toMatchObject({ state: "open", followUpAt: "2026-10-10", expectedAt: "2026-10-08" });
  expect(store.answerWaitingItem("w", "wait-1", { kind: "arrived" }, "o").changed).toBe(true);
  expect(store.listWaitingItems("w", { state: "open" })).toEqual([]);
  expect(store.answerWaitingItem("w", "wait-1", { kind: "cancelled" }, "o").changed).toBe(false);
  expect(store.listEvents("w", { entityId: "wait-1" }).map((event) => event.type)).toEqual(["waiting.created", "waiting.deferred", "waiting.arrived"]);
  expect(() => store.answerWaitingItem("w", "wait-1x", { kind: "arrived" }, "o")).toThrow("WAITING_ITEM_NOT_FOUND");
  store.close();
});

test("waiting items travel with a snapshot and restore", () => {
  const store = new CrosslineStore(":memory:");
  store.saveWaitingItem(item);
  const snapshot = store.exportSnapshot("w");
  const target = new CrosslineStore(":memory:");
  target.importSnapshot(snapshot);
  expect(target.listWaitingItems("w").map((row) => row.title)).toEqual(["西湖 MoS₂ 真实测量数据"]);
  store.close(); target.close();
});
