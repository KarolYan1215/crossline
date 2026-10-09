import { expect, test } from "vitest";
import { PORTRAIT_IMAGE_STYLE, portraitImageBriefs, redactPortrait, validatePortrait, type PortraitReport } from "./portrait";

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

test("each illustrated section gets one prompt in the house style, written from the shared version, and shares are scaled to a whole", () => {
  const drawn: PortraitReport = { ...report, imagery: { cover: "a lighthouse at UW–Madison made of notebooks", problem: "", compass: "a compass rose", energy: "", lines: "braided strands" } };
  const briefs = portraitImageBriefs(drawn, [{ id: "research", label: "研究者" }, { id: "media", label: "创作者" }]);
  expect(briefs.map((brief) => brief.slot)).toEqual(["cover", "compass", "lines"]);
  for (const brief of briefs) { expect(brief.prompt).toContain(PORTRAIT_IMAGE_STYLE); expect(brief.prompt).not.toContain("UW–Madison"); }
  expect(briefs[2]!.prompt).toContain("deep blue, plum");
  const checked = validatePortrait({ ...report, lines: { allocation: "", items: [
    { lineId: "research", description: "", goals: [], feeds: [], share: 60, targetShare: 30 }, { lineId: "media", description: "", goals: [], feeds: [], share: 60, targetShare: 30 }] } }, ["research", "media"]);
  expect(checked.lines.items.map((item) => [item.share, item.targetShare])).toEqual([[50, 50], [50, 50]]);
});
