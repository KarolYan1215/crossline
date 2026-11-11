import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AUTOMATIONS_SETTING, GROWN_LIBRARY_SETTING } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadAgentOutputs } from "./agent-outputs";
import { filterOutputs } from "./agent-outputs-model";
import { TEST_CTX } from "./test-support";

const dirs: string[] = [];
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ws = TEST_CTX.workspaceId, owner = TEST_CTX.principalId;

function run(store: CrosslineStore, taskId: string, files: Record<string, string>, extra: { reviewRequired?: boolean; title?: string } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), `ao-${taskId}-`));
  dirs.push(directory);
  for (const [name, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); writeFileSync(path.join(directory, name), body); }
  writeFileSync(path.join(directory, "audit.json"), "{}");
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `req-${taskId}`, type: "agent.task.requested", entityId: taskId,
    payload: { taskId, title: extra.title ?? taskId, category: "read_research_organize", workOrderId: "" } });
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `done-${taskId}`, type: "agent.task.completed", entityId: taskId,
    payload: { taskId, directory, reviewRequired: extra.reviewRequired ?? false,
      artifacts: Object.entries(files).map(([name, body]) => ({ path: name, sha256: "x", bytes: Buffer.byteLength(body) })) } });
}

test("Agent 产出 gathers a workflow's report, the assistant's own runs and every handed-over file, each on its line", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(ws, GROWN_LIBRARY_SETTING, JSON.stringify([{ id: "flow-xhs", kind: "grown", name: "xhs-topics", lines: ["research"],
    origin: { kind: "repeated", taskIds: [] }, manifest: { summary: "按话题整理收藏" } }]));
  store.setSetting(ws, AUTOMATIONS_SETTING, JSON.stringify([{ id: "auto-digest", lineId: "research", name: "每日清单" }]));
  run(store, "flow-xhs-1", { "话题总览.md": "# 总览" });
  run(store, "auto-digest-k1", { "清单.md": "# 今天", "scripts/make.py": "print(1)" }, { title: "自动化「每日清单」" });
  run(store, "agent-loose", { "整理.md": "要点" }, { reviewRequired: true, title: "整理资料" });
  run(store, "grow-x", { "SKILL.md": "x" });

  const view = loadAgentOutputs(TEST_CTX);
  expect(view.reports.map((report) => [report.id, report.lineId])).toEqual([["flow-xhs-1", "research"]]);
  // A workflow's own run is its report and a workflow being grown is no result: neither is listed as an agent task.
  expect(view.runs.map((item) => [item.taskId, item.lineId, item.status, item.files, item.href ?? ""]).sort()).toEqual([
    ["agent-loose", "other", "needs_review", 1, "/approvals#assistant"],
    ["auto-digest-k1", "research", "accepted", 1, ""]
  ]);
  const research = filterOutputs(view, { line: "research" });
  expect(research.counts).toEqual({ workflow: 1, task: 1, file: 2 });
  expect(filterOutputs(view, { source: "file" }).files.map((line) => line.id)).toEqual(["research", "other"]);
});
