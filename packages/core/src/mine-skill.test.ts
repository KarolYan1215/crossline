import { expect, test } from "vitest";
import {
  keepMineSkill, mineFactLabel, readableMineSourceLabel, readableMineText, mineSkillName, renderMineSkill, structuredOutputProblems, validateMilestoneGateResult, validateMineSkill,
  MINE_SKILL_SCHEMA, applyMineChanges, mineMaterialId, mineTextHash, resolveMineSources, type MilestoneGateResult, type MineSkillContext
} from "./index";

// The real account's note on the assistant's first Xiaohongshu outline (agent-97846949-1, 2026-10-14).
const NOTE = "本人选主线 A（科研是缩小不确定性的循环）。不同意按科研报告的边界来做：自媒体的核心是制造冲突和贩卖焦虑，再通过卖 solution 变现，而不是做得像科研报告一样。";
const context: MineSkillContext = {
  version: "crossline.mine-skill.v2", today: "2026-10-14", line: { id: "media", label: "创作者", goals: ["成为有影响力的科普创作者"] },
  materials: [
    { id: "m1", kind: "review", text: NOTE, at: "2026-10-14T05:37:39.617Z", label: "2026-10-14 本人采纳助手结果「为小红书首篇…」时的备注" },
    { id: "m2", kind: "fact", text: "小红书（原话：主要发小红书）", at: "2026-10-01T00:00:00Z", label: "访谈中确认的「platform」" }
  ],
  previousRules: []
};
const play = { kind: "play" as const, text: "笔记先制造冲突、点出焦虑，再给出可购买的 solution，不写成科研报告体", sources: ["m1"],
  quote: "自媒体的核心是制造冲突和贩卖焦虑，再通过卖 solution 变现", url: "" };

test("the compiler's schema keeps to the strict-mode rules", () => {
  expect(structuredOutputProblems(MINE_SKILL_SCHEMA)).toEqual([]);
  expect(mineSkillName("media")).toBe("crossline-mine:media");
  expect(mineSkillName("line-Ke Pu")).toBe("crossline-mine:line-ke-pu");
});

test("a rule stands only on the person's own words: unknown sources, a quote not in them, or no source at all are refused", () => {
  expect(validateMineSkill({ summary: "", rules: [play], blockers: [] }, context).rules).toHaveLength(1);
  // Punctuation may differ from the source; words may not.
  expect(validateMineSkill({ summary: "", rules: [{ ...play, quote: "自媒体的核心是 制造冲突和贩卖焦虑" }], blockers: [] }, context).rules).toHaveLength(1);
  for (const [rule, detail] of [
    [{ ...play, sources: ["m9"] }, "m9 不在 materials 里"],
    [{ ...play, quote: "自媒体要做得严谨可信" }, "找不到逐字原文"],
    [{ ...play, sources: [] }, "没有来源"],
    [{ ...play, kind: "preference" as const, sources: [], url: "https://www.xiaohongshu.com/crown/community/rules" }, "没有来源"]
  ] as const) {
    try { validateMineSkill({ summary: "", rules: [rule], blockers: [] }, context); throw new Error("accepted"); }
    catch (error) { expect((error as Error & { detail?: string }).detail).toContain(detail); }
  }
  // A platform red line may rest on the platform's own page instead.
  const redline = { kind: "redline" as const, text: "不针对性别、地域等群体制造对立", sources: [], quote: "反对制造对立", url: "https://www.xiaohongshu.com/crown/community/rules" };
  expect(validateMineSkill({ summary: "", rules: [play, redline], blockers: [] }, context).rules).toHaveLength(2);
  // A stop with nothing written is a blocker, not a repair.
  expect(() => validateMineSkill({ summary: "", rules: [], blockers: [{ code: "MINE_SKILL_NOTHING_TO_SAY", message: "只有排程事实" }] }, context)).toThrow("MINE_SKILL_BLOCKED");
});

test("after the repairs, the rules that stand are kept and the rest dropped", () => {
  const kept = keepMineSkill({ summary: "s", rules: [play, { ...play, text: "另一条", quote: "编造" }, play], blockers: [] }, context);
  expect(kept?.rules).toEqual([{ ...play, op: "add", ruleId: "" }]);
  expect(keepMineSkill({ summary: "s", rules: [{ ...play, sources: [] }], blockers: [] }, context)).toBeUndefined();
});

test("the SKILL.md is written by code, every rule with where it came from", () => {
  const { markdown, rules } = renderMineSkill({ line: { id: "media", label: "创作者" }, version: 2, at: "2026-10-14T06:00:00Z", summary: "以冲突开场。",
    rules: [play], materials: context.materials });
  expect(markdown).toMatch(/^---\nname: media\ndescription: "本人在「创作者」主线上的打法、偏好与红线（第 2 版）/);
  expect(markdown).toContain("## 打法\n\n1. 笔记先制造冲突");
  expect(markdown).toContain("来源：2026-10-14 本人采纳助手结果「为小红书首篇…」时的备注：「自媒体的核心是制造冲突和贩卖焦虑，再通过卖 solution 变现」");
  expect(markdown).toContain("只有「红线」必须避开");
  expect(rules[0]!.sourceLabels).toEqual([context.materials[0]!.label]);
});

const criteria = [{ id: "c1", statement: "首篇笔记发布", required: true, measure: { kind: "judgement" as const, rubric: "发布", failsWhen: "未发布" } }];
const covered: MilestoneGateResult = {
  verdict: "pass",
  criteriaVerdict: [{ criterionId: "c1", met: "unmet", observed: "尚未发布", evidenceQuote: "", shortfall: "未发布" }],
  contractCoverage: [{ requirement: "提纲与 3 个公开来源", satisfiedBy: "e1", reasoning: "有提纲", quote: "提纲" }],
  unplannedGains: [], improvements: [], incomplete: [], flywheelAssessment: [], gaps: [], proposedNextMilestones: [], blockers: [],
  fit: { fits: true, violated: [], why: "" }
};
const evidence = ["首篇笔记提纲：科研如何实际发生（报告体）"];
const contract = ["提纲与 3 个公开来源"];
const offPlay = { fits: false, violated: ["笔记先制造冲突、点出焦虑，再给出可购买的 solution"], why: "提纲按科研报告写成，没有冲突和 solution" };

test("the gate: a delivery that covers its contract but breaks the person's line skill is partial, never pass", () => {
  expect(validateMilestoneGateResult(covered, criteria, evidence, contract, true)).toBe(covered);
  const partial = { ...covered, verdict: "partial" as const, fit: offPlay };
  expect(validateMilestoneGateResult(partial, criteria, evidence, contract, true)).toBe(partial);
  const detail = (result: MilestoneGateResult, hasSkill = true) => {
    try { validateMilestoneGateResult(result, criteria, evidence, contract, hasSkill); return ""; }
    catch (error) { return (error as Error & { detail?: string }).detail ?? ""; }
  };
  expect(detail({ ...covered, fit: offPlay })).toContain("verdict 应为 partial");
  expect(detail({ ...covered, verdict: "insufficient", fit: offPlay })).toContain("应为 partial 而不是 insufficient");
  expect(detail({ ...covered, verdict: "partial" })).toContain("verdict 应为 pass");
  expect(detail({ ...covered, verdict: "partial", fit: { ...offPlay, violated: [] } })).toContain("violated 须逐条写明");
  // Not covering the contract is still insufficient, whatever the fit.
  const uncovered = { ...covered, verdict: "partial" as const, contractCoverage: [{ ...covered.contractCoverage[0]!, satisfiedBy: null }], fit: offPlay };
  expect(detail(uncovered)).toContain("契约未覆盖时用 insufficient");
  // With no line skill there is nothing to break.
  expect(detail({ ...covered, verdict: "partial", fit: offPlay }, false)).toContain("没有给出本人的主线 skill");
  // A judgement from before `fit` existed reads as fitting.
  const { fit: _fit, ...older } = covered;
  expect(validateMilestoneGateResult(older, criteria, evidence, contract)).toBe(older);
});

test("a rule's source never shows the interview's slot key (W-19)", () => {
  expect(mineFactLabel("customer_data_gaps", "缺门店销量数据")).toBe("访谈中确认的「客户数据缺口」");
  expect(mineFactLabel("pricing_anchor", "试用期每家门店月费 199 元起")).toBe("访谈中确认的「试用期每家门店月费 19…」");
  expect(readableMineSourceLabel("访谈中确认的「long_term_goal」")).toBe("访谈中确认的「长期目标」");
  expect(readableMineSourceLabel("访谈中确认的「odd_slot_x」")).toBe("访谈中确认的一条事实");
  expect(readableMineSourceLabel("evidence")).toBe("访谈中确认的「进展证据」");
  expect(readableMineSourceLabel("2026-10-14 本人编辑的第 2 版")).toBe("2026-10-14 本人编辑的第 2 版");
  expect(readableMineText("1. 先抛冲突（来源：访谈中确认的「evidence」）")).toBe("1. 先抛冲突（来源：访谈中确认的「进展证据」）");
});

test("incremental: changes name previous rules by id, may cite a previous rule's sources, and unnamed rules stay", () => {
  const previous = { id: "r1", ...play };
  const shorter = { id: "r2", kind: "preference" as const, text: "标题不超过 15 个字", sources: ["m2"], quote: "主要发小红书", url: "" };
  const incremental: MineSkillContext = { ...context, materials: [{ id: "m3", kind: "preference", text: "开头先说结论，再讲冲突", at: "2026-10-20T00:00:00Z", label: "本人的纠正" }],
    previousRules: [previous, shorter] };
  // m1 is not shown again, but it is r1's source and stays citable.
  const citable = [...incremental.materials, context.materials[0]!, context.materials[1]!];
  const add = { op: "add" as const, ruleId: "", kind: "preference" as const, text: "开头先说结论", sources: ["m3"], quote: "开头先说结论", url: "" };
  const revise = { op: "revise" as const, ruleId: "r1", ...play, text: "先抛冲突再给 solution，开头一句给结论", sources: ["m1", "m3"] };
  const answer = validateMineSkill({ summary: "", rules: [add, revise], blockers: [] }, incremental, citable);
  const { rules, dropped } = applyMineChanges(answer, incremental, citable);
  expect(rules.map((rule) => rule.text)).toEqual(["先抛冲突再给 solution，开头一句给结论", "标题不超过 15 个字", "开头先说结论"]);
  expect(dropped).toEqual([]);
  // An unknown rule id, or one handled twice, goes back to the model.
  expect(() => validateMineSkill({ summary: "", rules: [{ ...revise, ruleId: "r9" }], blockers: [] }, incremental, citable)).toThrow("MINE_SKILL_RULE_UNSOURCED");
  expect(() => validateMineSkill({ summary: "", rules: [revise, { ...revise, op: "drop" }], blockers: [] }, incremental, citable)).toThrow("MINE_SKILL_RULE_REPEATED");
  // A source that is neither shown nor a previous rule's is refused.
  expect(() => validateMineSkill({ summary: "", rules: [{ ...add, sources: ["m1"] }], blockers: [] }, incremental, incremental.materials)).toThrow("MINE_SKILL_RULE_UNSOURCED");
  // Nothing new about the play: no changes and no blocker, every rule stays; a drop removes one; a rule whose material is gone goes.
  const none = validateMineSkill({ summary: "", rules: [], blockers: [{ code: "MINE_SKILL_NOTHING_TO_SAY", message: "只有排程" }] }, incremental, citable);
  expect(applyMineChanges(none, incremental, citable).rules).toHaveLength(2);
  expect(applyMineChanges({ summary: "", rules: [{ ...revise, op: "drop" }], blockers: [] }, incremental, citable).rules.map((rule) => rule.text)).toEqual(["标题不超过 15 个字"]);
  expect(applyMineChanges(none, incremental, [context.materials[0]!])).toEqual({ rules: [play], dropped: ["标题不超过 15 个字：所依据的材料已不在"] });
});

test("a stored rule's sources are found again by its quote when its ids were positions; material ids follow their keys", () => {
  expect(resolveMineSources({ sources: ["m1"], quote: "自媒体的核心是制造冲突" }, context.materials)).toEqual(["m1"]);
  const renumbered = context.materials.map((material, index) => ({ ...material, id: mineMaterialId(`key-${index}`) }));
  expect(resolveMineSources({ sources: ["m1"], quote: "自媒体的核心是制造冲突" }, renumbered)).toEqual([renumbered[0]!.id]);
  expect(resolveMineSources({ sources: ["m1"], quote: "从没说过的话" }, renumbered)).toEqual([]);
  expect(mineMaterialId("review:e1")).toBe(mineMaterialId("review:e1"));
  expect(mineMaterialId("review:e1")).toMatch(/^m[0-9a-f]{6}$/);
  expect(mineTextHash("a")).not.toBe(mineTextHash("b"));
});
