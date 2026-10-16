import { describe, expect, test } from "vitest";
import { acceptanceStandardLines, completionMode, completionRule, outcomeCriteriaVerdict, readCompletionOutcome, readModelCompletion } from "./completion";
import type { SuccessCriterion } from "./index";

const order = (title: string, extra: Record<string, unknown> = {}) => ({ intent: title, payload: { title, ...extra } });

describe("pressing 完成 (owner's decision, 2026-10-15)", () => {
  test("handing in, homework, sending, attending, filing and practice are done when said", () => {
    for (const title of ["完成 ECE 555 作业 2", "提交课程项目报告", "发送试用邀请", "参加组会", "汇集 ECE 548 复习材料", "确认 ECE 548 期中考查范围",
      "复习 ECE 548 第 3 章", "推导 L5 P-N 结静电", "盘点MVP现有实现"])
      expect(completionMode(order(title)), title).toBe("self_evident");
  });

  test("a judged event's result, hard-to-read quality and exploration are followed up later", () => {
    expect(completionRule(order("ECE 548 期中考试 1"))).toMatchObject({ mode: "needs_assessment", reason: "result_pending", askAfterHours: 24 });
    expect(completionRule(order("投稿 IEEE TCAS"))).toMatchObject({ reason: "result_pending" });
    expect(completionRule(order("列科研笔记提纲"))).toMatchObject({ mode: "needs_assessment", reason: "quality" });
    expect(completionRule(order("熟悉 Cadence Virtuoso"))).toMatchObject({ mode: "needs_assessment", reason: "exploration" });
    // Preparing for an exam is not sitting it.
    expect(completionMode(order("准备 ECE 548 期中考试"))).toBe("self_evident");
    expect(completionRule(order("ECE 548 期中考试 1")).question).toBe("「ECE 548 期中考试 1」的成绩或结果出来了吗？");
  });

  test("the person's choice at approval wins over the wording", () => {
    expect(completionMode(order("ECE 548 期中考试 1", { completionMode: "self_evident" }))).toBe("self_evident");
    expect(completionMode(order("完成 ECE 555 作业 2", { completionMode: "needs_assessment" }))).toBe("needs_assessment");
  });

  test("the optional 完成情况 is a level and a line, or nothing", () => {
    expect(readCompletionOutcome({ level: "barely", note: "  第 3 题没把握 " })).toEqual({ level: "barely", note: "第 3 题没把握" });
    expect(readCompletionOutcome({ level: "great" })).toBeUndefined();
    expect(readCompletionOutcome(undefined)).toBeUndefined();
  });
});

describe("what a reported score says about the milestone", () => {
  const threshold = (value: number, unit = "分"): SuccessCriterion => ({ id: "c1", statement: "期中 ≥ 85", required: true,
    measure: { kind: "threshold", unit, comparator: "gte", value } });
  test("read against the one threshold; ambiguous milestones get no reading", () => {
    expect(outcomeCriteriaVerdict([threshold(85)], "92/100")).toEqual([{ criterionId: "c1", met: "met", observed: "本人报告：92/100" }]);
    expect(outcomeCriteriaVerdict([threshold(85)], "80 分")[0]?.met).toBe("unmet");
    expect(outcomeCriteriaVerdict([threshold(90, "%")], "46/50")[0]?.met).toBe("met");
    expect(outcomeCriteriaVerdict([threshold(85), { ...threshold(90), id: "c2" }], "92")).toEqual([]);
    expect(outcomeCriteriaVerdict([threshold(85)], "已录用")).toEqual([]);
  });
});

test("the acceptance standard reads as the checklist the person approved", () => {
  expect(acceptanceStandardLines([{ description: "作业 2 的 PDF", required: true }, { description: "  " }, { description: "草稿", required: false }]))
    .toEqual(["作业 2 的 PDF", "草稿（可选）"]);
});

describe("the model's judgement of completion (owner's direction, 2026-10-15)", () => {
  const judged = { mode: "needs_assessment", reason: "result_pending", why: "第一轮由评委评审", question: "", askAfterHours: 72 };
  test("the model's value wins over the title rules: 「Hult Prize 第一轮」 names no exam yet waits for the judges", () => {
    expect(completionMode(order("Hult Prize 第一轮"))).toBe("self_evident");
    expect(completionRule(order("Hult Prize 第一轮", { completion: judged }))).toMatchObject({ mode: "needs_assessment", reason: "result_pending",
      askAfterHours: 72, by: "model", question: "「Hult Prize 第一轮」的成绩或结果出来了吗？" });
    // And the other way: a title the rules read as an exam, judged done-when-said.
    expect(completionRule(order("ECE 548 期中考试 1", { completion: { mode: "self_evident", reason: "", why: "只需到场", question: "", askAfterHours: 0 } })))
      .toMatchObject({ mode: "self_evident", why: "只需到场", by: "model" });
  });
  test("a task written before the field falls back to the title rules", () => {
    expect(completionRule(order("ECE 548 期中考试 1"))).toMatchObject({ reason: "result_pending", by: "rule" });
    expect(completionRule(order("ECE 548 期中考试 1", { completion: { mode: "maybe" } }))).toMatchObject({ by: "rule" });
  });
  test("the person's choice overrides the model, keeping the model's question when the person also wants to be asked", () => {
    expect(completionRule(order("Hult Prize 第一轮", { completion: judged, completionMode: "self_evident" }))).toMatchObject({ mode: "self_evident", by: "person" });
    expect(completionRule(order("Hult Prize 第一轮", { completion: judged, completionMode: "needs_assessment" }))).toMatchObject({ reason: "result_pending", askAfterHours: 72, by: "person" });
    expect(completionRule(order("完成 ECE 555 作业 2", { completion: { mode: "self_evident", reason: "", why: "x", question: "", askAfterHours: 0 },
      completionMode: "needs_assessment" }))).toMatchObject({ mode: "needs_assessment", reason: "quality", by: "person" });
  });
  test("a malformed judgement is made usable", () => {
    expect(readModelCompletion({ mode: "needs_assessment", reason: "", why: " w ", question: "", askAfterHours: -1 }))
      .toEqual({ mode: "needs_assessment", reason: "quality", why: "w", question: "", askAfterHours: 2 });
    expect(readModelCompletion({ mode: "self_evident", reason: "quality", why: "", question: "q", askAfterHours: 9 }))
      .toEqual({ mode: "self_evident", reason: "", why: "交付即完成", question: "", askAfterHours: 0 });
  });
});
