import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DISCLOSURE_PLACEHOLDER } from "@crossline/core";
import { checklistAnswered, ledgerForModel, linesAnsweredUnread } from "./question-ledger";

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

test("older answered questions stay in view by their text alone, so a rewording of round 1's question is not asked in round 27 (W-239)", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-11-06T09:00:00Z";
  for (let i = 1; i <= 30; i += 1) {
    const id = store.recordQuestion(ws, { kind: "interview", key: `iq:s1:${i}:q`, text: `本人的问题 ${i}`, status: "open", at });
    store.answerQuestion(ws, id, { text: `回答 ${i}`, at });
  }
  store.answerQuestion(ws, store.recordQuestion(ws, { kind: "interview", key: "gap:old", text: "旧的应用问题", status: "pending", at }), { text: "", at });
  const shown = ledgerForModel(store, ws, "s1", 15);
  expect(shown.find((line) => line.endsWith("本人的问题 1"))).toMatch(/^#\d+ \[已答\] 本人的问题 1$/);
  expect(shown.some((line) => line.includes("本人的问题 30 → 回答 30"))).toBe(true);
  // The latest fifteen with their answers (the app's answered question among them), the sixteen before by text alone.
  expect(shown.filter((line) => line.includes("→")).length).toBe(14);
  expect(shown.length).toBe(31);
});

// 2026-11-01 run 8: a line answered about at round 11 was asked again at round 19, the extraction still three runs behind.
test("a line answered about in a reply the extraction has not read is named, until the extraction passes that reply", () => {
  store = new CrosslineStore(":memory:");
  const asked = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:9:p1", text: "「当爸的」这条线眼下在忙的一件事是什么？", identityId: "line-dad", status: "open", at: "2026-11-01T09:00:00Z" });
  store.answerQuestion(ws, asked, { text: "明年上小学在看学校", at: "2026-11-01T09:05:00Z" });
  const person = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:9:p2", text: "平时几点睡？", identityId: "person", status: "open", at: "2026-11-01T09:00:00Z" });
  store.answerQuestion(ws, person, { text: "十一点", at: "2026-11-01T09:05:00Z" });
  expect([...linesAnsweredUnread(store, ws, "s1", "2026-11-01T09:05:00Z")]).toEqual(["line-dad"]);
  expect(linesAnsweredUnread(store, ws, "s1", "2026-11-01T09:06:00Z").size).toBe(0);
  expect(linesAnsweredUnread(store, ws, "s1", undefined).size).toBe(0);
});

// 2026-11-01 run 10: an app question answered with something real is only waiting to be written down; 「说不上来」 is not an answer.
test("a checklist question answered with something that settles it counts as answered, an unsure answer does not", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-11-01T15:00:00Z";
  const text = "「铲屎官」这条线眼下在做什么？";
  const first = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:11:checklist-open-1", text, status: "open", at });
  expect(checklistAnswered(store, ws, "s1")(text)).toBe(false);
  store.answerQuestion(ws, first, { text: "选择：说不上来", at });
  expect(checklistAnswered(store, ws, "s1")(text)).toBe(false);
  const second = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:12:checklist-open-1", text, status: "open", at });
  store.answerQuestion(ws, second, { text: "选择：馒头的日常照顾，没有截止", at });
  expect(checklistAnswered(store, ws, "s1")(text)).toBe(true);
});


test("an answer given in a reply a disclosure sits in is shown as the placeholder: the ledger never carries the words back (2026-11-15)", () => {
  store = new CrosslineStore(":memory:");
  const workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  const now = new Date().toISOString();
  store.saveOnboardingSession({ id: "s1", ownerId: "user-1", workspaceId, state: "active", coverage: {}, createdAt: now, updatedAt: now });
  const say = (text: string, at: string) => store!.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "user", content: { text }, createdAt: at });
  const ask = (text: string) => store!.recordQuestion(workspaceId, { kind: "interview", key: `iq:s1:1:${text}`, text, status: "open", at: now });
  const hard = "2026-11-15T10:00:00.000Z";
  say("大二自残过，没人可说。", hard);
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "assistant", content: { reply: "谢谢你说出来。", safety: true }, createdAt: hard });
  store.answerQuestion(workspaceId, ask("那段时间怎么样？"), { text: "大二自残过，没人可说。", at: hard });
  store.answerQuestion(workspaceId, ask("周末做什么？"), { text: "在家。", at: "2026-11-15T10:05:00.000Z" });
  const shown = ledgerForModel(store, workspaceId, "s1", 15).join("\n");
  expect(shown).not.toContain("自残过");
  expect(shown).toContain(DISCLOSURE_PLACEHOLDER);
  expect(shown).toContain("在家。");
});
