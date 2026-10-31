import { expect, test } from "vitest";
import { answersInReply, freeTextAnswers, ledgerLines, questionSimilarity, unsureAnswer } from "./question-ledger";

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

test("a reply in the person's own words answers the questions its sentences speak to", () => {
  const reply = "工作对我来说主要是把一个问题做成别人能用的东西。生活里我想保住每天的睡眠，和朋友吃顿饭。";
  const answers = freeTextAnswers(reply, [
    { id: 1, text: "工作对你意味着什么？", options: ["把方法做成别人能用的代码与文档", "维持稳定收入"] },
    { id: 2, text: "生活应该用来做什么？", options: ["每天的睡眠不被打乱", "读闲书"] },
    { id: 3, text: "你的读者是谁？", options: ["同专业研究生", "本科生"] }
  ]);
  expect(answers.map((answer) => answer.id)).toEqual([1, 2]);
  expect(answers[1]!.answer).toBe("生活里我想保住每天的睡眠，和朋友吃顿饭。");
  expect(reply.slice(answers[0]!.start, answers[0]!.end)).toBe("工作对我来说主要是把一个问题做成别人能用的东西。");
});

test("an answer that settles nothing is told apart from one that does", () => {
  expect(["补充：不确定", "选择：还不知道", "补充：不确定。", "暂不确定", "", "选择：暂无"].map(unsureAnswer)).toEqual([true, true, true, true, true, true]);
  expect(["补充：Crossline", "选择：没有截止", "补充：每周二，具体时间不确定。"].map(unsureAnswer)).toEqual([false, false, false]);
});
