import { expect, test } from "vitest";
import { checklistOf } from "./assistant-visual";
import { markdownToBlocks } from "./doc-blocks";
import { Namer, cleanText, firstSentence, gapRows, humanTable, humanizeBlocks, humanizeMarkdown, namesFrom, statusOf } from "./humanize";
import { tablePreview } from "./preview";

// The shape of a real run's output (an ECE 555 homework's material catalogue, 2026-10-15), with the course files renamed.
const SCHEDULE = "83910f0d4a10ffa39d9a6bd75c22bc39a99047550a1eb1921f659c5a8bc45aa4";
const SYLLABUS = "5c649647021a0d9fb81be6b7e873c291742b56953ad8e442b013e1c2bb4a4289";
const INVENTORY = [
  "\uFEFFsource_id,relative_path,file_name,candidate_category,extension,bytes,modified_utc,sha256,duplicate_group,access_status,error",
  `S01,${SCHEDULE}.pdf,${SCHEDULE}.pdf,其他,.pdf,124993,2026-10-03T00:00:40.816443+00:00,${SCHEDULE},,可访问,`,
  `S02,${SYLLABUS}.pdf,${SYLLABUS}.pdf,其他,.pdf,295947,2026-10-03T00:00:40.820964+00:00,${SYLLABUS},,可访问,`
].join("\n");
const GAPS = [
  "id,category,title,date,deadline,lectures,evidence,matched_files,status,gap,priority,next_action,research_link",
  `HW3-DATES,作业,作业 3 发布与截止日期,2026-10-12,2026-11-02,窗口,S01 第1页课程日程：10/12 Homework Out #3,S01:${SCHEDULE}.pdf,可访问,无日期缺口；题面内容另项核验,P0,以 11-02 为截止,无`,
  "HW3-PROMPT,作业,作业 3 题面,2026-10-12,2026-11-02,范围未确认,S02 未收录题面,,缺项,两份显式输入中没有作业 3 题目正文、页数或版本信息,P0,由本人取得题面,无",
  `HW3-GRADING,评分说明,作业 3 评分说明,2026-10-12,2026-11-02,不适用,S02 第3页,S02:${SYLLABUS}.pdf,待核验,课程级权重可访问，但作业 3 专属分值未确认,P0,核验评分,无`
].join("\n");
const DOCS = [{ sha256: SCHEDULE, fileName: "Course Schedule.pdf" }, { sha256: SYLLABUS, fileName: "Syllabus.pdf" }, { sha256: "f".repeat(64), fileName: "Unrelated.pdf" }];

test("the files a run read get their own names back, by hash and by the code the run gave them", () => {
  const names = namesFrom([INVENTORY, GAPS], DOCS);
  expect(names).toEqual({ [SCHEDULE]: "Course Schedule", [SYLLABUS]: "Syllabus", S01: "Course Schedule", S02: "Syllabus" });
});

test("text loses local paths, hashes, byte counts, extensions and internal codes; an unknown file is 「来源 n」", () => {
  const namer = new Namer(namesFrom([INVENTORY], DOCS));
  expect(cleanText(`S02 第3页；S01:${SCHEDULE}.pdf · P0 · 124,993 B · \`C:\\Users\\someone\\Crossline\\data\\sources\\${SYLLABUS}.pdf\``, namer))
    .toBe("Syllabus 第3页；Course Schedule · Syllabus");
  expect(cleanText(`SHA-256 \`${SCHEDULE}\` 与 ${"a".repeat(64)}.pdf、${"b".repeat(40)}.docx、${"a".repeat(64)}.pdf`, namer))
    .toBe("SHA-256 Course Schedule 与 来源 1、来源 2、来源 1");
  expect(cleanText("见 /Users/someone/notes/plan.md 与 material-gaps.csv", namer)).toBe("见 plan 与 material-gaps");
  expect(cleanText("S07 第 2 页")).toBe("来源 7 第 2 页");
});

test("nothing technical survives anything drawn from a run's ledger and gap list", () => {
  const namer = new Namer(namesFrom([INVENTORY, GAPS], DOCS));
  const drawn = [INVENTORY, GAPS].map((csv) => { const table = tablePreview(csv); return [humanTable(table.header, table.rows, namer), gapRows(table.header, table.rows, namer)]; });
  expect(JSON.stringify(drawn)).not.toMatch(/[0-9a-f]{16,}|[A-Z]:\\|\.pdf\b|\bS0\d\b|\bP0\b|124993|source_id|candidate_category|HW3-/);
});

test("a ledger that only lists files and whether they open is one sentence", () => {
  const namer = new Namer(namesFrom([INVENTORY], DOCS));
  const table = tablePreview(INVENTORY);
  expect(humanTable(table.header, table.rows, namer)).toEqual({ kind: "summary", text: "两份文件均可读取：Course Schedule、Syllabus。" });
  expect(humanTable(["file", "status"], [["a.pdf", "可访问"], ["b.pdf", "缺"], ["c.pdf", "待核验"]])).toEqual({ kind: "summary", text: "三份文件：a、b、c；可读取 1 份，待核验 1 份，缺 1 份。" });
  expect(humanTable(["sha256", "bytes"], [[SCHEDULE, "12"]])).toEqual({ kind: "summary", text: "1 行记录均为文件校验信息，不在此列出。" });
});

test("a table keeps at most four readable columns, with Chinese headers, the file named first", () => {
  const namer = new Namer(namesFrom([GAPS], DOCS));
  const table = tablePreview(GAPS);
  const human = humanTable(table.header, table.rows, namer);
  expect(human.kind).toBe("table");
  if (human.kind !== "table") return;
  expect(human.header).toEqual(["文件", "类别", "名称", "日期"]);
  expect(human.rows[0]).toEqual(["Course Schedule", "作业", "作业 3 发布与截止日期", "2026-10-12"]);
  expect(human.rows[1]![0]).toBe("");
  // A column a header names for a person is kept even when it is only numbers.
  expect(humanTable(["讲次", "页码", "id"], [["L1", "3", "X-1"], ["L2", "7", "X-2"]])).toEqual({ kind: "table", header: ["讲次", "页码"], rows: [["L1", "3"], ["L2", "7"]], total: 2 });
});

test("a list of gaps is a short title, a status and one sentence per row, never the run of raw fields", () => {
  const namer = new Namer(namesFrom([GAPS], DOCS));
  const table = tablePreview(GAPS);
  expect(gapRows(table.header, table.rows, namer)).toEqual([
    { label: "作业 3 发布与截止日期", status: "可访问", note: "无日期缺口" },
    { label: "作业 3 题面", status: "缺", note: "两份显式输入中没有作业 3 题目正文、页数或版本信息" },
    { label: "作业 3 评分说明", status: "待核验", note: "课程级权重可访问，但作业 3 专属分值未确认" }
  ]);
  const rows = checklistOf(markdownToBlocks(`| id | title | status | gap | priority |\n|---|---|---|---|---|\n| A-1 | 题面 | 缺项 | 没有题目 | P0 |`));
  expect(rows).toEqual([{ label: "题面", status: "缺", note: "没有题目", done: false }]);
  expect([statusOf("已有"), statusOf("缺项"), statusOf("待核验"), statusOf("部分")]).toEqual(["可访问", "缺", "待核验", "待核验"]);
  expect(firstSentence("第一句。第二句。")).toBe("第一句。");
});

test("a document's blocks and a Markdown text are cleaned the same way, tables included", () => {
  const namer = new Namer(namesFrom([INVENTORY], DOCS));
  const markdown = `## 来源登记\n\n| 来源编号 | 原始路径 | 类型 | 大小 | SHA-256 | 状态 |\n|---|---|---|---|---|---|\n| S01 | \`C:\\x\\${SCHEDULE}.pdf\` | 课程日程（1 页） | 124,993 B | \`${SCHEDULE}\` | 可访问 |\n\n- 依据 S01 第 1 页`;
  const blocks = humanizeBlocks(markdownToBlocks(markdown), namer);
  expect(blocks).toMatchObject([
    { t: "h", spans: [{ text: "来源登记" }] },
    { t: "table", header: true, rows: [[[{ text: "文件" }], [{ text: "类型" }], [{ text: "状态" }]], [[{ text: "Course Schedule" }], [{ text: "课程日程（1 页）" }], [{ text: "可访问" }]]] },
    { t: "list", items: [{ spans: [{ text: "依据 Course Schedule 第 1 页" }] }] }
  ]);
  expect(humanizeMarkdown(markdown, namer)).toBe("## 来源登记\n\n| 文件 | 类型 | 状态 |\n|---|---|---|\n| Course Schedule | 课程日程（1 页） | 可访问 |\n\n- 依据 Course Schedule 第 1 页");
});
