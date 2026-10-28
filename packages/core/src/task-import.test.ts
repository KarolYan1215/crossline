import { describe, expect, test } from "vitest";
import {
  importCaptureId, importDay, importDuplicateOf, importOrigin, itemsFromCsv, itemsFromText, itemsFromTickTick, looksLikeImportList, parseCsv, ruleSuggestion,
  validateImportTriage
} from "./task-import";
import type { MergeTask } from "./task-merge";

describe("reading other tools' lists", () => {
  test("a day is taken as written, a date-time read in the person's zone", () => {
    expect(importDay("2026-11-03")).toBe("2026-11-03");
    // TickTick stores an all-day task at local midnight in UTC: in Shanghai that is the next day.
    expect(importDay("2026-11-05T16:00:00+0000", "Asia/Shanghai")).toBe("2026-11-06");
    expect(importDay("2026-11-05T16:00:00Z", "America/Chicago")).toBe("2026-11-05");
    expect(importDay("")).toBe("");
    expect(importDay("next week")).toBe("");
  });

  test("a pasted list: bullets, numbers and boxes taken off, a ticked box is done, headings name the list, repeats dropped", () => {
    const items = itemsFromText("本周：\n- [ ] 交作业 4 2026-11-03\n- [x] 回邮件\n- 买牙膏\n- 买牙膏\n\n## 以后\n1. 学日语\n☑ 交房租");
    expect(items.map((item) => [item.title, item.done, item.list, item.due])).toEqual([["交作业 4 2026-11-03", false, "本周", "2026-11-03"],
      ["回邮件", true, "本周", ""], ["买牙膏", false, "本周", ""], ["学日语", false, "以后", ""], ["交房租", true, "以后", ""]]);
    // The same line pasted again has the same id, so it is never imported twice.
    expect(itemsFromText("- 买牙膏\n")[0]!.externalId).toBe(itemsFromText("* 买牙膏")[0]!.externalId);
  });

  test("CSV: quoted fields with commas and new lines; Todoist's export keeps only task rows; unknown layouts take the first column", () => {
    expect(parseCsv("a,\"b, c\",\"d\"\"e\"\n\"multi\nline\",2,3\n")).toEqual([["a", "b, c", "d\"e"], ["multi\nline", "2", "3"]]);
    const todoist = itemsFromCsv("TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE\n"
      + "section,Week 1,,,,,,,,\ntask,Submit HW4,PDF to Canvas,4,1,me,,2026-11-03,en,UTC\nnote,just a note,,,,,,,,\n");
    expect(todoist.map((item) => [item.title, item.notes, item.due])).toEqual([["Submit HW4", "PDF to Canvas", "2026-11-03"]]);
    expect(itemsFromCsv("买菜\n交房租\n").map((item) => item.title)).toEqual(["买菜", "交房租"]);
  });

  test("TickTick's API: done and abandoned tasks say so; the list name is kept", () => {
    const items = itemsFromTickTick([{ name: "Inbox", tasks: [{ id: "t1", title: "Buy milk", status: 0, dueDate: "2026-11-01T03:00:00+0000", tags: ["home"] },
      { id: "t2", title: "Old idea", status: -1 }, { id: "t3", title: "" }] }], "UTC");
    expect(items.map((item) => [item.externalId, item.done, item.due, item.list, item.labels.join()])).toEqual([["t1", false, "2026-11-01", "Inbox", "home"], ["t2", true, "", "Inbox", ""]]);
  });

  test("ids: a capture id is safe and points back to its service", () => {
    expect(importCaptureId({ kind: "notion", externalId: "1a2b-3c/4d" })).toBe("import-notion-1a2b-3c4d");
    expect(importOrigin("import-todoist-6X7r")).toEqual({ kind: "todoist", externalId: "6X7r" });
    expect(importOrigin("cap-mail-1")).toBeUndefined();
  });

  test("a pasted text looks like a list when most of six or more lines are short or marked", () => {
    expect(looksLikeImportList("- a\n- b\n- c\n- d\n- e\n- f")).toBe(true);
    expect(looksLikeImportList("今天下午三点和导师开会，讨论论文第二章的实验设计，然后把结果整理成一页纸发给合作者确认。")).toBe(false);
  });
});

describe("duplicates and suggestions", () => {
  const task = (id: string, title: string, identityId = "research"): MergeTask => ({ id, identityId, projectId: "ece555", milestoneId: "m1", title, intent: title,
    state: "approved", dueDate: "", milestoneDeadline: "", progress: 0, hasStepPlan: false, started: false, dependsOn: [] });
  test("an imported item matches an open task by the merge rules, in its line or, with none chosen, in any", () => {
    const open = [task("notes", "整理 ECE 555 课堂笔记"), task("hw3", "完成 ECE 555 作业 3")];
    expect(importDuplicateOf({ title: "汇集 ECE 555 课堂笔记", notes: "", lineId: "research", due: "" }, open)?.id).toBe("notes");
    expect(importDuplicateOf({ title: "整理 ECE 555 课堂笔记", notes: "", lineId: "media", due: "" }, open)).toBeUndefined();
    expect(importDuplicateOf({ title: "完成 ECE 555 作业 4", notes: "", lineId: "", due: "" }, open)).toBeUndefined();
    expect(ruleSuggestion({ kind: "text", externalId: "x", title: "整理 ECE 555 课堂笔记", notes: "", due: "", labels: [], list: "", done: false, createdAt: "" }, "", open))
      .toMatchObject({ decision: "merge", duplicateOf: "notes", lineId: "research" });
  });

  test("the triage answer covers every item once, with known lines, a merge naming an open task and days as YYYY-MM-DD", () => {
    const ok = { items: [{ key: "i1", decision: "keep", lineId: "research", project: "", due: "2026-11-03", duplicateOf: "", why: "" },
      { key: "i2", decision: "merge", lineId: "", project: "", due: "", duplicateOf: "notes", why: "相同" }] };
    expect(validateImportTriage(ok, ["i1", "i2"], ["research"], ["notes"]).items).toHaveLength(2);
    const bad = { items: [{ key: "i1", decision: "merge", lineId: "cooking", project: "", due: "11/3", duplicateOf: "x", why: "" }] };
    expect(() => validateImportTriage(bad, ["i1", "i2"], ["research"], ["notes"])).toThrow("IMPORT_TRIAGE_INVALID");
    try { validateImportTriage(bad, ["i1", "i2"], ["research"], ["notes"]); } catch (error) {
      const detail = (error as { detail: string }).detail;
      for (const part of ["cooking", "openTasks", "YYYY-MM-DD", "i2"]) expect(detail).toContain(part);
    }
  });
});
