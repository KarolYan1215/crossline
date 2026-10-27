import { expect, test } from "vitest";
import { cleanAnswerStrings, stripInvisible, tidySentenceEnds, trimLeakedTail } from "./text-hygiene";

test("invisible formatting characters are removed, and nothing visible is", () => {
  expect(stripInvisible("整​理‌一‍下﻿")).toBe("整理一下");
  expect(stripInvisible("a­b ‮b")).toBe("ab b");
});

test("a leaked tail is cut at the first stray-script letter, and the sentence in front of it survives", () => {
  expect(trimLeakedTail("需要提供文件。  ജnumerusform】【。")).toBe("需要提供文件。");
  expect(trimLeakedTail("建议材料，不阻止先建立评阅工作单。}],")).toBe("建议材料，不阻止先建立评阅工作单。");
});

test("a field that is entirely another script, or has nothing before the leak, is left alone", () => {
  expect(trimLeakedTail("ജ")).toBe("ജ");
  expect(trimLeakedTail("}],")).toBe("}],");
  // Ordinary reasons contain brackets, quotes and Greek or Cyrillic names without being junk.
  expect(trimLeakedTail("见文献 [1]，参数 α 与 Δt。")).toBe("见文献 [1]，参数 α 与 Δt。");
});

test("quote fields are compared with the person's own text, so they are never rewritten", () => {
  const cleaned = cleanAnswerStrings({ why: "a​b", sourceQuote: "x​y", nested: [{ quote: "p​q", intent: "r​s" }] });
  expect(cleaned).toEqual({ why: "ab", sourceQuote: "x​y", nested: [{ quote: "p​q", intent: "rs" }] });
});

test("estimate jargon in older model text reads as plain words", async () => {
  const { plainEstimateWords } = await import("./text-hygiene");
  expect(plainEstimateWords("材料未提供题目数量，p50 合计 180 分钟，p85 为 4 小时。")).toBe("材料未提供题目数量，通常合计 180 分钟，保守为 4 小时。");
});

test("two sentence ends in a row keep the last", () => {
  expect(tidySentenceEnds("不发布。。小红书读取已停下")).toBe("不发布。小红书读取已停下");
  expect(tidySentenceEnds("对应要求。；- 增加")).toBe("对应要求；- 增加");
  expect(tidySentenceEnds("好了吗？。")).toBe("好了吗？");
});
