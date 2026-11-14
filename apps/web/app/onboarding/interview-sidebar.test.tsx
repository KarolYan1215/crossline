import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { buildDivergenceGraph, evidenceEdgeKind, fitsEntries, fitsFirst } from "./divergence-graph";
import { DivergenceView } from "./divergence-view";
import { finishView, FinishButton, shouldRemindFull } from "./finish-button";
import { falsifierCondition, InsightCard } from "./insight-card";
import type { Hypothesis, ResearchThread } from "./interview-contract";
import { ResearchPanel } from "./research-panel";
import { ValuesRadar } from "../portrait/portrait-charts";
import { CareerSection, HypothesesSection } from "../portrait/career-sections";

/** The interview refactor's screen (2026-11-12, decisions 7, 13, 18, 21–25 and 27). */
const hypothesis = (over: Partial<Hypothesis>): Hypothesis => ({ id: "h1", dimension: "D4", statement: "看重自主胜过稳定", falsifier: "如果他换到稳定的岗位后更满意，这条就不准",
  alternative: "只是对眼下的导师不满", status: "open", basis: [{ kind: "quote", text: "我不想被安排", ref: "reply-3" }], ...over });

test("the map places the ten dimensions, each hypothesis in its dimension's sector, and colours evidence by the hypothesis's verdict", () => {
  const graph = buildDivergenceGraph({
    dimensions: [{ id: "D4", summary: "自主", evidenced: true }],
    hypotheses: [
      hypothesis({ id: "h1", status: "supported", basis: [{ kind: "quote", text: "a", ref: "reply-1" }, { kind: "external", text: "b", ref: "https://example.org/b" }] }),
      hypothesis({ id: "h2", status: "refuted", dimension: "D1" }),
      hypothesis({ id: "h3", status: "undecided", dimension: "D1", rated: "fits" }),
      // A dimension outside D0–D9 is not drawn.
      hypothesis({ id: "h4", dimension: "D12" as Hypothesis["dimension"] })
    ]
  });
  const dimensions = graph.nodes.filter((node) => node.kind === "dimension");
  expect(dimensions.map((node) => node.id)).toEqual(["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"]);
  expect(dimensions.find((node) => node.id === "D4")).toMatchObject({ evidenced: true, summary: "自主", hypotheses: 1 });
  expect(graph.nodes.filter((node) => node.kind === "hypothesis").map((node) => node.id)).toEqual(["h2", "h3", "h1"]);
  expect(graph.nodes.some((node) => node.id === "h4")).toBe(false);
  expect(graph.nodes.find((node) => node.id === "h3")).toMatchObject({ fits: true });
  const kinds = Object.fromEntries(graph.edges.map((edge) => [edge.id, edge.kind]));
  expect(kinds["D4>h1"]).toBe("member");
  expect(kinds["h1:e0>h1"]).toBe("supports");
  expect(kinds["h1:e1>h1"]).toBe("supports");
  expect(kinds["h2:e0>h2"]).toBe("refutes");
  expect(kinds["h3:e0>h3"]).toBe("pending");
  expect(evidenceEdgeKind("open")).toBe("pending");
  // Everything stays inside the drawing.
  for (const node of graph.nodes) { expect(node.x).toBeGreaterThan(0); expect(node.x).toBeLessThan(graph.size); expect(node.y).toBeGreaterThan(0); expect(node.y).toBeLessThan(graph.size); }
  // An empty profile still draws the ten dimensions, so their pictures can be opened.
  expect(buildDivergenceGraph(null).nodes).toHaveLength(10);
});

test("what the person rated 准 comes first: rated hypotheses, then rated observations no hypothesis already says", () => {
  const hypotheses = [hypothesis({ id: "h1" }), hypothesis({ id: "h2", statement: "怕失去选择", rated: "fits" })];
  const entries = fitsEntries(hypotheses, [{ seq: 4, text: "怕失去选择" }, { seq: 6, text: "做事先搭框架" }, { seq: 8, text: "不准的这条" }, { seq: "8.1", text: "同一轮的第二张" }],
    { "4": "fits", "6": "fits", "8": "off", "8.1": "fits" });
  expect(entries.map((entry) => entry.text)).toEqual(["怕失去选择", "做事先搭框架", "同一轮的第二张"]);
  expect(entries[0]).toMatchObject({ source: "hypothesis", hypothesisId: "h2" });
  expect(fitsFirst(hypotheses).map((item) => item.id)).toEqual(["h2", "h1"]);
});

test("the map shows the rated list, and a hypothesis opens with its quotes, falsifier, other reading and reference link", () => {
  const html = renderToStaticMarkup(<DivergenceView hypotheses={[hypothesis({ rated: "fits", reference: { text: "同类人群数据", url: "https://example.org/r" } })]}
    dimensions={[]} insights={[]} ratings={{}} initial="D4" detail={(dimension) => <p>detail-{dimension}</p>} />);
  expect(html).toContain("本人标为准");
  expect(html).toContain("detail-D4");
  expect(html).toContain("D4 价值与三观");
  expect(html).toContain('data-fits="true"');
});

test("the falsifier line says its condition once, whatever the model already wrote around it", () => {
  expect(falsifierCondition("如果他换到稳定岗位后更满意，这条就不准。")).toBe("他换到稳定岗位后更满意");
  expect(falsifierCondition("如果他换到稳定岗位后更满意")).toBe("他换到稳定岗位后更满意");
  expect(falsifierCondition("他换到稳定岗位后更满意")).toBe("他换到稳定岗位后更满意");
  expect(falsifierCondition("假如半年后仍在原组，那么这条推断就不成立")).toBe("半年后仍在原组");
  expect(falsifierCondition("If he stays put for a year, this would be wrong.")).toBe("he stays put for a year");
  expect(falsifierCondition("")).toBe("");
  expect(falsifierCondition(undefined)).toBe("");
  const html = renderToStaticMarkup(<InsightCard sessionId="s" seq={3} rating={undefined} onRated={() => {}}
    insight={{ text: "看重自主", refs: [{ replyId: "reply-1", quote: "不想被安排" }], falsifier: "如果他更喜欢稳定，这条就不准", external: [{ text: "研究生职业选择调查", url: "https://example.org/s" }] }} />);
  expect(html).toContain("如果他更喜欢稳定，这条就不准");
  expect(html.match(/如果/g)).toHaveLength(1);
  expect(html).toContain('href="https://example.org/s"');
  // A round stored before has neither: no empty line, no empty list.
  const old = renderToStaticMarkup(<InsightCard sessionId="s" seq={3} rating={undefined} onRated={() => {}} insight={{ text: "看重自主", refs: [] }} />);
  expect(old).not.toContain("这条就不准");
  expect(old).not.toContain("ob-insight-external");
});

test("the finish button waits for the lower bound, saying what is missing, draws the completeness, and reminds once when full", () => {
  expect(finishView(undefined)).toEqual({ disabled: true, percent: 0, missing: [] });
  expect(finishView({ lowerBound: false, score: 0.234, full: false, missing: ["固定日程"] })).toEqual({ disabled: true, percent: 23, missing: ["固定日程"] });
  expect(finishView({ lowerBound: true, score: 1.4, full: true, missing: ["D6"] })).toEqual({ disabled: false, percent: 100, missing: [] });
  expect(finishView({ lowerBound: true, score: Number.NaN, full: false, missing: [] }).percent).toBe(0);
  expect(shouldRemindFull(true, false)).toBe(true);
  expect(shouldRemindFull(true, true)).toBe(false);
  expect(shouldRemindFull(false, false)).toBe(false);
  expect(shouldRemindFull(undefined, false)).toBe(false);
  const below = renderToStaticMarkup(<FinishButton sessionId="s" completeness={{ lowerBound: false, score: 0.3, full: false, missing: ["固定日程", "每周可用时间"] }} />);
  expect(below).toMatch(/<button[^>]*disabled/);
  expect(below).toContain("开始使用前还差：固定日程、每周可用时间");
  expect(below).toContain('aria-valuenow="30"');
  const above = renderToStaticMarkup(<FinishButton sessionId="s" completeness={{ lowerBound: true, score: 0.6, full: false, missing: [] }} />);
  expect(above).not.toMatch(/<button[^>]*disabled/);
  expect(above).toContain("结束并出报告");
});

test("research threads are listed with their status, and a thread that asks comes up as its own card", () => {
  const thread = (over: Partial<ResearchThread>): ResearchThread => ({ id: "r1", question: "芯片建模实习要什么", why: "", dimension: "D5", status: "running",
    messages: [], createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z", ...over });
  const html = renderToStaticMarkup(<ResearchPanel sessionId="s" onChanged={() => {}} threads={[thread({}), thread({ id: "r2", question: "读博的机会成本", status: "asking", ask: "你现在一年的收入大约多少？" }),
    thread({ id: "r3", status: "done", conclusion: "x" }), thread({ id: "r4", status: "failed" })]} />);
  expect(html).toContain("调研中");
  expect(html).toContain("等你回答");
  expect(html).toContain("已有结论");
  expect(html).toContain("失败");
  expect(html).toContain("你现在一年的收入大约多少？");
  expect(html.match(/ob-research-ask"/g)).toHaveLength(1);
  expect(renderToStaticMarkup(<ResearchPanel sessionId="s" onChanged={() => {}} threads={[]} />)).toBe("");
});

test("a value not talked about yet is not drawn at 0, and the interview's radar says it is inferred", () => {
  const html = renderToStaticMarkup(<ValuesRadar note="推断，非测量" values={[{ name: "自主", score: 80, evidence: "" }, { name: "成就", score: null, evidence: "" },
    { name: "安全", score: 40, evidence: "" }]} />);
  expect(html.match(/<circle/g)).toHaveLength(2);
  expect(html).toContain("未谈到");
  expect(html).toContain("推断，非测量");
  // Not a closed outline through a zero.
  expect(html).not.toMatch(/fill-opacity=".16"/);
  const whole = renderToStaticMarkup(<ValuesRadar values={[{ name: "自主", score: 80, evidence: "" }, { name: "成就", score: 60, evidence: "" }, { name: "安全", score: 40, evidence: "" }]} />);
  expect(whole).toMatch(/fill-opacity=".16"/);
});

test("the portrait lists career options with the requirement matrix, sources and trial, and hypotheses by dimension, rated ones first", () => {
  const careers = renderToStaticMarkup(<CareerSection number="09" lineLabel={(id) => id === "research" ? "研究者" : id} careers={[{ role: "芯片架构建模实习", why: "依据 h1", hypothesisIds: ["h1"], lineId: "research",
    requirements: [{ requirement: "C++", share: "8/10", has: "partial", evidence: "课程项目" }], sources: ["https://example.org/jd"],
    trial: { weeks: 3, task: "复现一个缓存模型", supportsIf: "做完还想做", refutesIf: "中途厌烦" } }]} />);
  expect(careers).toContain("职业方向");
  expect(careers).toContain("主线：研究者");
  expect(careers).toContain("8/10");
  expect(careers).toContain("部分");
  expect(careers).toContain('href="https://example.org/jd"');
  expect(careers).toContain("试做 · 3 周");
  expect(renderToStaticMarkup(<CareerSection number="09" lineLabel={(id) => id} careers={[]} />)).toBe("");
  const hypotheses = renderToStaticMarkup(<HypothesesSection number="10" hypotheses={[hypothesis({ id: "h1", statement: "甲" }), hypothesis({ id: "h2", statement: "乙", rated: "fits" }),
    hypothesis({ id: "h3", dimension: "D1", statement: "丙" })]} />);
  expect(hypotheses.indexOf("D1 行为签名")).toBeLessThan(hypotheses.indexOf("D4 价值与三观"));
  expect(hypotheses.indexOf("乙")).toBeLessThan(hypotheses.indexOf("甲"));
  expect(hypotheses).toContain("本人认为准");
  expect(renderToStaticMarkup(<HypothesesSection number="10" hypotheses={[]} />)).toBe("");
});
