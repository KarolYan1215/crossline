import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { GROWN_LIBRARY_SETTING } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { decideReportItem, listReports, loadReport, reportOfTask } from "./reports";
import { favouritesOffer } from "./skill-library";
import { TEST_CTX } from "./test-support";

const dirs: string[] = [];
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ws = TEST_CTX.workspaceId, owner = TEST_CTX.principalId;

function run(store: CrosslineStore, taskId: string, files: Record<string, string>) {
  const directory = mkdtempSync(path.join(tmpdir(), `report-${taskId}-`));
  dirs.push(directory);
  for (const [name, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); writeFileSync(path.join(directory, name), body); }
  writeFileSync(path.join(directory, "audit.json"), "{}");
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `req-${taskId}`, type: "agent.task.requested", entityId: taskId,
    payload: { taskId, title: "按话题整理小红书收藏：早餐", category: "read_research_organize", workOrderId: "" } });
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `done-${taskId}`, type: "agent.task.completed", entityId: taskId,
    payload: { taskId, directory, reviewRequired: false, artifacts: [] } });
}

const ITEMS = JSON.stringify([
  { title: "照「早餐」话题做一周备餐表", why: "三篇笔记都讲提前备餐", topic: "早餐", lineId: "research" },
  { title: "不存在的主线也能保留动作", why: "x", topic: "", lineId: "nope" },
  { title: "", why: "坏的" }
]);

test("a workflow's run with Markdown is a report: overview first, its actions validated, one capture per action whatever the clicks", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(ws, GROWN_LIBRARY_SETTING, JSON.stringify([{ id: "flow-xhs", kind: "grown", name: "xiaohongshu-favourites-topics",
    manifest: { summary: "按话题整理小红书收藏" }, lastRead: { at: "", taskId: "flow-xhs-b", directory: "", items: 42, pages: [] } }]));
  run(store, "flow-xhs-a", { "话题总览.md": "# 旧" });
  run(store, "flow-xhs-b", { "话题-早餐.md": "# 早餐\n见 [原笔记](https://www.xiaohongshu.com/explore/1)", "话题总览.md": "# 总览", "落地.json": ITEMS,
    "input/1/note-1.md": "只读输入不算", "scripts/x.py": "print(1)" });
  run(store, "agent-other", { "整理.md": "不是工作流的运行" });

  expect(listReports(TEST_CTX).map((report) => [report.id, report.notes, report.files])).toEqual([["flow-xhs-b", 42, 2]]);
  const report = loadReport(TEST_CTX, "flow-xhs-b")!;
  expect(report.title).toBe("按话题整理小红书收藏");
  expect(report.documents.map((doc) => doc.name)).toEqual(["话题总览", "话题-早餐"]);
  expect(report.versions.map((version) => version.id)).toEqual(["flow-xhs-a"]);
  expect(report.items.map((item) => [item.title, item.lineId, item.state])).toEqual([["照「早餐」话题做一周备餐表", "research", "open"], ["不存在的主线也能保留动作", "", "open"]]);
  expect(loadReport(TEST_CTX, "agent-other")).toBeUndefined();

  const [first, second] = report.items;
  expect(decideReportItem(TEST_CTX, "flow-xhs-b", first!.key, "add")).toEqual({ ok: true, captured: true });
  expect(decideReportItem(TEST_CTX, "flow-xhs-b", first!.key, "add")).toEqual({ ok: true, captured: false });
  expect(decideReportItem(TEST_CTX, "flow-xhs-b", first!.key, "dismiss")).toEqual({ ok: true, captured: false });
  const captures = store.listCaptures(ws).filter((capture) => capture.id === `report-${first!.key}`);
  expect(captures).toHaveLength(1);
  expect(captures[0]!.context).toContain("来自报告「按话题整理小红书收藏」");
  expect(reportOfTask(store, ws, `report-${first!.key}`)).toEqual({ id: "flow-xhs-b", title: "按话题整理小红书收藏" });
  expect(reportOfTask(store, ws, "some-order")).toBeUndefined();

  decideReportItem(TEST_CTX, "flow-xhs-b", second!.key, "dismiss");
  expect(loadReport(TEST_CTX, "flow-xhs-b")!.items.map((item) => item.state)).toEqual(["added", "dismissed"]);
  expect(decideReportItem(TEST_CTX, "flow-xhs-b", "000000000000", "add")).toEqual({ ok: false, code: "REPORT_ITEM_NOT_FOUND" });
});

test("Skill 库 offers the favourites topic workflow only while nothing reads the favourites, for the media-like line when there is one", () => {
  const lines = [{ id: "research", label: "研究者" }, { id: "line-x", label: "自媒体创作者" }];
  expect(favouritesOffer([], lines)).toEqual({ lineId: "line-x" });
  expect(favouritesOffer([], [{ id: "research", label: "研究者" }])).toEqual({ lineId: "" });
  expect(favouritesOffer([{ name: "xiaohongshu-favourites-topics", manifest: { summary: "" } }], lines)).toBeUndefined();
  expect(favouritesOffer([{ name: "flow-a", manifest: { summary: "定期整理小红书收藏", access: [{ site: "https://www.xiaohongshu.com" }] } }], lines)).toBeUndefined();
  expect(favouritesOffer([], [])).toBeUndefined();
});
