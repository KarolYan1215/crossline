import { expect, test } from "vitest";
import { researchCopied, safetyReplyOnly, saidNothingMore, withoutCardEcho, withoutRecordingTalk, withoutToldStory } from "./onboarding-reply";

const HELP = "如果这个念头再出现，全国心理援助热线 12356；北京心理危机研究与干预中心 010-82951332；身处危险时打 120 或 110，或去最近的医院急诊。";

test("the safety round's reply ends at its help lines; only a question after them stays", () => {
  const reply = `谢谢你愿意说出来。${HELP}回到前面：你敬佩的人和那段时间正好相对。`;
  expect(safetyReplyOnly(reply)).toBe(`谢谢你愿意说出来。${HELP}`);
  expect(safetyReplyOnly(`谢谢你愿意说出来。${HELP}这两件事连起来看很清楚。现在还有这样的念头吗？`)).toBe(`谢谢你愿意说出来。${HELP}现在还有这样的念头吗？`);
  expect(safetyReplyOnly("你最投入的两次都有人等结果。")).toBe("你最投入的两次都有人等结果。");
});

test("a question asking for a best story, after one was asked for, excludes the story told", () => {
  const questions = [{ text: "近一年最骄傲的一件事是什么？" }, { text: "一天里哪段状态最好？" }, { text: "那次考试之外，还有哪件让你最骄傲？" }];
  expect(withoutToldStory(questions, ["讲一件到目前为止最有成就感的事：什么时候、和谁？"]).map((question) => question.text))
    .toEqual(["除了前面讲过的那件，近一年最骄傲的一件事是什么？", "一天里哪段状态最好？", "那次考试之外，还有哪件让你最骄傲？"]);
  expect(withoutToldStory(questions, ["平时几点睡？"])).toBe(questions);
});

test("the figures a reply repeats from the finished research are counted once each", () => {
  const findings = ["事务所寒假实习网申多在 7 月底到 10 月，安永 10 月 16 日截止；银行分行多在 12 月底到 1 月初截止。"];
  expect(researchCopied("事务所多在 7 月到 10 月，安永 10 月 16 日已截止，银行分行 12 月底截止。", findings)).toEqual(["7月", "10月", "16日", "12月"]);
  expect(researchCopied("银行分行还在窗口内，先投它。周三 3 点投。", findings)).toEqual([]);
});

test("a reply sentence the observation card already says goes; a reply left empty keeps its words", () => {
  const card = "说不出想做什么岗位，你给它的解释是没有方向、落在同学后面，两条都是把自己和别人放在一起量。";
  const reply = "更正记下：卡住你的是不知道该投什么岗位。说不出想做什么岗位，你的解释是没有方向、落在同学后面，都是把自己和别人放在一起量。";
  expect(withoutCardEcho(reply, card)).toBe("更正记下：卡住你的是不知道该投什么岗位。");
  expect(withoutCardEcho(card, card)).toBe(card);
  expect(withoutCardEcho(reply, undefined)).toBe(reply);
});

test("the reply never tells the person what they said is still being recorded", () => {
  expect(withoutRecordingTalk("试做就按你说的定。晚上、周二和周末的时段还在记录，记下后就能开始使用。")).toBe("试做就按你说的定。");
});

test("nothing more to say counts only as the answer to the closing question", () => {
  const closing = [{ id: "q9", text: "还有什么想聊的吗？" }];
  expect(saidNothingMore(closing, "【还有什么想聊的吗？】选择：没有了")).toBe(true);
  expect(saidNothingMore([{ id: "closing-open", text: "还有没有别的想聊的？没有的话，可以按「结束并出报告」。" }], "没有了")).toBe(true);
  expect(saidNothingMore(closing, "【还有什么想聊的吗？】补充：还想说说实习的事")).toBe(false);
  expect(saidNothingMore(closing, "【还有什么想聊的吗？】选择：没有了\n【一天里哪段状态最好？】选择：下午")).toBe(false);
  expect(saidNothingMore([{ id: "q1", text: "一天里哪段状态最好？" }], "没有了")).toBe(false);
});
