import { expect, test } from "vitest";
import { CrosslineStore } from "./index";

test("one conversation per day, messages kept in order, cards updated in place, and every day searchable", () => {
  const store = new CrosslineStore(":memory:");
  const first = store.conversationFor("w", "2026-10-09");
  expect(store.conversationFor("w", "2026-10-09").id).toBe(first.id);
  expect(store.conversationFor("w", "2026-10-10").id).not.toBe(first.id);
  store.appendConversationMessage({ id: "m1", workspaceId: "w", conversationId: first.id, role: "person", text: "撤销刚刚的不等了", payload: {} });
  store.appendConversationMessage({ id: "m2", workspaceId: "w", conversationId: first.id, role: "assistant", text: "撤销「不等了」？",
    payload: { actions: [{ action: "undo" }], status: ["pending"] } });
  store.updateConversationPayload("w", "m2", { actions: [{ action: "undo" }], status: ["done"] });
  expect(store.listConversationMessages("w", first.id).map((message) => [message.id, message.payload.status ?? null])).toEqual([["m1", null], ["m2", ["done"]]]);
  expect(store.searchConversationMessages("w", "不等了").map((message) => message.id).sort()).toEqual(["m1", "m2"]);
  expect(store.searchConversationMessages("w", "100%_")).toEqual([]);
  expect(store.searchConversationMessages("other", "不等了")).toEqual([]);
  store.setConversationThread("w", first.id, "thread-1");
  expect(store.getConversation("w", first.id)?.codexThreadId).toBe("thread-1");
  store.close();
});

test("小帮手's threads: started threads beside the days', renamed, archived and back; the day stays one per day", () => {
  const store = new CrosslineStore(":memory:");
  const day = store.conversationFor("w", "2026-11-10", "2026-11-10T08:00:00.000Z");
  expect(day).toMatchObject({ kind: "day", title: "", instructionsSeen: 0 });
  const thread = store.createConversationThread("w", { id: "thr-1", title: "", day: "2026-11-10" }, "2026-11-10T09:00:00.000Z");
  // A started thread on the same day does not take the day's place.
  expect(store.conversationFor("w", "2026-11-10").id).toBe(day.id);
  expect(thread).toMatchObject({ kind: "thread", day: "2026-11-10" });
  // A day nobody spoke in is not listed; a started thread is, even empty.
  expect(store.listConversationThreads("w").map((item) => item.id)).toEqual(["thr-1"]);
  store.appendConversationMessage({ id: "m1", workspaceId: "w", conversationId: day.id, role: "person", text: "hi", payload: {}, createdAt: "2026-11-10T10:00:00.000Z" });
  expect(store.listConversationThreads("w").map((item) => item.id)).toEqual([day.id, "thr-1"]);
  store.renameConversation("w", "thr-1", "论文");
  store.archiveConversation("w", "thr-1", true);
  expect(store.listConversationThreads("w").map((item) => item.id)).toEqual([day.id]);
  expect(store.listConversationThreads("w", { archived: true })).toMatchObject([{ id: "thr-1", title: "论文" }]);
  store.archiveConversation("w", "thr-1", false);
  expect(store.getConversation("w", "thr-1")?.archivedAt).toBeUndefined();
  store.setConversationInstructionsSeen("w", "thr-1", 3);
  expect(store.getConversation("w", "thr-1")?.instructionsSeen).toBe(3);
  expect(store.listConversationThreads("other")).toEqual([]);
  store.close();
});
