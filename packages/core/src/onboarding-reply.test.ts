import { expect, test } from "vitest";
import * as reply from "./onboarding-reply";
import { safetyReplyOnly } from "./onboarding-reply";

const HELP = "如果这个念头再出现，全国心理援助热线 12356；北京心理危机研究与干预中心 010-82951332；身处危险时打 120 或 110，或去最近的医院急诊。";

test("the safety round's reply ends at its help lines; only a question after them stays", () => {
  const reply = `谢谢你愿意说出来。${HELP}回到前面：你敬佩的人和那段时间正好相对。`;
  expect(safetyReplyOnly(reply)).toBe(`谢谢你愿意说出来。${HELP}`);
  expect(safetyReplyOnly(`谢谢你愿意说出来。${HELP}这两件事连起来看很清楚。现在还有这样的念头吗？`)).toBe(`谢谢你愿意说出来。${HELP}现在还有这样的念头吗？`);
  expect(safetyReplyOnly("你最投入的两次都有人等结果。")).toBe("你最投入的两次都有人等结果。");
});

test("a reply may use the research's figures: the check that counted them is gone (2026-11-22, the reply cites its data)", () => {
  expect(Object.keys(reply)).not.toContain("researchCopied");
  expect(Object.keys(reply)).not.toContain("RESEARCH_FIGURES_MAX");
});
