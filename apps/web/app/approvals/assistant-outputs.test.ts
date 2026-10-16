import { expect, test } from "vitest";
import { csvHead, groupOutputs, markdownHead, workflowSteps } from "./assistant-outputs";

test("deliverables are grouped by use; scripts, caches, config and the README are left out; a Word file's Markdown source is its preview", () => {
  const grouped = groupOutputs([
    { path: "L1-L2-闭卷检索页.docx", purpose: "可直接打印的 8 题检索页" },
    { path: "L1-L2-闭卷检索页.md", purpose: "检索页的源稿" },
    { path: "material-catalog/material-catalog.md", purpose: "课程原件与公开补充材料的目录" },
    { path: "material-catalog/material-inventory.csv", purpose: "两份输入的大小与分类台账" },
    { path: "material-catalog/material-gaps.csv", purpose: "L1、L2 的材料缺口" },
    { path: "README.md", purpose: "说明全部文件及复现命令" },
    { path: "build.py", purpose: "生成脚本" },
    { path: "__pycache__/build.cpython-312.pyc", purpose: "" },
    { path: "skill/SKILL.md", purpose: "定义工作流的输入与步骤" },
    { path: "skill/workflow.json", purpose: "工作流元数据" },
    { path: "skill/scripts/example.json", purpose: "示例输入" }
  ]);
  expect(grouped.groups.map((entry) => [entry.group, entry.items.map((item) => item.name)])).toEqual([
    ["成品", ["L1-L2-闭卷检索页"]], ["材料目录", ["material-catalog"]], ["文件台账", ["material-inventory"]], ["缺口清单", ["material-gaps"]]]);
  expect(grouped.groups[0]!.items[0]).toMatchObject({ path: "L1-L2-闭卷检索页.docx", preview: "markdown", previewPath: "L1-L2-闭卷检索页.md" });
  expect(grouped.groups[2]!.items[0]).toMatchObject({ preview: "table", previewPath: "material-catalog/material-inventory.csv" });
  expect(grouped.workflow).toEqual({ manifestPath: "skill/workflow.json", purpose: "定义工作流的输入与步骤" });
  expect(grouped.hidden).toBe(4);
});

test("previews: the opening lines of a Markdown file, the first rows and columns of a CSV, a workflow's steps", () => {
  expect(markdownHead("# 标题\n\n- 一\n- 二\n", 3)).toEqual({ text: "# 标题\n\n- 一", more: true });
  expect(markdownHead("短文\n").more).toBe(false);
  const table = csvHead('﻿文件,大小,"说明, 含逗号"\r\na.pdf,12,"引号""内"\nb.pdf,3,x\n', 1, 2);
  expect(table).toEqual({ header: ["文件", "大小"], rows: [["a.pdf", "12"]], totalRows: 2, totalColumns: 3 });
  expect(workflowSteps({ name: "复习提纲", summary: "先建台账", steps: [{ title: "整理材料", by: "assistant" }, { title: "确认范围", by: "person" }, { by: "x" }] }))
    .toEqual({ name: "复习提纲", summary: "先建台账", steps: [{ title: "整理材料", by: "assistant" }, { title: "确认范围", by: "person" }] });
  expect(workflowSteps(null).steps).toEqual([]);
});

test("files the assistant named in English are grouped the same way", () => {
  const grouped = groupOutputs([
    { path: "notes.md", purpose: "Summary of lectures 1–3" },
    { path: "index.md", purpose: "Index of the course materials" },
    { path: "file-register.csv", purpose: "Register of every input file" },
    { path: "gaps.csv", purpose: "What is still missing" }
  ]);
  expect(grouped.groups.map((entry) => [entry.group, entry.items.map((item) => item.name)])).toEqual([
    ["成品", ["notes"]], ["材料目录", ["index"]], ["文件台账", ["file-register"]], ["缺口清单", ["gaps"]]]);
});
