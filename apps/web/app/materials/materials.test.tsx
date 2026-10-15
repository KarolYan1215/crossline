import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { htmlToBlocks, markdownToBlocks, textToBlocks } from "./doc-blocks";
import { DocBlocksView } from "./doc-view";
import { buildPreview, htmlPageText, tablePreview } from "./preview";
import { buildTutorial, dropRepeats, matchSteps, stepAnchor, tutorialAnchor, type Book } from "./tutorial-model";
import { checklistOf, flowOf, ledgerOf, previewBlocks, treeOf, visualFor } from "./assistant-visual";
import { fileDigest } from "./material-digest";
import { contentDisposition } from "./file-response";
import { isTooling, materialKind, withQuery } from "./kinds";
import { Markdown } from "../ui/markdown";

test("a Word file's HTML (mammoth) keeps its headings, lists and tables, and nothing in it becomes markup", () => {
  const blocks = htmlToBlocks("<p><strong>ECE 548 期中 1 材料目录</strong></p><p><em>初版</em>｜范围：L1&ndash;L14 &amp; HW-1</p>"
    + "<h2>讲次</h2><ul><li>L1<ul><li>Quantum</li></ul></li><li>L2</li></ul>"
    + "<table><tr><td><p><strong>讲次</strong></p></td><td><p><strong>主题</strong></p></td></tr><tr><td><p>L1</p></td><td><p>Doping</p><p>二段</p></td></tr></table>"
    + "<p><a href=\"javascript:alert(1)\">坏链接</a> 8<sup>th</sup> &lt;script&gt;</p>");
  expect(blocks.map((block) => block.t)).toEqual(["h", "p", "h", "list", "table", "p"]);
  expect(blocks[0]).toMatchObject({ t: "h", level: 3, spans: [{ text: "ECE 548 期中 1 材料目录" }] });
  expect(blocks[3]).toMatchObject({ t: "list", items: [{ depth: 0 }, { depth: 1 }, { depth: 0 }] });
  expect(blocks[4]).toMatchObject({ t: "table", header: true });
  const html = renderToStaticMarkup(<DocBlocksView blocks={blocks} />);
  expect(html).toContain("<th scope=\"col\">");
  expect(html).toMatch(/Doping.*<br\/>.*二段/);
  expect(html).not.toContain("javascript:");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("<sup>th</sup>");
});

test("extracted text gets its structure back: numbered and capitalised headings, aligned columns, a Word table read as rows", () => {
  const blocks = textToBlocks([
    "1. Course Name and Number", "ECE 555: Digital Circuits", "",
    "9 INSTRUCTORS AND TEACHING ASSISTANTS", "Prof. Someone", "",
    "Date                 Topic                            Out      Due",
    " 9/4             Introduction to VLSI       #1        #2",
    " 9/7                 Labor Day                           #1",
    "", "Grading:", "", "- Homework (~20%)", "- Project (~15%)", "",
    "讲次 | 主题 | 状态", "L1 | Doping | 已有"
  ].join("\n"));
  expect(blocks.map((block) => block.t)).toEqual(["h", "p", "h", "p", "layout", "h", "list", "table"]);
});

test("Markdown the assistant writes is read with nested and checkbox lists and pipe tables", () => {
  const blocks = markdownToBlocks("# 缺口\n- [x] 讲义 L1\n- [ ] 作业 HW1\n  - 题面\n\n| 文件 | 状态 |\n|---|---|\n| L1 | 已有 |");
  expect(blocks).toMatchObject([{ t: "h", level: 1 }, { t: "list", items: [{ checked: true }, { checked: false }, { depth: 1 }] }, { t: "table", header: true }]);
});

test("the shared Markdown draws tables, quotes and footnote marks, still never HTML", () => {
  const html = renderToStaticMarkup(<Markdown text={"| a | b |\n|---|---|\n| 1 | <b>2</b> |\n\n> 引用\n\n见来源[^2]"} cite={(n, key) => <sup key={key}>{n}</sup>} />);
  expect(html).toContain("<table class=\"md-table\"><thead><tr><th scope=\"col\">a</th>");
  expect(html).toContain("&lt;b&gt;2&lt;/b&gt;");
  expect(html).toContain("<blockquote>引用</blockquote>");
  expect(html).toContain("见来源<sup>2</sup>");
  expect(renderToStaticMarkup(<Markdown text="见来源[^2]" />)).toContain("[^2]");
});

test("previews: Markdown as text, a CSV as cells, a page as its text, a Word file without bytes from its extracted text", async () => {
  expect(await buildPreview({ fileName: "a.md", bytes: new TextEncoder().encode("# 标题") })).toEqual({ kind: "markdown", text: "# 标题", truncated: false });
  expect(tablePreview("﻿a,b\n1,\"x, y\"\n")).toEqual({ kind: "table", header: ["a", "b"], rows: [["1", "x, y"]], totalRows: 1 });
  expect(htmlPageText("<html><script>bad()</script><p>One &amp; two</p><div>three</div></html>")).toBe("One & two\nthree");
  expect(await buildPreview({ fileName: "x.docx", extractedText: "Grading:\n\nHomework" })).toMatchObject({ kind: "doc", from: "text" });
  expect(await buildPreview({ fileName: "x.pdf" })).toMatchObject({ kind: "pdf" });
  expect(await buildPreview({ fileName: "x.pptx" })).toMatchObject({ kind: "none" });
});

test("file names: kinds, scaffolding left out, a header-safe disposition", () => {
  expect(materialKind("Plan.DOCX")).toBe("docx");
  expect(isTooling("scripts/build.py")).toBe(true);
  expect(isTooling("course_files/讲次计划.docx")).toBe(false);
  expect(isTooling("README.md")).toBe(true);
  expect(withQuery("/api/agent/tasks/a/file?path=x.md", "view", "preview")).toBe("/api/agent/tasks/a/file?path=x.md&view=preview");
  const header = contentDisposition("attachment", "期中\"目录\".docx");
  expect(header).toBe(`attachment; filename="______.docx"; filename*=UTF-8''${encodeURIComponent("期中_目录_.docx")}`);
  expect(() => new Headers({ "content-disposition": header })).not.toThrow();
});

const book = (): Book => ({
  flow: { nodes: [
    { id: "check", title: "核对推导、计算与提交格式", kind: "verify", goal: "发现并修正问题", stage: 1, order: 1 },
    { id: "read", title: "通读题目并拆分解题要求", kind: "read", goal: "形成要求清单", stage: 0, order: 0 }
  ] },
  manual: "# 完成作业 3\n\n主线按 6 个步骤推进。\n\n## 假设\n- 题量为 5 题\n\n## 流程\n1. …",
  nodes: {
    read: { task: "# 通读\n\n**目标**：形成要求清单\n\n## 步骤\n1. 读\n\n## 怎样算做到\n5 题都有要求清单", analysis: "# 分析：通读\n\n需要补充：作业3题目页、提交格式要求。课程表列作业3截止。[upload-1]\n\n## 参考来源\n- **s1** https://example.org", tutorial: "# 教程：通读\n\n1. 在 Canvas 下载题目。[upload-1]\n\n2. 建立核对表。[s1]", sources: [{ id: "s1", url: "https://example.org/a", title: "Guide", publisher: "Org", kept: "summary_only" }] },
    check: { task: "# 核对\n\n## 怎样算做到\n全部核对", analysis: "建立核对表。", tutorial: "# 教程：核对\n\n逐题复算每个关键数值与单位。[upload-1][s1]\n\n逐题复算每个关键数值与单位。[upload-1]", sources: [{ id: "s1", url: "https://example.org/b", title: "Other", publisher: "Org", kept: "full_text", uri: "file:///x.pdf" }] }
  },
  materials: [{ index: 0, id: "upload-1", title: "Course Schedule.pdf", publisher: "本人上传", kept: "full_text", docId: "doc-1", notes: 2, nodes: ["read", "check"] }],
  steps: [{ id: "v1s1", title: "通读题目并拆分解题要求" }, { id: "v1s2", title: "核对推导、计算与提交格式" }]
});

test("the tutorial follows the task's steps, numbers each source once, and drops what it already said", () => {
  const tutorial = buildTutorial("w1", book());
  expect(tutorial.sections.map((section) => [section.number, section.stepId, section.title])).toEqual([[1, "v1s1", "通读题目并拆分解题要求"], [2, "v1s2", "核对推导、计算与提交格式"]]);
  expect(tutorial.overview).toBe("主线按 6 个步骤推进。");
  expect(tutorial.assumptions).toEqual(["题量为 5 题"]);
  const [read, check] = tutorial.sections;
  expect(read!.acceptance).toBe("5 题都有要求清单");
  expect(read!.missing).toEqual(["作业3题目页", "提交格式要求"]);
  expect(read!.guide).toBe("1. 在 Canvas 下载题目。[^1]\n\n2. 建立核对表。[^2]");
  // The analysis keeps what the guide does not say, and its own list of addresses gives way to the footnotes.
  expect(read!.analysis).toBe("课程表列作业3截止。[^1]");
  // The repeated paragraph is said once; the person's file keeps its number across sections.
  expect(check!.guide).toBe("逐题复算每个关键数值与单位。[^1][^3]");
  expect(check!.analysis).toBe("建立核对表。");
  expect(tutorial.footnotes.map((note) => [note.n, note.title, note.usedIn, note.href])).toEqual([
    [1, "Course Schedule.pdf", [1, 2], "/api/source-documents/doc-1/file"],
    [2, "Guide", [1], "https://example.org/a"],
    [3, "Other", [2], "/api/work-orders/w1/materials?uri=file%3A%2F%2F%2Fx.pdf"]
  ]);
  expect(read!.materials).toEqual([0]);
  expect(tutorialAnchor("v1s1")).toBe("tutorial-v1s1");
  expect(stepAnchor("v1s1")).toBe("step-v1s1");
});

test("a section's step is the recorded one, else the one of the same title; never a guess by position", () => {
  const steps = [{ id: "a", title: "读题" }, { id: "b", title: "作答" }];
  expect([...matchSteps([{ id: "n1", title: "作答 ", kind: "do", goal: "", stage: 0 }, { id: "n2", title: "别的", kind: "do", goal: "", stage: 1, stepId: "a" }], steps)]).toEqual([["n1", "b"], ["n2", "a"]]);
  expect(matchSteps([{ id: "n3", title: "完全不同", kind: "do", goal: "", stage: 0 }], steps).size).toBe(0);
  expect(dropRepeats("甲乙丙丁戊己庚辛壬癸子丑。\n\n甲乙丙丁戊己庚辛壬癸子丑。[s1]\n\n新的一段内容内容内容。")).toBe("甲乙丙丁戊己庚辛壬癸子丑。\n\n新的一段内容内容内容。");
});

test("the assistant's files are drawn by use: a catalogue as a tree, a ledger as a table, gaps as a checklist, a procedure as steps", () => {
  expect(visualFor("材料目录", "目录", "")).toBe("tree");
  expect(visualFor("文件台账", "台账", "")).toBe("ledger");
  expect(visualFor("缺口清单", "缺口", "")).toBe("checklist");
  expect(visualFor("成品", "复习流程", "")).toBe("flow");
  expect(visualFor("成品", "公式表", "")).toBe("document");
  const catalogue = markdownToBlocks("# ECE 548 期中 1 材料目录\n## 第 1 周\n- L1 量子\n  - 讲义\n## 第 2 周\n| 讲次 | 主题 |\n|---|---|\n| L3 | PN 结 |");
  expect(treeOf(catalogue)).toEqual([
    { label: "第 1 周", children: [{ label: "L1 量子", children: [{ label: "讲义", children: [] }] }] },
    { label: "第 2 周", children: [{ label: "L3", note: "PN 结", children: [] }] }
  ]);
  expect(ledgerOf(previewBlocks({ kind: "table", header: ["文件", "状态"], rows: [["L1", "已有"]], totalRows: 1 }))).toEqual({ header: ["文件", "状态"], rows: [["L1", "已有"]] });
  expect(checklistOf(markdownToBlocks("| 项 | 状态 | 说明 |\n|---|---|---|\n| 讲义 | 已有 | 共 14 份 |\n| 样题 | 缺 | |\n\n- [x] 题面"))).toEqual([
    { label: "讲义", status: "可访问", note: "共 14 份", done: true }, { label: "样题", status: "缺", done: false }, { label: "题面", done: true }]);
  expect(flowOf(markdownToBlocks("# 流程\n1. 下载\n2. 核对\n   - 细节\n3. 提交"))).toEqual(["下载", "核对", "提交"]);
});

test("the note beside a person's file names what it holds and the steps it serves, each note once", () => {
  const digest = fileDigest({ fileName: "Lecture Plan.docx", extractedText: "Grading:\n\nHomework (~20%)\n\nL3: P-N Junction-1",
    notes: [{ node: "a", step: "复习 PN 结", note: "L3–L8 为 PN 结。" }, { node: "b", step: "做题", note: "L3–L8 为 PN 结。" }],
    steps: [{ id: "s1", title: "复习 PN 结" }, { id: "s2", title: "做题" }, { id: "s3", title: "看讲义", covers: ["u1"] }],
    units: [{ id: "u1", title: "PN 结", quote: "L3: P-N Junction-1" }] });
  expect(digest.kindLabel).toBe("Word 文档");
  expect(digest.sections).toEqual(["Grading"]);
  expect(digest.steps).toEqual([{ stepId: "s1", title: "复习 PN 结", notes: ["L3–L8 为 PN 结。"] }, { stepId: "s2", title: "做题", notes: [] }, { stepId: "s3", title: "看讲义", notes: [] }]);
});
