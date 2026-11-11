import { expect, test } from "vitest";
import { backedDrillForms, drillFormsIn, methodQuestion, screenBackplanDrills, stripDrillForms, stripDrillSentences, type BackplanStep } from "./index";

const none = new Set<never>();

test("names the drill forms (订正, 错题, 背诵, 默写, 打卡, 刷题) and nothing that only looks like one", () => {
  expect(drillFormsIn("做 2 套往年卷并订正")).toEqual(["correction"]);
  expect(drillFormsIn("整理错题本")).toEqual(["correction"]);
  expect(drillFormsIn("背诵 L1–L4 公式")).toEqual(["recitation"]);
  expect(drillFormsIn("每日打卡学习")).toEqual(["checkin"]);
  expect(drillFormsIn("刷题 50 道")).toEqual(["grind"]);
  expect(drillFormsIn("keep a mistake log")).toEqual(["correction"]);
  // Past exams as material, a background, a homework hand-in: no drill form.
  for (const text of ["汇集期中考试规则与往年卷", "背景调研", "完成 ECE 555 作业 2", "按讲义推导耗尽区宽度"]) expect(drillFormsIn(text)).toEqual([]);
});

test("cuts the drill clause and keeps the joints between what stays", () => {
  expect(stripDrillForms("做 2 套往年卷并订正", none)).toBe("做 2 套往年卷");
  expect(stripDrillForms("完成 ECE 555 期中往年卷 2 套并订正", none)).toBe("完成 ECE 555 期中往年卷 2 套");
  expect(stripDrillForms("做题、订正并写总结", none)).toBe("做题并写总结");
  expect(stripDrillForms("考前完成 2 套往年期中卷（计时）并订正", none)).toBe("考前完成 2 套往年期中卷（计时）");
  expect(stripDrillForms("整理错题本", none)).toBe("");
  expect(stripDrillForms("2 套往年卷的订正记录", none)).toBe("");
  expect(stripDrillForms("写出第 3 章推导", none)).toBe("写出第 3 章推导");
  expect(stripDrillSentences("期中占 30%。做完后订正错题。讲义 12 讲。", none)).toBe("期中占 30%。讲义 12 讲。");
});

test("only the person's own words back a form, and a sentence that turns it down backs nothing", () => {
  expect([...backedDrillForms(["做完卷子我习惯订正"])]).toEqual(["correction"]);
  expect([...backedDrillForms(["单词靠背"])]).toEqual(["recitation"]);
  expect([...backedDrillForms(["不用错题本", "从不打卡", "背景：EE 硕士"])]).toEqual([]);
  expect(stripDrillForms("做 2 套往年卷并订正", backedDrillForms(["做完卷子我习惯订正"]))).toBe("做 2 套往年卷并订正");
});

test("the method question fits the kind of work, its first option assumes no method", () => {
  expect(methodQuestion("准备 ECE 548 期中考试").text).toBe("平时怎么准备这类考试？");
  expect(methodQuestion("写论文引言").text).toBe("平时怎么写这类东西？");
  expect(methodQuestion("搭建试用门店名单").text).toBe("平时怎么做这类事？");
  for (const text of ["期中", "写报告", "别的"]) {
    const question = methodQuestion(text);
    expect(question.options[0]).toBe("没有固定方法，按这次需要定");
    expect(question.options.flatMap(drillFormsIn)).toEqual([]);
  }
});

const item = (id: string, title: string, extra: Partial<BackplanStep> = {}): BackplanStep => ({ id, title, intent: title, sourceQuote: "期中成绩 ≥ 88/100",
  rationale: "期中占 30%。", dependsOn: [], estimate: { p25Minutes: 60, p50Minutes: 90, p85Minutes: 150 }, energy: "high", interruptible: true,
  family: "deep_work", riskTier: "milestone", evidence: `${title}的记录`, acquires: "", produces: "", uses: [], ...extra });

test("a backplan loses the drill forms the person never named; an item that is only the drill goes, the quote stays verbatim", () => {
  const steps = [item("a", "做 2 套往年卷并订正", { intent: "限时做 2 套往年卷，做完订正错题", evidence: "2 套往年卷的订正记录",
      sourceQuote: "考前完成 2 套往年期中卷（计时）并订正" }),
    item("b", "整理错题本", { dependsOn: ["a"] }), item("c", "按讲义推导第 5 章", { dependsOn: ["b"] })];
  const { items, stripped, dropped } = screenBackplanDrills(steps, []);
  expect(items.map((entry) => entry.title)).toEqual(["做 2 套往年卷", "按讲义推导第 5 章"]);
  expect(items[0]).toMatchObject({ intent: "限时做 2 套往年卷", evidence: "做 2 套往年卷", sourceQuote: "考前完成 2 套往年期中卷（计时）并订正" });
  expect(items[1]!.dependsOn).toEqual(["a"]);
  expect(stripped).toEqual(["做 2 套往年卷并订正"]);
  expect(dropped).toEqual(["整理错题本"]);
  // Backed by what the person said: kept as written.
  expect(screenBackplanDrills(steps, ["我复习的习惯是做完卷子订正，错题抄进错题本"]).items.map((entry) => entry.title))
    .toEqual(["做 2 套往年卷并订正", "整理错题本", "按讲义推导第 5 章"]);
});
