import { expect, test } from "vitest";
import { NARRATIVE_RATE_AFTER_MS, narrativeProblems, narrativeRatable, narrativeSectionKey, parseNarrative, rateNarrativeSection, ratingPattern, ratingRows,
  readSavedNarrative, type RatingRow, type SavedNarrative } from "./portrait-narrative";
import type { Hypothesis } from "./profile-hypotheses";

const TEXT = `\`\`\`markdown
## 人生叙事

本科转到电子工程之后，研究成了底座。

<!-- basis: p1,p2 level: 1 -->

## 卡住的时候先写新计划

每次落空之后的一周，本人都会写一份新计划。

<!-- basis: p3, h2 level: 2 -->

## 计划本身可能是在躲

写计划可能是在回避向导师交差。

<!-- basis: h5 level: 3 -->
\`\`\``;

test("a narrative is read into sections, each with the points it rests on and its level, the basis line kept out of the text shown", () => {
  const narrative = parseNarrative(TEXT);
  expect(narrative.sections.map((section) => [section.heading, section.basis, section.level])).toEqual([
    ["人生叙事", ["p1", "p2"], 1], ["卡住的时候先写新计划", ["p3", "h2"], 2], ["计划本身可能是在躲", ["h5"], 3]]);
  expect(narrative.sections[1]!.body).toBe("每次落空之后的一周，本人都会写一份新计划。");
  expect(narrative.text.startsWith("## 人生叙事")).toBe(true);
});

test("a narrative is refused with every reason: no basis, unknown ids, a long quote, a source, the evidence words, a type, the third level after a safety turn", () => {
  const ids = new Set(["p1", "p2", "p3", "h2", "h5"]);
  expect(narrativeProblems(parseNarrative(TEXT), { ids, safety: false })).toEqual([]);
  const bad = parseNarrative(`## 人生叙事\n\n本人说「我从来没有真正为自己做过一个决定，一次都没有」。见 reply-3。\n\n<!-- basis: p9 level: 1 -->\n\n## 洞察\n\n证据显示本人是 INTJ。\n`);
  const problems = narrativeProblems(bad, { ids, safety: false });
  expect(problems.some((problem) => problem.includes("p9"))).toBe(true);
  expect(problems.some((problem) => problem.includes("超过 15 个字"))).toBe(true);
  expect(problems.some((problem) => problem.includes("回复编号"))).toBe(true);
  expect(problems.some((problem) => problem.includes("缺少"))).toBe(true);
  expect(problems.some((problem) => problem.includes("证据"))).toBe(true);
  expect(problems.some((problem) => problem.includes("人格类型"))).toBe(true);
  expect(narrativeProblems(parseNarrative(TEXT), { ids, safety: true })).toEqual(["访谈里有过艰难时期的处理，这份叙事不写第三级的节。"]);
  expect(narrativeProblems(parseNarrative("没有标题"), { ids, safety: false })[0]).toContain("至少");
});

test("a third-level section is rated only three days after the narrative was written; the others at once", () => {
  const written = "2026-11-22T00:00:00.000Z";
  expect(narrativeRatable({ level: 2 }, written, new Date(written))).toBe(true);
  expect(narrativeRatable({ level: 3 }, written, new Date(Date.parse(written) + NARRATIVE_RATE_AFTER_MS - 1))).toBe(false);
  expect(narrativeRatable({ level: 3 }, written, new Date(Date.parse(written) + NARRATIVE_RATE_AFTER_MS))).toBe(true);
});

test("不准 on a section joins the rejected claims; 准 lifts it; a far section is refused before its time", () => {
  const saved: SavedNarrative = { ...parseNarrative(TEXT), version: 1, at: "2026-11-22T00:00:00.000Z", ratings: {} };
  const key = narrativeSectionKey("卡住的时候先写新计划");
  const off = rateNarrativeSection(saved, {}, { key, verdict: "off", now: new Date("2026-11-22T01:00:00.000Z") });
  expect(off.ok && off.status[`narrative:${key}`]).toMatchObject({ status: "rejected", statement: "卡住的时候先写新计划" });
  expect(off.ok && off.saved.ratings?.[key]?.verdict).toBe("off");
  const fits = off.ok ? rateNarrativeSection(off.saved, off.status, { key, verdict: "fits", now: new Date("2026-11-22T02:00:00.000Z") }) : null;
  expect(fits?.ok && fits.status).toEqual({});
  expect(rateNarrativeSection(saved, {}, { key: narrativeSectionKey("计划本身可能是在躲"), verdict: "fits", now: new Date("2026-11-23T00:00:00.000Z") }))
    .toEqual({ ok: false, code: "NARRATIVE_NOT_YET_RATABLE" });
  expect(rateNarrativeSection(saved, {}, { key: "nope", verdict: "fits", now: new Date() })).toEqual({ ok: false, code: "NARRATIVE_SECTION_UNKNOWN" });
  expect(readSavedNarrative(JSON.stringify(saved))?.sections).toHaveLength(3);
  expect(readSavedNarrative("{broken")).toBeNull();
});

test("a rating pattern needs enough cards: a dimension all 不准 beside one mostly 准, never read off three", () => {
  const row = (dimension: string, rated: RatingRow["rated"]): RatingRow => ({ statement: "s", dimension, rated, correction: "" });
  expect(ratingPattern([row("D2", "off"), row("D2", "off"), row("D2", "off"), row("D5", "fits"), row("D5", "fits")])).toBeNull();
  const pattern = ratingPattern([row("D2", "off"), row("D2", "off"), row("D2", "off"), row("D2", "partial"), row("D5", "fits"), row("D5", "fits")]);
  expect(pattern).toMatchObject({ rated: 6, guarded: ["D2"], accepted: ["D5"] });
  expect(ratingPattern([row("D2", "off"), row("D2", "off"), row("D2", "off"), row("D2", "off")])).toBeNull();
});

test("rated cards are read with the person's correction and whether it was new to them", () => {
  const hypothesis = (over: Partial<Hypothesis>): Hypothesis => ({ id: "h1", dimension: "D2", statement: "被看见时更投入", basis: [], falsifier: "", alternative: "",
    status: "open", ...over });
  const rows = ratingRows([hypothesis({ rated: "partial", pointId: "p4", novel: "new" }), hypothesis({ id: "h2" })],
    [{ id: "p4", text: "是截止让人投入，不是被看见", source: "corrected" }]);
  expect(rows).toEqual([{ statement: "被看见时更投入", dimension: "D2", rated: "partial", correction: "是截止让人投入，不是被看见", novel: "new" }]);
});
