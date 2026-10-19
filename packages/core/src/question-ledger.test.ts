import { expect, test } from "vitest";
import { answersInReply, ledgerLines, questionSimilarity } from "./question-ledger";

test("similarity reads what a question says, not its punctuation", () => {
  expect(questionSimilarity("ECE 555 期末考试是哪一天？", "ECE555期末考试是哪一天")).toBe(1);
  expect(questionSimilarity("西湖合作论文的截止日期？", "西湖合作这篇论文什么时候投？")).toBeGreaterThan(0.3);
  expect(questionSimilarity("每周能投入多少小时？", "小红书现在有多少粉丝？")).toBeLessThan(0.2);
});

test("the answers a reply gives are read from the cards' own form, one line per question", () => {
  const reply = "【每周可投入时长？】选择：20 小时。补充：周末不算\n【有固定组会吗？】选择：每周一下午\n其他补充";
  const [first, second] = reply.split("\n");
  expect(answersInReply(reply, [{ id: 3, text: "每周可投入时长？" }, { id: 4, text: "有固定组会吗？" }, { id: 5, text: "没问到的问题？" }]))
    .toEqual([{ id: 3, answer: "选择：20 小时。补充：周末不算", start: 0, end: first!.length },
      { id: 4, answer: "选择：每周一下午", start: first!.length + 1, end: first!.length + 1 + second!.length }]);
});

test("the short index a model is shown", () => {
  expect(ledgerLines([{ id: 7, kind: "interview", key: "k", text: "每周可投入时长？", options: [], identityId: "", projectId: "", status: "answered",
    answer: "选择：20 小时", answerSentences: [], askedAt: "x" }])).toEqual(["#7 [已答] 每周可投入时长？ → 选择：20 小时"]);
});
