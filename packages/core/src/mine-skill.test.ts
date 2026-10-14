import { expect, test } from "vitest";
import {
  keepMineSkill, mineSkillName, renderMineSkill, structuredOutputProblems, validateMilestoneGateResult, validateMineSkill,
  MINE_SKILL_SCHEMA, type MilestoneGateResult, type MineSkillContext
} from "./index";

// The real account's note on the assistant's first Xiaohongshu outline (agent-97846949-1, 2026-10-14).
const NOTE = "本人选主线 A（科研是缩小不确定性的循环）。不同意按科研报告的边界来做：自媒体的核心是制造冲突和贩卖焦虑，再通过卖 solution 变现，而不是做得像科研报告一样。";
const context: MineSkillContext = {
  version: "crossline.mine-skill.v1", today: "2026-10-14", line: { id: "media", label: "创作者", goals: ["成为有影响力的科普创作者"] },
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
  expect(kept?.rules).toEqual([play]);
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
