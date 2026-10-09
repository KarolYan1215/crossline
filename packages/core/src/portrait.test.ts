import { expect, test } from "vitest";
import { redactPortrait, validatePortrait, type PortraitReport } from "./portrait";
import { CHARACTER_STANDARD, characterPrompt, portraitLabels, portraitType } from "./portrait-type";

const report: PortraitReport = {
  cover: { portrait: "在 UW–Madison 读博的研究者，想把研究连到产品。", coreConflict: "并行承诺多于可用注意力", keywords: ["研究者"] },
  problem: { statement: "", gravity: [], designable: [], reframes: [] },
  compass: { workView: "", lifeView: "", consistency: "", trueNorth: "" },
  energy: { summary: "", map: [], flow: [] },
  lines: { allocation: "", items: [{ lineId: "research", description: "UW–Madison 的博士研究", goals: ["成为能独立立项的研究者"], feeds: [{ toLineId: "media", how: "选题" }, { toLineId: "ghost", how: "x" }] }] },
  gap: { says: "", does: "", reading: "", anchor: "", realWant: "", reframe: "" },
  insights: [], sensitive: ["UW–Madison", "不存在的词"]
};

test("a portrait keeps only real lines and links, and sensitive spans that occur in it", () => {
  const checked = validatePortrait(report, ["research", "media"]);
  expect(checked.lines.items[0]!.feeds).toEqual([{ toLineId: "media", how: "选题" }]);
  expect(checked.sensitive).toEqual(["UW–Madison"]);
  expect(() => validatePortrait({ ...report, lines: { allocation: "", items: [{ ...report.lines.items[0]!, lineId: "x" }] } }, ["research"])).toThrow("PORTRAIT_LINE_UNKNOWN");
});

test("the shared version hides every sensitive span but keeps line ids", () => {
  const shared = redactPortrait(validatePortrait(report, ["research", "media"]));
  expect(shared.cover.portrait).not.toContain("UW–Madison");
  expect(shared.lines.items[0]!.description).toContain("▇");
  expect(shared.lines.items[0]!.lineId).toBe("research");
});

test("the type is read from the axis scores into a fixed name and group; the figure follows one standard and never carries a sensitive span", () => {
  const typed: PortraitReport = { ...report,
    type: { scope: 82, basis: 30, output: 40, rhythm: 55, evidence: { scope: "四条主线并行", basis: "强调数据可追溯", output: "做仿真与产品", rhythm: "边做边调" } },
    character: { outfit: "a lab coat over a hoodie from UW–Madison", props: ["a notebook", "a small oscilloscope"], pose: "standing confidently", expression: "focused" },
    lines: { allocation: "", items: [{ lineId: "research", description: "", goals: [], feeds: [{ toLineId: "media", how: "" }], targetShare: 60 },
      { lineId: "media", description: "", goals: [], feeds: [{ toLineId: "startup", how: "" }], targetShare: 20 }, { lineId: "startup", description: "", goals: [], feeds: [{ toLineId: "research", how: "" }], targetShare: 20 }] } };
  const type = portraitType(typed)!;
  expect([type.code, type.name, type.group.name]).toEqual(["GEMA", "跨界建造者", "架构组"]);
  expect(type.axes.map((axis) => [axis.label, axis.percent])).toEqual([["跨界", 82], ["实证", 70], ["造物", 60], ["应变", 55]]);
  const prompt = characterPrompt(typed)!;
  expect(prompt).toContain(CHARACTER_STANDARD);
  expect(prompt).toContain("deep blue");
  expect(prompt).not.toContain("UW–Madison");
  expect(portraitLabels(typed, { lineLabel: (id) => id }).find((label) => label.title === "飞轮形态")?.value).toBe("环形飞轮");
  expect(portraitType(report)).toBeNull();
});

test("shares are scaled to a whole", () => {
  const checked = validatePortrait({ ...report, lines: { allocation: "", items: [
    { lineId: "research", description: "", goals: [], feeds: [], share: 60, targetShare: 30 }, { lineId: "media", description: "", goals: [], feeds: [], share: 60, targetShare: 30 }] } }, ["research", "media"]);
  expect(checked.lines.items.map((item) => [item.share, item.targetShare])).toEqual([[50, 50], [50, 50]]);
});
