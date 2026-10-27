import { expect, test } from "vitest";
import { chunkText, ftsMatchExpression, oneLine, searchTerms, termHits, withinBudget } from "./context-selection";

test("a text is cut at a paragraph, line or sentence boundary near 800 characters, losing nothing but whitespace", () => {
  const paragraphs = Array.from({ length: 12 }, (_, i) => `第${i + 1}讲 ${"电路时序与功耗。".repeat(40)}`);
  const text = paragraphs.join("\n\n");
  const chunks = chunkText(text);
  expect(chunks.length).toBeGreaterThan(3);
  for (const chunk of chunks) {
    expect(chunk.text.length).toBeLessThanOrEqual(1000);
    expect(text.slice(chunk.start, chunk.start + chunk.text.length)).toBe(chunk.text);
  }
  expect(chunks.map((chunk) => chunk.text).join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  // A cut lands after a sentence end, never inside 「功耗」.
  expect(chunks.slice(0, -1).every((chunk) => /[。\n]$/.test(chunk.text) || /。$/.test(chunk.text))).toBe(true);
  expect(chunkText("short note").map((chunk) => chunk.text)).toEqual(["short note"]);
  expect(chunkText("   ")).toEqual([]);
  // No boundary at all: a hard cut at the target.
  expect(chunkText("x".repeat(2000)).map((chunk) => chunk.text.length)).toEqual([800, 800, 400]);
});

test("query terms: Latin words whole and split at letter–digit seams, Chinese phrases whole or as windows, two-character words apart", () => {
  const terms = searchTerms("ECE548 HW3 的 复习提纲 期中考试 组会 完成 the");
  expect(terms.long).toEqual(expect.arrayContaining(["ece548", "ece", "548", "hw3", "复习提纲", "期中考试"]));
  expect(terms.short).toEqual(expect.arrayContaining(["hw", "组会"]));
  expect(terms.short).not.toContain("完成");
  expect(terms.long).not.toContain("the");
  expect(searchTerms("忆阻器片上训练").long).toEqual(["忆阻器", "阻器片", "器片上", "片上训", "上训练"]);
  expect(ftsMatchExpression(["a\"b", "期中"])).toBe("\"a\"\"b\" OR \"期中\"");
  expect(termHits("ECE 548 期中考试在 10 月", searchTerms("期中考试 ECE"))).toBe(2);
});

test("budgets keep items in order while they fit, and a candidate is shown on one short line", () => {
  expect(withinBudget(["aaaa", "bbbbbbbbbb", "cc", "dd"], (item) => item.length, 8)).toEqual(["aaaa", "cc", "dd"]);
  expect(oneLine("第一行\n\n第二行   很长", 6)).toBe("第一行 第…");
});
