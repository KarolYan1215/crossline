import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ledgerForModel } from "./question-ledger";

const ws = "w";
let store: CrosslineStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

test("the app's own waiting questions take at most a third of what the dialogue is shown, so its own answered questions stay in view", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-10-19T10:00:00Z";
  // The owner's real interview: the dialogue's own questions, answered, then twenty of the app's file-belonging questions waiting.
  for (let i = 1; i <= 8; i += 1) {
    const id = store.recordQuestion(ws, { kind: "interview", key: `iq:s1:${i}:q`, text: `本人的问题 ${i}`, status: "open", at });
    store.answerQuestion(ws, id, { text: `回答 ${i}`, at });
  }
  for (let i = 1; i <= 20; i += 1) store.recordQuestion(ws, { kind: "interview", key: `gap:file-${i}`, text: `文件 ${i} 属于哪个项目？`, status: "pending", at });
  const shown = ledgerForModel(store, ws, "s1", 15);
  expect(shown.length).toBe(13);
  expect(shown.filter((line) => line.includes("文件")).length).toBe(5);
  expect(shown.filter((line) => line.includes("[已答]")).length).toBe(8);
  // Another session's questions are not this conversation's.
  store.recordQuestion(ws, { kind: "interview", key: "iq:s2:1:q", text: "别的会话", status: "open", at });
  expect(ledgerForModel(store, ws, "s1", 15).some((line) => line.includes("别的会话"))).toBe(false);
});
