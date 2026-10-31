import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ledgerForModel, resolveRepeats, withDistinctOptions } from "./question-ledger";

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

test("a question answered 「不确定」 may be asked once more, not twice; one answered properly is not asked again", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-10-30T05:00:00Z";
  const unsure = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:2:q2", text: "创作者主线当前推进的内容或项目名称？", status: "open", at });
  store.answerQuestion(ws, unsure, { text: "补充：不确定", at });
  const known = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:2:q1", text: "创业者主线当前推进的项目名称？", status: "open", at });
  store.answerQuestion(ws, known, { text: "补充：Crossline", at });
  const ask = (text: string, repeats: number) => ({ id: "q", text, kind: "free" as const, options: [], allowOther: true, identityId: "", projectId: "", repeats });
  const first = resolveRepeats(store, ws, "s1", [ask("创作者主线目前有正在推进的项目吗？", unsure), ask("创业者主线的项目名称？", known)]);
  expect(first.questions.map((question) => question.text)).toEqual(["创作者主线目前有正在推进的项目吗？"]);
  // Asked again once (recorded as repeating it): a third time is dropped.
  store.recordQuestion(ws, { kind: "interview", key: "iq:s1:3:q1", text: "创作者主线目前有正在推进的项目吗？", status: "open", repeats: unsure, at });
  expect(resolveRepeats(store, ws, "s1", [ask("创作者主线是否暂按没有当前项目？", unsure)]).questions).toEqual([]);
});

test("about the same line a reworded question is a repeat at a lower similarity, and nothing is put to the person a third time", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-10-31T05:00:00Z";
  const ask = (text: string, identityId = "wealth", projectId = "") =>
    ({ id: "q", text, kind: "free" as const, options: [], allowOther: true, identityId, projectId, repeats: 0 });
  // Answered in prose the cards could not read: the question stays open, worded differently each round.
  store.recordQuestion(ws, { kind: "interview", key: "iq:s1:2:q1", text: "现在手上大概有多少应急的钱？", identityId: "wealth", status: "open", at });
  expect(resolveRepeats(store, ws, "s1", [ask("现在手上应急的钱大概有多少？")]).questions).toHaveLength(1);
  store.recordQuestion(ws, { kind: "interview", key: "iq:s1:3:q1", text: "现在手上应急的钱大概有多少？", identityId: "wealth", status: "open", at });
  const third = resolveRepeats(store, ws, "s1", [ask("手上应急的钱现在大概是多少？"), ask("每月大概能存下多少？")]);
  expect(third.questions.map((question) => question.text)).toEqual(["每月大概能存下多少？"]);
  expect(third.dropped).toEqual([expect.objectContaining({ why: "similar" })]);
  // Two projects' deadlines are worded alike and are two questions.
  const deadlines = resolveRepeats(store, ws, "s1", [ask("「A」大概什么时候完成？", "media", "a"), ask("「B」大概什么时候完成？", "media", "b")]);
  expect(deadlines.questions).toHaveLength(2);
  // Two questions of one round that ask the same thing: the first stays.
  expect(resolveRepeats(store, ws, "s1", [ask("每周几点开始上班？", "work"), ask("每周几点开始上班呢？", "work")]).questions).toHaveLength(1);
});

test("a question's options never repeat", () => {
  const question = { id: "q", text: "?", kind: "single" as const, allowOther: true, identityId: "", projectId: "",
    options: [{ id: "a", label: "周末", detail: "" }, { id: "b", label: "周末。", detail: "" }, { id: "c", label: "晚上", detail: "" }] };
  expect(withDistinctOptions(question).options.map((option) => option.label)).toEqual(["周末", "晚上"]);
});