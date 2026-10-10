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
