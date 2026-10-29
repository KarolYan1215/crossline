import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
vi.mock("next/navigation", async (original) => ({ ...await original<typeof import("next/navigation")>(), useRouter: () => ({ refresh: () => {} }) }));
import { LinesBar, type LineCard } from "./lines-bar";

const line = (over: Partial<LineCard> = {}): LineCard => ({ id: "research", label: "研究者", color: "research", goals: ["成为神经形态计算方向能独立立项的研究者"],
  hard: true, rank: 1, milestones: 3, attributes: [{ text: "神经形态计算方向", kind: "domain" }, { text: "能独立立项", kind: "ability" }],
  goalParts: ["神经形态计算方向", "能独立立项"], description: "从器件到算法的研究", pendingEdit: null, redraftDue: false,
  interview: { reply: "", questions: [], waiting: false, turns: 0 }, ...over });

test("each card carries the line's own interview box, its description and the way to its attributes", () => {
  const html = renderToStaticMarkup(<LinesBar lines={[line()]} palette={{ research: "#0A5198" }} />);
  expect(html).toContain("aria-label=\"「研究者」的访谈\"");
  expect(html).toContain("从器件到算法的研究");
  expect(html).toContain('aria-label="调整定语"');
  expect(html).toContain("href=\"/onboarding?line=research\"");
  expect(html).not.toContain("目标已变");
});

test("the card's usual presses are icons with their words as names, and its health is an estimate said as one", () => {
  const html = renderToStaticMarkup(<LinesBar palette={{}} lines={[line({ share: 48, drafts: 1, health: { level: "risk", risky: 1, watch: 0, open: 2, reached: 1, total: 3 } })]} />);
  for (const label of ["访谈", "重算这条线未动过的草稿", "给这条线新建里程碑", "调整定语"]) expect(html).toContain(`aria-label="${label}"`);
  expect(html).toContain('data-level="risk"');
  expect(html).toContain("有风险 · 估计");
  expect(html).toContain("1/3 里程碑 · 1 待批准");
  expect(html).toContain("width:33%");
  expect(html).toContain("48% 时间");
  // No approved milestone yet: no health at all rather than a reassuring one.
  expect(renderToStaticMarkup(<LinesBar palette={{}} lines={[line({ health: null })]} />)).not.toContain("lb-health");
});

test("a pending goal change is shown composed, to adopt or dismiss; a moved goal or fact offers the redraft; the round's questions are answerable", () => {
  const html = renderToStaticMarkup(<LinesBar palette={{ research: "#0A5198" }} lines={[line({ pendingEdit: { parts: ["器件物理方向", "能独立立项"] }, redraftDue: true,
    interview: { reply: "数据到之前先写方法部分。", waiting: false, turns: 2, questions: [{ id: "q1", text: "导师何时审阅？", kind: "single",
      options: [{ id: "a", label: "本周", detail: "" }, { id: "b", label: "下周", detail: "" }] }] } })]} />);
  expect(html).toContain("成为器件物理方向的、能独立立项的研究者");
  expect(html).toContain(">采用<");
  expect(html).toContain(">不改<");
  expect(html).toContain("目标已变，重算未动过的草稿");
  expect(html).toContain("数据到之前先写方法部分。");
  expect(html).toContain("导师何时审阅？");
  expect(html).toContain(">下周<");
});

test("a line with candidates and no chosen attributes says how many wait; one with neither offers to set its goal", () => {
  expect(renderToStaticMarkup(<LinesBar palette={{}} lines={[line({ goalParts: [], goals: [] })]} />)).toContain('aria-label="2 个定语候选待选"');
  expect(renderToStaticMarkup(<LinesBar palette={{}} lines={[line({ goalParts: [], goals: [], attributes: [] })]} />)).toContain('aria-label="设定长期目标"');
});

test("every line sits in one row: a hard constraint is a tag, not a row of its own, and each attribute is its own box", () => {
  const html = renderToStaticMarkup(<LinesBar palette={{}} lines={[line(), line({ id: "media", label: "创作者", hard: false, rank: null,
    goalParts: ["有影响力", "科普", "稳定更新"], goals: ["成为有影响力的、科普的、稳定更新的创作者"] })]} />);
  expect(html.match(/class="lines-bar-row"/g)).toHaveLength(1);
  expect(html.match(/class="tag">硬约束</g)).toHaveLength(1);
  expect(html).not.toContain("<h3>平行");
  expect(html).toContain('aria-label="成为有影响力的、科普的、稳定更新的创作者"');
  expect([...html.matchAll(/class="lb-attr gen" data-i="(\d)"/g)].map((match) => match[1])).toEqual(["0", "1", "0", "1", "2"]);
});
