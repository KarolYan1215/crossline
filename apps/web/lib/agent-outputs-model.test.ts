import { describe, expect, test } from "vitest";
import { filterOutputs, outputsHref, parseOutputFilter, type AgentOutputs } from "./agent-outputs-model";

const file = (name: string, bytes = 10) => ({ path: name, name, bytes, href: `/f/${name}` });
const view: AgentOutputs = {
  lines: [{ id: "research", label: "科研" }, { id: "media", label: "自媒体" }, { id: "startup", label: "创业" }, { id: "other", label: "其他" }],
  reports: [{ id: "flow-a-1", workflowId: "flow-a", title: "话题总览", at: "2026-11-09T10:00:00Z", files: 3, lineId: "media" }],
  runs: [
    { taskId: "t1", title: "整理文献", at: "2026-11-08T10:00:00Z", status: "accepted", partial: false, lineId: "research", files: 2, href: "/workbench/w1" },
    { taskId: "t2", title: "剪辑脚本", at: "2026-11-07T10:00:00Z", status: "needs_review", partial: true, lineId: "media", files: 0, href: "/approvals#assistant" }
  ],
  folder: { files: 3, bytes: 30, elsewhere: 0, lines: [
    { id: "research", label: "科研", tasks: [{ taskId: "t1", title: "整理文献", at: "2026-11-08T10:00:00Z", status: "accepted", partial: false, files: [file("a.md"), file("b.csv")] }] },
    { id: "other", label: "其他", tasks: [{ taskId: "auto-1", title: "每周汇总", at: "2026-11-06T10:00:00Z", status: "accepted", partial: false, files: [file("c.md")] }] }
  ] }
};

describe("Agent 产出's filter", () => {
  test("reads only known sources and a non-empty line from the address", () => {
    expect(parseOutputFilter({ source: "workflow", line: "media" })).toEqual({ source: "workflow", line: "media" });
    expect(parseOutputFilter({ source: "evil", line: "" })).toEqual({});
    expect(parseOutputFilter({ source: ["task", "file"] })).toEqual({});
  });

  test("links keep the other half of the filter and drop a cleared one", () => {
    expect(outputsHref({ source: "task", line: "media" }, { source: undefined })).toBe("/outputs?line=media");
    expect(outputsHref({ line: "media" }, { source: "file" })).toBe("/outputs?source=file&line=media");
    expect(outputsHref({ source: "task" }, { source: undefined })).toBe("/outputs");
  });

  test("with no filter every source shows, and the line chips are only the lines that have something", () => {
    const shown = filterOutputs(view, {});
    expect([shown.reports.length, shown.runs.length, shown.files.length]).toEqual([1, 2, 2]);
    expect(shown.counts).toEqual({ workflow: 1, task: 2, file: 3 });
    expect(shown.lines.map((line) => line.id)).toEqual(["research", "media", "other"]);
  });

  test("a source shows only its part, while the counts still say what the others hold", () => {
    const shown = filterOutputs(view, { source: "task" });
    expect([shown.reports.length, shown.runs.length, shown.files.length]).toEqual([0, 2, 0]);
    expect(shown.counts).toEqual({ workflow: 1, task: 2, file: 3 });
  });

  test("a line narrows every source and its counts", () => {
    const shown = filterOutputs(view, { line: "media" });
    expect(shown.reports.map((item) => item.id)).toEqual(["flow-a-1"]);
    expect(shown.runs.map((item) => item.taskId)).toEqual(["t2"]);
    expect(shown.files).toEqual([]);
    expect(shown.counts).toEqual({ workflow: 1, task: 1, file: 0 });
    expect(filterOutputs(view, { line: "other", source: "file" }).counts.file).toBe(1);
  });
});
