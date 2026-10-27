import { expect, test } from "vitest";
import {
  ATTRIBUTE_LONGEST, GOAL_SPLIT_SCHEMA, attributeLength, attributeProblem, checkGoalParts, cleanAttribute, composeGoal, duplicateAttributes, goalCore, guessKind,
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

test("cleaning keeps the phrase and drops what composing adds back", () => {
  expect(cleanAttribute("  成为 神经形态计算方向的。")).toBe("神经形态计算方向");
  expect(cleanAttribute("「能独立立项」")).toBe("能独立立项");
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

test("an attribute describes who the person becomes: adjectives and short fields pass, actions, counts and achievements do not (the owner's rule, 2026-10-19)", () => {
  for (const text of ["严谨", "高产", "独立", "有影响力", "值得信赖", "受学生欢迎", "器件物理方向", "神经形态计算方向", "财务自由", "判断力强", "做事严谨",
    "表达清晰", "科普", "长文方向", "AI 教育方向", "被同行认可", "持续产出", "稳定更新", "有产品设计能力", "成为严谨的"]) expect(attributeProblem(text), text).toBeUndefined();
  // Nouns and idioms that begin like a verb or hold a numeral are not caught: 能源, 会计, 写作, 完成度, 开发能力, Web3, 5G, 百家号.
  for (const text of ["能源方向", "能量充沛", "能动性强", "会计方向", "写作扎实", "完成度高", "获得感强", "开发能力强", "出版行业", "Web3 方向",
    "5G 通信方向", "3D 打印方向", "一流", "十项全能", "百家号方向", "以人为本", "把关严格"]) expect(attributeProblem(text), text).toBeUndefined();
  const caught: Array<[string, string]> = [["能独立立项", "「能」加动作"], ["可以独立带学生", "「可以」加动作"], ["擅长叙事", "「擅长」加动作"],
    ["会讲故事", "「会」加动作"], ["发表三篇顶会论文", "带数量"], ["10w+ 粉丝", "带数量"], ["Top 3 期刊", "带数量"], ["年入百万", "带数量"],
    ["写公众号长文", "以「写」开头"], ["做出有人付费的产品", "以「做出」开头"], ["外推人类知识边界", "以「外推」开头"], ["实现财务自由", "以「实现」开头"],
    ["坚持写作", "以「坚持」开头"], ["以长期研究", "以「以」开头"], ["把脑机制转化为硬件结构", "以「把」开头"], ["博士毕业", "以「毕业」结尾"],
    ["独立立项", "以「立项」结尾"], ["公司上市", "以「上市」结尾"]];
  for (const [text, why] of caught) expect(attributeProblem(text), text).toContain(why);
  // A sentence is not an attribute, however it starts.
  expect(attributeLength("AI 教育方向")).toBe(5);
  const long = "在人工智能教育与科学传播交叉领域里被同行持续认可";
  expect(attributeLength(long)).toBeGreaterThan(ATTRIBUTE_LONGEST);
  expect(attributeProblem(long)).toContain("是一句话");
});

test("in English, adjectives and fields pass; an ability with its verb or a leading achieving verb does not", () => {
  for (const text of ["rigorous", "independent", "influential", "signal processing", "trusted by peers", "candid"]) expect(attributeProblem(text), text).toBeUndefined();
  expect(attributeProblem("able to lead projects")).toContain('"able to" plus an action');
  expect(attributeProblem("good at storytelling")).toContain('"good at" plus an action');
  expect(attributeProblem("publish three papers")).toContain('starts with "publish"');
  expect(attributeProblem("launch a product")).toContain('starts with "launch"');
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
