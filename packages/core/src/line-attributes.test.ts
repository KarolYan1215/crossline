import { expect, test } from "vitest";
import {
  GOAL_SPLIT_SCHEMA, checkGoalParts, cleanAttribute, composeGoal, duplicateAttributes, goalCore, guessKind, insertByKind, keepGoalSplit, lineAttributes,
  orderAttributes, recomposes, validateGoalSplit, type AttributeKind, type GoalSplitContext
} from "./line-attributes";
import { structuredOutputProblems } from "./structured-output";

test("a goal is composed 「成为 A 的、B 的<身份>」 from the chosen parts in their order", () => {
  expect(composeGoal(["神经形态计算方向", "能独立立项"], "研究者")).toBe("成为神经形态计算方向的、能独立立项的研究者");
  expect(composeGoal(["有影响力"], "创作者")).toBe("成为有影响力的创作者");
  expect(composeGoal([], "创作者")).toBe("");
  // A part typed with its own 的 or 成为 is not doubled.
  expect(composeGoal(["成为科普的", " 有影响力的 "], "创作者")).toBe("成为科普的、有影响力的创作者");
});

test("cleaning keeps the phrase and drops what composing adds back", () => {
  expect(cleanAttribute("  成为 神经形态计算方向的。")).toBe("神经形态计算方向");
  expect(cleanAttribute("「能独立立项」")).toBe("能独立立项");
});

test("duplicates: after removing 的 and punctuation, one contains the other", () => {
  expect(duplicateAttributes(["神经形态计算", "神经形态计算的", "器件物理"])).toEqual([["神经形态计算", "神经形态计算的"]]);
  expect(duplicateAttributes(["类脑神经形态计算", "神经形态计算"])).toHaveLength(1);
  expect(duplicateAttributes(["器件物理", "能独立立项", "持续产出"])).toEqual([]);
});

test("attributes are ordered as Chinese attributives are — field, ability, state — keeping the order within a kind", () => {
  const list = [{ text: "被同行认可", kind: "state" as const }, { text: "能独立立项", kind: "ability" as const },
    { text: "神经形态计算", kind: "domain" as const }, { text: "能写基金申请", kind: "ability" as const }];
  expect(orderAttributes(list).map((item) => item.text)).toEqual(["神经形态计算", "能独立立项", "能写基金申请", "被同行认可"]);
});

test("a new pick goes after the last chosen one of its kind or an earlier kind, so a manual order survives", () => {
  const kinds: Record<string, AttributeKind> = { 领域A: "domain", 领域B: "domain", 能力A: "ability", 状态A: "state" };
  const kindOf = (text: string) => kinds[text] ?? "domain";
  expect(insertByKind(["领域A", "状态A"], "能力A", kindOf)).toEqual(["领域A", "能力A", "状态A"]);
  expect(insertByKind(["能力A", "状态A"], "领域B", kindOf)).toEqual(["领域B", "能力A", "状态A"]);
  // The person dragged a state before an ability: a new domain still goes first, a new state after the last one that does not come later.
  expect(insertByKind(["领域A", "状态A", "能力A"], "领域B", kindOf)).toEqual(["领域A", "领域B", "状态A", "能力A"]);
  expect(insertByKind([], "状态A", kindOf)).toEqual(["状态A"]);
});

test("an unlabelled attribute's kind is read by rule: abilities, lasting states, otherwise a field", () => {
  expect(guessKind("能独立立项")).toBe("ability");
  expect(guessKind("善于讲清复杂问题")).toBe("ability");
  expect(guessKind("工程落地能力")).toBe("ability");
  expect(guessKind("持续产出")).toBe("state");
  expect(guessKind("被同行认可")).toBe("state");
  expect(guessKind("神经形态计算方向")).toBe("domain");
});

test("recomposing ignores whitespace, punctuation and the 的 that joining adds, and nothing else", () => {
  expect(recomposes(["神经形态计算方向", "能独立立项"], "研究者", "成为神经形态计算方向能独立立项的研究者")).toBe(true);
  expect(recomposes(["有影响力", "科普"], "创作者", "成为有影响力的科普创作者")).toBe(true);
  expect(recomposes(["有影响力", "科普"], "创作者", "成为有影响力的科普创作者。")).toBe(true);
  // A dropped, added or reordered word is not the same sentence.
  expect(recomposes(["有影响力"], "创作者", "成为有影响力的科普创作者")).toBe(false);
  expect(recomposes(["科普", "有影响力"], "创作者", "成为有影响力的科普创作者")).toBe(false);
  expect(recomposes(["有很大影响力", "科普"], "创作者", "成为有影响力的科普创作者")).toBe(false);
  expect(recomposes([], "创作者", "")).toBe(false);
});

test("a whole sentence's core is what lies between 成为 and 的<身份>", () => {
  expect(goalCore("成为神经形态计算方向能独立立项的研究者", "研究者")).toBe("神经形态计算方向能独立立项");
  expect(goalCore("发表两篇论文", "研究者")).toBe("发表两篇论文");
});

test("old whole-sentence candidates are read as one attribute each; stored attributes win", () => {
  expect(lineAttributes({ goalCandidates: ["成为有影响力的科普创作者", "成为有影响力的科普创作者"] }, "创作者"))
    .toEqual([{ text: "有影响力的科普", kind: "state", sourceRef: "" }]);
  expect(lineAttributes({ attributes: [{ text: "科普", kind: "domain", sourceRef: "reply-1" }], goalCandidates: ["x"] }, "创作者"))
    .toEqual([{ text: "科普", kind: "domain", sourceRef: "reply-1" }]);
  expect(lineAttributes(undefined, "创作者")).toEqual([]);
});

test("chosen parts are checked before they become a goal", () => {
  expect(checkGoalParts(["科普", " 有影响力的 "])).toEqual({ ok: true, parts: ["科普", "有影响力"] });
  expect(checkGoalParts([])).toMatchObject({ ok: false, code: "LINE_GOAL_PARTS_EMPTY" });
  expect(checkGoalParts("科普")).toMatchObject({ ok: false, code: "LINE_GOAL_PARTS_INVALID" });
  expect(checkGoalParts(["科普", "科普的"])).toMatchObject({ ok: false, code: "LINE_GOAL_PARTS_DUPLICATE" });
  expect(checkGoalParts(Array.from({ length: 13 }, (_, index) => `定语${index}`))).toMatchObject({ ok: false, code: "LINE_GOAL_PARTS_TOO_MANY" });
});

const context: GoalSplitContext = { version: "crossline.goal-split.v1", lines: [
  { id: "research", label: "研究者", goals: ["成为神经形态计算方向能独立立项的研究者"] },
  { id: "media", label: "创作者", goals: ["成为有影响力的科普创作者", "成为稳定更新的创作者"] }] };
const good = { lines: [
  { lineId: "research", goals: [{ goal: "成为神经形态计算方向能独立立项的研究者", parts: [{ text: "神经形态计算方向", kind: "domain" }, { text: "能独立立项", kind: "ability" }] }] },
  { lineId: "media", goals: [{ goal: "成为有影响力的科普创作者", parts: [{ text: "有影响力", kind: "state" }, { text: "科普", kind: "domain" }] },
    { goal: "成为稳定更新的创作者", parts: [{ text: "稳定更新", kind: "state" }] }] }] };

test("the split schema meets the strict structured-output rules", () => {
  expect(structuredOutputProblems(GOAL_SPLIT_SCHEMA)).toEqual([]);
});

test("a split passes only when every goal comes back with parts that recompose it", () => {
  expect(validateGoalSplit(good, context).lines[1]!.goals[0]!.parts.map((part) => part.text)).toEqual(["有影响力", "科普"]);
  const reject = (value: unknown, code: string) => expect(() => validateGoalSplit(value, context)).toThrow(code);
  reject({ lines: [good.lines[0]] }, "GOAL_SPLIT_LINE_MISSING");
  reject({ lines: [good.lines[0], { lineId: "media", goals: [good.lines[1]!.goals[0]] }] }, "GOAL_SPLIT_GOAL_MISSING");
  reject({ lines: [{ lineId: "research", goals: [{ goal: "成为神经形态计算方向能独立立项的研究者", parts: [{ text: "类脑计算", kind: "domain" }] }] }, good.lines[1]] }, "GOAL_SPLIT_NOT_RECOMPOSED");
  reject({ lines: [{ lineId: "research", goals: [{ goal: "成为神经形态计算方向能独立立项的研究者", parts: [{ text: "神经形态计算方向", kind: "domain" }, { text: "神经形态计算方向的", kind: "domain" }] }] }, good.lines[1]] }, "GOAL_SPLIT_DUPLICATE");
});

test("when the repairs run out, a goal whose split does not recompose is kept whole as one attribute", () => {
  const kept = keepGoalSplit({ lines: [{ lineId: "research", goals: [{ goal: "成为神经形态计算方向能独立立项的研究者", parts: [{ text: "类脑计算", kind: "domain" }] }] }, good.lines[1]] }, context);
  expect(kept.lines[0]!.goals[0]!.parts.map((part) => part.text)).toEqual(["神经形态计算方向能独立立项"]);
  expect(kept.lines[1]!.goals[0]!.parts.map((part) => part.text)).toEqual(["有影响力", "科普"]);
  // Nothing usable at all: every goal whole.
  expect(keepGoalSplit(null, context).lines.flatMap((line) => line.goals.map((goal) => goal.parts.length))).toEqual([1, 1, 1]);
});
