import { expect, test } from "vitest";
import { ENERGY_CATEGORIES, PORTRAIT_SCHEMA, PORTRAIT_SCHEMA_VERSION, SAY_DO_DIMENSIONS, SCHWARTZ_VALUES, redactPortrait, validatePortrait, type PortraitReport } from "./portrait";
import { CHARACTER_STANDARD, TYPE_AXES, TYPE_TABLE, characterPrompt, portraitLabels, portraitType, typeSummaryProblem } from "./portrait-type";

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
    type: { collab: 55, purpose: 30, build: 40, lines: 82, evidence: { collab: "和 AI 边做边调", purpose: "要能交付的结果", build: "先定结构", lines: "四条主线并行" } },
    character: { outfit: "a lab coat over a hoodie from UW–Madison", props: ["a notebook", "a small oscilloscope"], pose: "standing confidently", expression: "focused" },
    lines: { allocation: "", items: [{ lineId: "research", description: "", goals: [], feeds: [{ toLineId: "media", how: "" }], targetShare: 60 },
      { lineId: "media", description: "", goals: [], feeds: [{ toLineId: "startup", how: "" }], targetShare: 20 }, { lineId: "startup", description: "", goals: [], feeds: [{ toLineId: "research", how: "" }], targetShare: 20 }] } };
  const type = portraitType(typed)!;
  expect([type.code, type.name, type.group.name]).toEqual(["WOBG", "舰长", "机甲派"]);
  expect(type.axes.map((axis) => [axis.label, axis.percent])).toEqual([["共生", 55], ["交付", 70], ["蓝图", 60], ["多星", 82]]);
  const prompt = characterPrompt(typed)!;
  expect(prompt).toContain(CHARACTER_STANDARD);
  expect(prompt).toContain("deep blue");
  expect(prompt).not.toContain("UW–Madison");
  expect(portraitType(report)).toBeNull();
});

test("the person's own appearance replaces the neutral defaults; the base line's colour moves to accessories and the circle keeps the group tint", () => {
  const typed: PortraitReport = { ...report,
    type: { lines: 82, purpose: 30, build: 40, collab: 55, evidence: { lines: "", purpose: "", build: "", collab: "" } },
    character: { outfit: "an all-black hoodie and black trousers", props: ["a notebook"], pose: "standing confidently", expression: "focused",
      appearance: "male, long wolf-cut hair, dressed all in black" },
    lines: { allocation: "", items: [{ lineId: "research", description: "", goals: [], feeds: [], targetShare: 60 }, { lineId: "media", description: "", goals: [], feeds: [], targetShare: 40 }] } };
  const prompt = characterPrompt(typed)!;
  expect(prompt).toContain("male, long wolf-cut hair, dressed all in black");
  expect(prompt).not.toContain("gender-neutral");
  expect(prompt).not.toContain("simple neat hairstyle");
  expect(prompt).toContain("Accessories and small details");
  expect(prompt).toContain("deep blue");
  expect(prompt).not.toContain("main colour deep blue");
  expect(prompt).toContain(`Group tint for the circle: ${portraitType(typed)!.group.tint}`);
  // Without the person's words nothing changes.
  expect(characterPrompt({ ...typed, character: { ...typed.character!, appearance: "" } })).toContain("main colour deep blue");
});

test("shares are scaled to a whole", () => {
  const checked = validatePortrait({ ...report, lines: { allocation: "", items: [
    { lineId: "research", description: "", goals: [], feeds: [], share: 60, targetShare: 30 }, { lineId: "media", description: "", goals: [], feeds: [], share: 60, targetShare: 30 }] } }, ["research", "media"]);
  expect(checked.lines.items.map((item) => [item.share, item.targetShare])).toEqual([[50, 50], [50, 50]]);
});

const SCHWARTZ = ["自主", "刺激", "享乐", "成就", "权力", "安全", "遵从", "传统", "仁慈", "普世"];
const SAY_DO = ["按计划投入", "按时完成", "收尾", "外部验收", "回应等待"];
const values = (names: string[]) => names.map((name, index) => ({ name, score: 40 + index, evidence: "" }));
const pairs = (labels: string[]) => labels.map((dimension) => ({ dimension, says: 60, evidence: "" }));
const detailOf = (run: () => unknown) => { try { run(); } catch (error) { return `${(error as Error).message} ${(error as Error & { detail?: string }).detail ?? ""}`; } return ""; };

test("the fixed dimensions: Schwartz's ten values in circle order, six energy categories, five say–do dimensions", () => {
  expect(SCHWARTZ_VALUES.map((value) => value.name)).toEqual(SCHWARTZ);
  expect([...ENERGY_CATEGORIES]).toEqual(["深度工作", "学习输入", "创造产出", "沟通协作", "行政事务", "休息恢复"]);
  expect(SAY_DO_DIMENSIONS.map((dimension) => dimension.label)).toEqual(SAY_DO);
  expect(SAY_DO_DIMENSIONS.map((dimension) => dimension.id)).toEqual(["plan", "on_time", "follow_through", "acceptance", "waiting"]);
  expect(PORTRAIT_SCHEMA_VERSION).toBe(6);
});

test("the schema asks for exactly those dimensions, a short core word, and no 'does' score", () => {
  const props = PORTRAIT_SCHEMA.properties as Record<string, any>;
  const valuesSchema = props.compass.properties.values;
  expect(valuesSchema.items.properties.name.enum).toEqual(SCHWARTZ);
  expect(valuesSchema.maxItems).toBe(10);
  expect(props.energy.properties.map.items.properties.category.enum).toEqual([...ENERGY_CATEGORIES]);
  const pairItem = props.gap.properties.pairs.items;
  expect(Object.keys(pairItem.properties)).toEqual(["dimension", "says", "evidence"]);
  expect(pairItem.properties.dimension.enum).toEqual(SAY_DO);
  expect(props.cover.properties.coreWord.maxLength).toBe(6);
});

test("values and say–do pairs must be complete; they come back in the fixed order", () => {
  const nine = { ...report, compass: { ...report.compass, values: values(SCHWARTZ.slice(0, 9)) } };
  expect(detailOf(() => validatePortrait(nine, ["research", "media"]))).toMatch(/PORTRAIT_VALUES_INCOMPLETE.*普世/);
  const repeated = { ...report, compass: { ...report.compass, values: values([...SCHWARTZ.slice(0, 9), "自主"]) } };
  expect(detailOf(() => validatePortrait(repeated, ["research", "media"]))).toMatch(/PORTRAIT_VALUES_INCOMPLETE.*自主/);
  const fourPairs = { ...report, gap: { ...report.gap, pairs: pairs(SAY_DO.slice(1)) } };
  expect(detailOf(() => validatePortrait(fourPairs, ["research", "media"]))).toMatch(/PORTRAIT_SAY_DO_INCOMPLETE.*按计划投入/);
  const shuffled = validatePortrait({ ...report, compass: { ...report.compass, values: values([...SCHWARTZ].reverse()) },
    gap: { ...report.gap, pairs: pairs([...SAY_DO].reverse()) } }, ["research", "media"]);
  expect(shuffled.compass.values!.map((value) => value.name)).toEqual(SCHWARTZ);
  expect(shuffled.gap.pairs!.map((pair) => pair.dimension)).toEqual(SAY_DO);
  // Leniently, the order is fixed but nothing is refused (the answer kept after repairs run out).
  expect(validatePortrait(nine, ["research", "media"], { lenient: true }).compass.values).toHaveLength(9);
});

test("the labels are computed: core word, top Schwartz value, base line, and the other lines as identities", () => {
  const labelled: PortraitReport = { ...report, cover: { ...report.cover, coreWord: "系统化" },
    compass: { ...report.compass, values: SCHWARTZ.map((name) => ({ name, score: name === "成就" || name === "普世" ? 90 : 50, evidence: "" })) },
    lines: { allocation: "", items: [
      { lineId: "media", description: "", goals: [], feeds: [], share: 30, targetShare: 20 },
      { lineId: "research", description: "", goals: [], feeds: [], share: 40, targetShare: 50 },
      { lineId: "startup", description: "", goals: [], feeds: [], targetShare: 30 }] } };
  const { cells, identities } = portraitLabels(labelled, { lineLabel: (id) => `L-${id}` });
  expect(cells).toEqual([
    { title: "核心词", value: "系统化" },
    { title: "价值核心", value: "成就" },
    { title: "建议底座", value: "L-research", detail: "建议投入约 50%" }]);
  expect(identities).toEqual([
    { lineId: "startup", label: "L-startup", target: 30, now: null },
    { lineId: "media", label: "L-media", target: 20, now: 30 }]);
  const old = portraitLabels({ ...labelled, cover: report.cover, compass: { ...report.compass, values: [{ name: "求真", score: 90, evidence: "" }] } }, { lineLabel: (id) => id });
  expect(old.cells.map((cell) => cell.title)).toEqual(["建议底座"]);
  for (const title of ["飞轮形态", "充电方式", "工作时段"]) expect(cells.some((cell) => cell.title === title)).toBe(false);
});

test("类型名互不共用字词；字母是英文词首字母；个人简介对本人说、不写类型名", () => {
  const names = Object.values(TYPE_TABLE).map((type) => type.name);
  expect(new Set(names).size).toBe(16);
  for (const name of names) expect(names.filter((other) => other !== name && (other.includes(name) || name.includes(other)))).toEqual([]);
  for (const type of Object.values(TYPE_TABLE)) expect(type.quote.length).toBeGreaterThan(3);
  for (const axis of TYPE_AXES) for (const side of [axis.left, axis.right]) expect(side.en.replace(/[^A-Z]/g, "")[0]).toBe(side.letter);
  expect(typeSummaryProblem("你习惯把几条线接在一起，代价是收尾常被打断，")).toBeNull();
  expect(typeSummaryProblem("习惯把几条线接在一起")).toContain("「你」");
  expect(typeSummaryProblem("你是军师")).toContain("军师");
  expect(typeSummaryProblem("你像 ENTP 一样")).toContain("外部人格类型");
});
