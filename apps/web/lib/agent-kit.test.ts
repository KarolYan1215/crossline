import { expect, test } from "vitest";
import { redactPortrait, type EnergyRhythm, type PortraitReport } from "@crossline/core";
import { agentKitMarkdown, buildAgentKit, scrub, type AgentKitInput } from "./agent-kit";
import { tFor } from "./i18n";
import { readFileSync } from "node:fs";
import path from "node:path";

// Read at run time: the image build type-checks without e2e/ in its context.
const fixture = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../e2e/fixtures/portrait-report.json"), "utf8")) as PortraitReport;

const report = { ...fixture };
report.type = { ...report.type!, lines: 80 };

const rhythm: EnergyRhythm = { curve: [], sleep: { from: 23.5, to: 7.5 }, peak: { start: 9, end: 12 }, thresholds: { low: 0, high: 1 }, reports: [],
  chronotype: null, debt: { perNight: 0, nights: 0 }, nights: 0 };

const input = (overrides: Partial<AgentKitInput> = {}): AgentKitInput => ({
  at: "2026-11-03T10:00:00.000Z", locale: "zh",
  summary: {
    lines: [{ id: "research", label: "研究者", hard: true, description: "博士在读，做材料模拟", goal: "成为严谨的研究者",
      projects: [{ name: "ECE 555", deadline: "2026-12-12" }, { name: "论文", deadline: "" }] }],
    hours: { weekly: 39, source: "default", windows: ["周一至周五 09:00–17:00（精力中）"] },
    fixed: { count: 1, items: ["ECE 555：周二 10:00–11:15"] }
  },
  report: redactPortrait(report), rhythm,
  claims: [
    { id: "c-1abc", section: "collaboration", statement: "先给结论，再给理由", kind: "self_reported", confidence: 0.8, basis: [{ quote: "先说结论" }], confirmed: true },
    { id: "c-2def", section: "personality", statement: "尽责性偏高（72/100，4 题点选）", kind: "measured", confidence: 0.8, basis: [] },
    { id: "c-3ghi", section: "work_style", statement: "上午写作 见 C:\\Users\\karol\\notes.md 和 doc-6", kind: "inferred", confidence: 0.5, basis: [] }
  ],
  preferences: ["估时偏短，按 1.5 倍留余量；联系 karol@example.com", "引用 /home/karol/data/x.db 时用 pref-9f3a2b1c 和 MILESTONE_NO_MARGIN"],
  lineRules: [{ line: "研究者", rules: [{ kind: "redline", text: "不替本人写作业答案" }] }],
  ...overrides
});

test("the Markdown has every section, with assumptions labelled", () => {
  const t = tFor("zh");
  const markdown = agentKitMarkdown(buildAgentKit(input(), t), t);
  for (const heading of ["## 和此人协作", "## 主线与当前项目", "## 每周时间", "## 思维模式类型（趣味层）", "## 价值排序", "## 精力节律", "## 画像", "## 其他画像条目"])
    expect(markdown).toContain(heading);
  expect(markdown).toContain("不是标准化心理测验");
  expect(markdown).toContain("2026-11-03");
  expect(markdown).toContain("先给结论，再给理由（本人已确认）");
  expect(markdown).toContain("红线：不替本人写作业答案");
  expect(markdown).toContain("ECE 555，截止：2026-12-12");
  expect(markdown).toContain("论文，未记录截止");
  expect(markdown).toContain("约 39 小时/周（默认值，假设）");
  expect(markdown).toContain("最佳时段：9:00–12:00");
  expect(markdown).toContain("（假设，尚无睡眠记录）");
  expect(markdown).toContain("读博的研究者，同时搭建小型产品");
  // Spans the writer marked sensitive are blacked out, as on the shared half.
  expect(markdown).not.toContain(report.sensitive[0]!);
  // The private half never leaves.
  expect(markdown).not.toContain(report.cover.coreConflict);
  expect(markdown).not.toContain(report.problem.statement);
});

test("no address, path, token, internal id or code leaves", () => {
  const t = tFor("zh");
  const kit = buildAgentKit(input(), t);
  const all = `${agentKitMarkdown(kit, t)}\n${JSON.stringify(kit)}`;
  for (const leak of ["karol@example.com", "C:\\Users", "/home/karol", "doc-6", "pref-9f3a2b1c", "MILESTONE_NO_MARGIN", "c-1abc", "c-2def", "research"])
    expect(all).not.toContain(leak);
  expect(scrub("token sk-abcdefghijklmnop done")).toBe("token done");
  expect(kit.claims.map((claim) => claim.statement)).toContain("尽责性偏高（72/100，4 题点选）");
});

test("English accounts get English headings, and no report still gives a file", () => {
  const t = tFor("en");
  const markdown = agentKitMarkdown(buildAgentKit(input({ locale: "en", report: null }), t), t);
  expect(markdown).toContain("## Working with this person");
  expect(markdown).toContain("## Weekly hours");
  expect(markdown).not.toContain("## Portrait");
});
