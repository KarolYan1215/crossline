import { expect, test } from "vitest";
import {
  ATTRIBUTE_LONGEST, GOAL_SPLIT_SCHEMA, attributeLength, attributeShapeProblem, checkGoalParts, cleanAttribute, composeGoal, duplicateAttributes, goalCore, guessKind,
  insertByKind, keepGoalSplit, lineAttributes, notAtomic, orderAttributes, recomposes, validateGoalSplit, type AttributeKind, type GoalSplitContext
} from "./line-attributes";
import { structuredOutputProblems } from "./structured-output";

test("a goal is composed 「成为 A 的、B 的<身份>」 from the chosen parts in their order", () => {
  expect(composeGoal(["神经形态计算方向", "能独立立项"], "研究者")).toBe("成为神经形态计算方向的、能独立立项的研究者");
  expect(composeGoal(["有影响力"], "创作者")).toBe("成为有影响力的创作者");
  expect(composeGoal([], "创作者")).toBe("");
  expect(composeGoal(["AI 排班与备料产品", "产品设计能力"], "产品人")).toBe("成为 AI 排班与备料的、有产品设计能力的产品人");
  // A part typed with its own 的 or 成为 is not doubled.
  expect(composeGoal(["成为科普的", " 有影响力的 "], "创作者")).toBe("成为科普的、有影响力的创作者");
});

test("a composed goal reads as Chinese: fields share one 的, the noun's stem is not said twice, Latin gets its space (W-24)", () => {
  expect(composeGoal(["即刻内容创作", "公众号长文创作"], "创作者")).toBe("成为即刻内容、公众号长文的创作者");
  expect(composeGoal(["AI 排班与备料", "连锁门店运营"], "创业者")).toBe("成为 AI 排班与备料、连锁门店运营的创业者");
  // A part that is only the stem keeps it: nothing would be left.
  expect(composeGoal(["创作", "有影响力"], "创作者")).toBe("成为创作的、有影响力的创作者");
  // A split is still checked against the parts exactly as written.
  expect(recomposes(["即刻内容创作", "公众号长文创作"], "创作者", "成为即刻内容创作的、公众号长文创作的创作者")).toBe(true);
});

test("states said together share one 的, so the goal saved reads as the one previewed (W-269)", () => {
  expect(composeGoal(["作息有序", "情绪稳定"], "学生")).toBe("成为作息有序、情绪稳定的学生");
  expect(["体面", "经济从容", "生活有序"].map(guessKind)).toEqual(["state", "state", "state"]);
  // The picker previews and the line saves through the same function: what the person adopted is what is stored.
  expect(composeGoal(["经济学方向", "作息有序", "情绪稳定"], "学生")).toBe("成为经济学方向的、作息有序、情绪稳定的学生");
});

test("cleaning keeps the phrase and drops what composing adds back", () => {
  expect(cleanAttribute("  成为 神经形态计算方向的。")).toBe("神经形态计算方向");
  expect(cleanAttribute("「能独立立项」")).toBe("能独立立项");
  // Symbols that belong to a word stay (2026-11-14 audit: 「C++」 was cut to 「C」).
  expect(["精通 C++", "会 C#。", "懂 R&D 的"].map(cleanAttribute)).toEqual(["精通 C++", "会 C#", "懂 R&D"]);
});

test("duplicates: after removing 的 and punctuation, one contains the other", () => {
  expect(duplicateAttributes(["神经形态计算", "神经形态计算的", "器件物理"])).toEqual([["神经形态计算", "神经形态计算的"]]);
  expect(duplicateAttributes(["类脑神经形态计算", "神经形态计算"])).toHaveLength(1);
  // The same words with a few more in between are the same attribute; short or unrelated ones are not.
  expect(duplicateAttributes(["外推人类知识边界", "外推知识边界"])).toHaveLength(1);
  expect(duplicateAttributes(["能独立立项", "能立项"])).toHaveLength(0);
  expect(duplicateAttributes(["把脑机制转化为计算机制与硬件结构", "以真实技术链条和可复现证据工作"])).toHaveLength(0);
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

// 2026-11-25 (IR-025 retired): whether a candidate is an action, a count or an achievement is the extraction's judgement (its Skill); code
// refuses only the shape — a sentence-length phrase and the line's own name read back.
test("code refuses only an attribute's shape: wording that reads like an action is the Skill's to judge", () => {
  for (const text of ["严谨", "有影响力", "器件物理方向", "AI 教育方向", "成为严谨的", "能独立立项", "发表三篇顶会论文", "好奇心", "rigorous", "able to lead projects"])
    expect(attributeShapeProblem(text), text).toBeUndefined();
  expect(attributeLength("AI 教育方向")).toBe(5);
  const long = "在人工智能教育与科学传播交叉领域里被同行持续认可";
  expect(attributeLength(long)).toBeGreaterThan(ATTRIBUTE_LONGEST);
  expect(attributeShapeProblem(long)).toContain("是一句话");
});


test("adjectives are abilities or states when nobody labelled them, so a goal composed of them reads as Chinese", () => {
  expect(guessKind("严谨")).toBe("ability");
  expect(guessKind("判断力强")).toBe("ability");
  expect(guessKind("做事严谨")).toBe("ability");
  expect(guessKind("值得信赖")).toBe("state");
  expect(guessKind("受学生欢迎")).toBe("state");
  // A field that merely begins with such a word stays a field.
  expect(guessKind("独立游戏")).toBe("domain");
  expect(guessKind("开放科学")).toBe("domain");
  // Abilities in a row share one 的, as fields do; a field and an adjective never do.
  expect(composeGoal(["器件物理方向", "严谨", "高产", "有影响力"], "研究者")).toBe("成为器件物理方向的、严谨、高产的、有影响力的研究者");
  expect(composeGoal(["科普", "有影响力", "值得信赖"], "创作者")).toBe("成为科普的、有影响力、值得信赖的创作者");
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
  // The person's own choices are two choices even when one word contains the other (2026-11-14 audit).
  expect(checkGoalParts(["自由", "财务自由"])).toEqual({ ok: true, parts: ["自由", "财务自由"] });
  expect(checkGoalParts(["稳定", "情绪稳定"])).toEqual({ ok: true, parts: ["稳定", "情绪稳定"] });
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

test("English goals: composed, cleaned, split and read by the same rules", () => {
  expect(composeGoal(["AI hardware", "rigorous", "independent"], "researcher", "en")).toBe("Become an AI hardware, rigorous and independent researcher");
  expect(composeGoal(["rigorous"], "researcher", "en")).toBe("Become a rigorous researcher");
  expect(composeGoal([], "researcher", "en")).toBe("");
  expect(cleanAttribute("become a rigorous")).toBe("rigorous");
  expect(goalCore("Become a rigorous, prolific Researcher.", "researcher")).toBe("rigorous, prolific");
  expect(recomposes(["rigorous", "prolific"], "researcher", "Become a rigorous, prolific researcher")).toBe(true);
  expect(recomposes(["rigorous", "prolific"], "researcher", "Become a rigorous, prolific and famous researcher")).toBe(false);
  expect(notAtomic("rigorous as well as prolific")).toBe(true);
  expect(notAtomic("signal processing")).toBe(false);
  expect(guessKind("good at writing papers")).toBe("ability");
  expect(guessKind("strong experimental skills")).toBe("ability");
  expect(guessKind("financially independent")).toBe("state");
  expect(guessKind("trusted by peers")).toBe("state");
  expect(guessKind("AI hardware")).toBe("domain");
});

test("goal part problems are written in the person's language", async () => {
  await import("@crossline/i18n/catalog/worker");
  expect(checkGoalParts([], "en")).toMatchObject({ ok: false, message: "Choose at least one attribute" });
  expect(checkGoalParts(["rigorous", "rigorous"], "en")).toMatchObject({ ok: false, message: '"rigorous" and "rigorous" overlap' });
  expect(checkGoalParts([])).toMatchObject({ ok: false, message: "至少选一个定语" });
});

test("an attribute that only repeats the line's name is refused; one that adds to it is not", () => {
  expect(attributeShapeProblem("贝斯", "弹贝斯的")).toMatch(/主线名/);
  expect(attributeShapeProblem("社会学研究", "社会学研究者")).toMatch(/主线名/);
  expect(attributeShapeProblem("社会学方向", "社会学学生")).toMatch(/主线名/);
  expect(attributeShapeProblem("器件物理方向", "研究者")).toBeUndefined();
  expect(attributeShapeProblem("律动稳", "弹贝斯的")).toBeUndefined();
  expect(attributeShapeProblem("贝斯")).toBeUndefined();
});
