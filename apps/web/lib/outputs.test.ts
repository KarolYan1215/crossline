import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AUTOMATIONS_SETTING } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { outputFolder, outputZip } from "./outputs";
import { TEST_CTX } from "./test-support";

const dirs: string[] = [];
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ws = TEST_CTX.workspaceId, owner = TEST_CTX.principalId;

/** A finished run with its own directory: audit.json and the files it says it made. */
function run(store: CrosslineStore, taskId: string, files: Record<string, string>, extra: { workOrderId?: string; reviewRequired?: boolean; title?: string } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), `out-${taskId}-`));
  dirs.push(directory);
  for (const [name, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); writeFileSync(path.join(directory, name), body); }
  writeFileSync(path.join(directory, "audit.json"), "{}");
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `req-${taskId}`, type: "agent.task.requested", entityId: taskId,
    payload: { taskId, title: extra.title ?? taskId, category: "read_research_organize", workOrderId: extra.workOrderId ?? "" } });
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `done-${taskId}`, type: "agent.task.completed", entityId: taskId,
    payload: { taskId, directory, reviewRequired: extra.reviewRequired ?? false,
      artifacts: Object.entries(files).map(([name, body]) => ({ path: name, sha256: "x", bytes: Buffer.byteLength(body) })) } });
}

test("the folder holds what each run handed over, by line and by task, without its helper scripts; a zip carries the same files", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(ws, AUTOMATIONS_SETTING, JSON.stringify([{ id: "auto-digest", lineId: "research", name: "每日清单" }]));
  run(store, "auto-digest-k1", { "清单.md": "# 今天", "scripts/make.py": "print(1)" }, { title: "自动化「每日清单」" });
  run(store, "agent-loose", { "notes/整理.md": "要点" }, { reviewRequired: true, title: "整理资料" });
  run(store, "grow-x", { "SKILL.md": "x" });
  const folder = outputFolder(TEST_CTX);
  const research = folder.lines.find((line) => line.id === "research")!;
  expect(research.tasks.map((task) => task.title)).toEqual(["自动化「每日清单」"]);
  expect(research.tasks[0]!.files.map((file) => file.name)).toEqual(["清单.md"]);
  expect(research.tasks[0]!.files[0]!.href).toContain("download=1");
  const other = folder.lines.find((line) => line.id === "other")!;
  expect(other.tasks[0]).toMatchObject({ title: "整理资料", status: "needs_review" });
  expect(folder.files).toBe(2);
  const zip = outputZip(TEST_CTX, {})!;
  const bytes = Buffer.from(await new Response(zip.stream).arrayBuffer());
  expect(zip.fileName).toBe("助手产出.zip");
  expect(bytes.includes(Buffer.from("自动化「每日清单」/清单.md"))).toBe(true);
  expect(bytes.includes(Buffer.from("make.py"))).toBe(false);
  expect(outputZip(TEST_CTX, { taskId: "nothing" })).toBeUndefined();
});

test("a run whose directory is not on this server is counted, not listed: its links would answer FILE_NOT_FOUND (W-143)", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  run(store, "agent-here", { "清单.md": "# 在" }, { title: "在服务器上" });
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "req-agent-gone", type: "agent.task.requested", entityId: "agent-gone",
    payload: { taskId: "agent-gone", title: "在旧电脑上", category: "read_research_organize", workOrderId: "" } });
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "done-agent-gone", type: "agent.task.completed", entityId: "agent-gone",
    payload: { taskId: "agent-gone", directory: path.join(tmpdir(), "no-such-crossline-run-dir"), reviewRequired: false,
      artifacts: [{ path: "旧.md", sha256: "x", bytes: 10 }] } });
  const folder = outputFolder(TEST_CTX);
  expect(folder.lines.flatMap((line) => line.tasks.map((task) => task.title))).toEqual(["在服务器上"]);
  expect(folder.elsewhere).toBe(1);
  expect(folder.files).toBe(1);
});
