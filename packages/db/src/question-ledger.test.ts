import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "./index";

let store: CrosslineStore;
const A = "workspace-a";
const at = "2026-10-19T12:00:00.000Z";
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

test("a question keeps its number when asked again, an answer is never undone, and a dropped one opens again", () => {
  const first = store.recordQuestion(A, { kind: "interview", key: "gap:deadline-x", text: "「X」有截止日期吗？", status: "pending", at });
  expect(first).toBe(1);
  expect(store.recordQuestion(A, { kind: "ask", key: "ask:stepq:1", text: "作业 3 交 PDF 还是纸质？", options: ["PDF", "纸质"], status: "open", at })).toBe(2);
  // Shown in a round: pending → open, same number.
  expect(store.recordQuestion(A, { kind: "interview", key: "gap:deadline-x", text: "「X」有截止日期吗？", status: "open", at })).toBe(1);
  store.answerQuestion(A, 1, { text: "选择：没有截止", sentences: [12], at });
  // Asked again after the answer: still answered.
  store.recordQuestion(A, { kind: "interview", key: "gap:deadline-x", text: "「X」有截止日期吗？", status: "pending", at });
  expect(store.questionByKey(A, "gap:deadline-x")).toMatchObject({ id: 1, status: "answered", answer: "选择：没有截止", answerSentences: [12] });
  store.dropQuestion(A, 1, at);
  expect(store.questionByKey(A, "gap:deadline-x")?.status).toBe("answered");
  store.dropQuestion(A, 2, at);
  expect(store.questionByKey(A, "ask:stepq:1")?.status).toBe("dropped");
  store.recordQuestion(A, { kind: "ask", key: "ask:stepq:1", text: "作业 3 交 PDF 还是纸质？", status: "open", at });
  expect(store.listQuestions(A, { statuses: ["open"] }).map((question) => question.id)).toEqual([2]);
  expect(store.listQuestions("workspace-b")).toEqual([]);
});
