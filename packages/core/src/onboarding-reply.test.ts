import { expect, test } from "vitest";
import { inventedDates, researchCopied, safetyReplyOnly } from "./onboarding-reply";

const HELP = "如果这个念头再出现，全国心理援助热线 12356；北京心理危机研究与干预中心 010-82951332；身处危险时打 120 或 110，或去最近的医院急诊。";

test("the safety round's reply ends at its help lines; only a question after them stays", () => {
  const reply = `谢谢你愿意说出来。${HELP}回到前面：你敬佩的人和那段时间正好相对。`;
  expect(safetyReplyOnly(reply)).toBe(`谢谢你愿意说出来。${HELP}`);
  expect(safetyReplyOnly(`谢谢你愿意说出来。${HELP}这两件事连起来看很清楚。现在还有这样的念头吗？`)).toBe(`谢谢你愿意说出来。${HELP}现在还有这样的念头吗？`);
  expect(safetyReplyOnly("你最投入的两次都有人等结果。")).toBe("你最投入的两次都有人等结果。");
});

test("the figures a reply repeats from the finished research are counted once each", () => {
  const findings = ["事务所寒假实习网申多在 7 月底到 10 月，安永 10 月 16 日截止；银行分行多在 12 月底到 1 月初截止。"];
  expect(researchCopied("事务所多在 7 月到 10 月，安永 10 月 16 日已截止，银行分行 12 月底截止。", findings)).toEqual(["7月", "10月", "16日", "12月"]);
  expect(researchCopied("银行分行还在窗口内，先投它。周三 3 点投。", findings)).toEqual([]);
});

test("a date the reply sets something for must come from the person, the research, the files or a weekday just said", () => {
  const known = ["【约人问岗位，定在哪天？】选择：11 月 16 日周一，先发消息约时间"];
  // 2026-11-17 is a Tuesday; nobody gave it.
  expect(inventedDates("试做定在 11 月 17 日周二：约两位聊一次。", known, "【未来两周先做哪一件？】选择：约两位聊一次", "2026-11-14")).toEqual(["11 月 17 日"]);
  expect(inventedDates("发消息定在 11 月 16 日。", known, "", "2026-11-14")).toEqual([]);
  expect(inventedDates("第一份投递定在 11 月 18 日周三。", known, "周三就投，拖着更没底。", "2026-11-14")).toEqual([]);
  expect(inventedDates("投递就在今天 11 月 14 日。", [], "", "2026-11-14")).toEqual([]);
  expect(inventedDates("上次 11 月 17 日那场考试考得不错。", [], "", "2026-11-14")).toEqual([]);
});
