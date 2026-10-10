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
  expect(html).toContain("调整定语 →");
  expect(html).toContain("href=\"/onboarding?line=research\"");
  expect(html).not.toContain("目标已变");
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
  expect(renderToStaticMarkup(<LinesBar palette={{}} lines={[line({ goalParts: [], goals: [] })]} />)).toContain("2 个定语候选待选 →");
  expect(renderToStaticMarkup(<LinesBar palette={{}} lines={[line({ goalParts: [], goals: [], attributes: [] })]} />)).toContain("设定长期目标 →");
});
