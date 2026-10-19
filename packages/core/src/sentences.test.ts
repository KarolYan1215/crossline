import { expect, test } from "vitest";
import { SEGMENT_MAX, locateQuote, numbersIn, numbersSupported, segmentText } from "./sentences";

const texts = (input: string) => segmentText(input).map((segment) => segment.text);

test("typed the way people type: times and decimals stay whole, an ASCII period after Chinese ends a sentence", () => {
  expect(texts("我9.00上课.然后下午3:30去实验室,晚上写论文")).toEqual(["我9.00上课.", "然后下午3:30去实验室,晚上写论文"]);
  expect(texts("周一到周五 9.00-12.00 上课，周三下午 2点半 组会！周末休息？")).toEqual(["周一到周五 9.00-12.00 上课，周三下午 2点半 组会！", "周末休息？"]);
  expect(texts("I meet my advisor on Mon. at 10.30. Then I teach.")).toEqual(["I meet my advisor on Mon. at 10.30.", "Then I teach."]);
});

test("fragments too short to mean anything join a neighbour; lines are cut first, so a table row is one sentence", () => {
  // 「e.g.」 still ends a sentence here: too fine, which a citation of two numbers absorbs.
  expect(texts("deadline大概是12.15吧 e.g. 投ICML。Dr. Smith说可以。")).toEqual(["deadline大概是12.15吧 e.g.", "投ICML。", "Dr. Smith说可以。"]);
  expect(texts("- 研究者\n- 创业者\n1. 每周20小时")).toEqual(["- 研究者", "- 创业者", "1. 每周20小时"]);
  expect(texts("10/27 Midterm 1 (in class)\n11/3 HW4 due")).toEqual(["10/27 Midterm 1 (in class)", "11/3 HW4 due"]);
  expect(texts("是")).toEqual(["是"]);
});

test("a long run without punctuation is cut at a space or comma, and nothing is ever lost", () => {
  const long = Array.from({ length: 30 }, (_, index) => `第${index}件事要做完`).join(" ");
  const segments = segmentText(long);
  expect(segments.length).toBeGreaterThan(1);
  expect(segments.every((segment) => segment.text.length <= SEGMENT_MAX)).toBe(true);
  for (const input of [long, "哈哈哈哈。。。不太确定……可能吧~~ 下周三之前？？", "去 https://example.com/a.b?c=1 看看。好的", "  \n\n  空行之后\n"]) {
    const kept = segmentText(input);
    expect(kept.map((segment) => segment.text).join("").replace(/\s/g, "")).toBe(input.replace(/\s/g, ""));
    for (const segment of kept) expect(input.slice(segment.start, segment.end)).toBe(segment.text);
  }
});

test("a quote is found by its letters and digits, whatever the punctuation and Markdown", () => {
  const text = "- 阶段：**只有用户自己在用**\n- 用户：零";
  const span = locateQuote(text, "阶段：只有用户自己在用。")!;
  expect(text.slice(span.start, span.end)).toBe("阶段：**只有用户自己在用");
  expect(locateQuote(text, "没有说过")).toBeUndefined();
});

test("numbers are compared however they are typed; a miss is the model's own number", () => {
  expect([...numbersIn("9.00")]).toEqual([9, 0]);
  expect(numbersSupported("09:00", "我9.00上课")).toBe(true);
  expect(numbersSupported("09:30", "九点半到实验室")).toBe(true);
  expect(numbersSupported("15:00", "下午3点组会")).toBe(true);
  expect(numbersSupported("15:00", "3pm sync")).toBe(true);
  expect(numbersSupported("每周 20 小时", "一周大概二十个小时")).toBe(true);
  expect(numbersSupported("120 分钟", "两小时")).toBe(true);
  expect(numbersSupported("2026-12-15", "12月15日投稿")).toBe(true);
  expect(numbersSupported("2026-12-20", "12月中投稿")).toBe(false);
  expect(numbersSupported("每周 30 小时", "每周 20 小时")).toBe(false);
});
