import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DISCLOSURE_PLACEHOLDER, ledgerLines } from "@crossline/core";
import { answerMainQuestions, checklistAnswered, interviewLedger, linesAnsweredUnread, recordAsked, recordReplyAnswers } from "./question-ledger";

const ws = "w";
let store: CrosslineStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

// 2026-11-25 (「访谈账本驱动」): the questions the reply itself asks go into the ledger with the round, and the next reply is their answer,
// written before the next round's snapshot is read: the ledger, not the thread, remembers what was asked and said.
test("a question the reply asked is in the ledger after its round, and the next reply is its answer before anything reads the ledger", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-11-25T10:00:00Z";
  const [main] = recordAsked(store, ws, "s1", 4, [{ text: "最近一次接单影响更新时发生了什么？", gist: "接单挤占更新的一次经过", repeats: 0, followUp: false }], at);
  expect(interviewLedger(store, ws, "s1").find((question) => question.id === main)).toMatchObject({ status: "open", key: "iq:s1:4:main-1" });
  const reply = "上个月赶一个品牌稿，两周没发教程。\n【这件事有截止日期吗？】有，12月5日";
  expect(answerMainQuestions(store, ws, "s1", reply, [], "2026-11-25T10:05:00Z")).toBe(1);
  // The card's line answers the card, not the reply's question.
  expect(interviewLedger(store, ws, "s1").find((question) => question.id === main)).toMatchObject({ status: "answered", answer: "上个月赶一个品牌稿，两周没发教程。" });
  // Answered once: a later reply does not overwrite it, and another session's reply never answers it.
  expect(answerMainQuestions(store, ws, "s1", "别的话", [], "2026-11-25T10:10:00Z")).toBe(0);
  expect(answerMainQuestions(store, ws, "s2", "别的会话", [], "2026-11-25T10:10:00Z")).toBe(0);
});

test("the reply's own question takes the reply whole even where its words overlap a card's question", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-11-25T10:00:00Z";
  const [main] = recordAsked(store, ws, "s1", 2, [{ text: "每篇教程从选题到发布要多久？", gist: "一篇教程的制作时长", repeats: 0, followUp: false }], at);
  const card = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:2:q1", text: "你一周更新几篇？", options: ["一篇", "两篇"], status: "open", at });
  const reply = "每篇教程大概要 4 小时。\n【你一周更新几篇？】两篇";
  answerMainQuestions(store, ws, "s1", reply, [], at);
  recordReplyAnswers(store, ws, "s1", reply, [], at);
  const ledger = interviewLedger(store, ws, "s1");
  expect(ledger.find((question) => question.id === main)?.answer).toBe("每篇教程大概要 4 小时。");
  expect(ledger.find((question) => question.id === card)?.status).toBe("answered");
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

// 2026-11-01 run 10: an app question answered in a reply the extraction has not read is only waiting to be written down. Whether the
// answer settled it (「说不上来」 does not) is the extraction's judgement since 2026-11-25 (IR-022 retired): once it has read the reply and
// the item is still open, the question is offered again, whatever the answer's words.
test("a checklist question counts as answered only while the extraction has not read the answer", () => {
  store = new CrosslineStore(":memory:");
  const at = "2026-11-01T15:00:00Z";
  const text = "「铲屎官」这条线眼下在做什么？";
  const first = store.recordQuestion(ws, { kind: "interview", key: "iq:s1:11:checklist-open-1", text, status: "open", at });
  expect(checklistAnswered(store, ws, "s1", at)(text)).toBe(false);
  store.answerQuestion(ws, first, { text: "选择：说不上来", at });
  expect(checklistAnswered(store, ws, "s1", at)(text)).toBe(true);
  // Read by the extraction (no unread reply, or only later ones): the item, still open, is asked again.
  expect(checklistAnswered(store, ws, "s1", undefined)(text)).toBe(false);
  expect(checklistAnswered(store, ws, "s1", "2026-11-01T15:01:00Z")(text)).toBe(false);
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
  const shown = ledgerLines(interviewLedger(store, workspaceId, "s1")).join("\n");
  expect(shown).not.toContain("自残过");
  expect(shown).toContain(DISCLOSURE_PLACEHOLDER);
  expect(shown).toContain("在家。");
});
