import { expect, test } from "vitest";
import { METHOD_RESEARCH_SCHEMA, methodGuidanceLines, screenMethodResearch, validateMethodResearch, type MethodResearch } from "./method-research";
import { structuredOutputProblems } from "./index";

const research = (): MethodResearch => ({
  habits: [{ text: "考前先把讲义过一遍再做往年卷", factIds: ["f1"] }],
  methods: [
    { kind: "考试复习", lineId: "research", approach: "先计时做往年卷，再整理错题本并每日打卡", fitsHabit: "保留先读讲义", aiTools: [{ tool: "NotebookLM", use: "把讲义生成问答自测" }], sourceIds: ["s1"] },
    { kind: "写论文", lineId: "", approach: "先列论证提纲，再按段落写草稿", fitsHabit: "", aiTools: [], sourceIds: ["s2"] }],
  sources: [{ id: "s1", url: "https://example.edu/retrieval", title: "Retrieval practice", local: false }, { id: "s2", url: "c12", title: "导师写作要求", local: true }]
});

test("the schema works in strict structured output", () => {
  expect(structuredOutputProblems(METHOD_RESEARCH_SCHEMA)).toEqual([]);
});

test("a habit rests on the person's facts; sources and lines must exist", () => {
  const ok = { factIds: ["f1"], lineIds: ["research"] };
  expect(validateMethodResearch(research(), ok).methods).toHaveLength(2);
  expect(() => validateMethodResearch({ ...research(), habits: [{ text: "习惯", factIds: ["f9"] }] }, ok)).toThrow(/UNKNOWN_FACT/);
  expect(() => validateMethodResearch({ ...research(), sources: [{ id: "s1", url: "http://x.com", title: "x", local: false }] }, ok)).toThrow(/SOURCE_INVALID/);
  expect(() => validateMethodResearch(research(), { factIds: ["f1"], lineIds: [] })).toThrow(/UNKNOWN_LINE/);
});

test("drill forms the person never named are cut from a researched method", () => {
  const screened = screenMethodResearch(research(), ["考前先把讲义过一遍再做往年卷"]);
  expect(screened.methods[0]!.approach).toBe("先计时做往年卷");
  expect(screenMethodResearch(research(), ["我一直用错题本，每日打卡"]).methods[0]!.approach).toContain("错题本");
});

test("planners get the habits first, then the research marked as research, per line", () => {
  const lines = methodGuidanceLines({ ...research(), at: "2026-11-18T00:00:00Z", droppedSources: 0 }, "media");
  expect(lines[0]).toMatch(/^做事习惯（本人原话整理）：考前先把讲义/);
  expect(lines.slice(1).map((line) => line.includes("写论文"))).toEqual([true]);
  expect(lines[1]).toContain("非本人原话");
  expect(methodGuidanceLines(undefined)).toEqual([]);
});
