import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { CODEX_MEMORY_IMPORT_MARKER, importCodexMemories, parseRawMemories } from "./codex-memory-import";

const RAW = `# Raw Memories

Merged stage-1 raw memories (stable ascending thread-id order):

## Thread \`thread-a\`
updated_at: 2026-10-06T02:12:18+00:00
cwd: C:\\work

description: 写小红书提纲
 task_outcome: partial
 keywords: 小红书, 提纲, media

### Task 1: 写提纲

task_outcome: partial

Preference signals:
- 本人说“先制造冲突，再卖方案” -> 同类内容开头先抛冲突。
- 接收层要求返回完整 JSON -> 只改被点名字段。

Reusable knowledge:
- 小红书标题不超过 20 字。

Failures and how to do differently:
- 第一版写成研究报告被退回；改为冲突—解释—方案三段。

References:
- 无

## Thread \`thread-b\`
updated_at: 2026-10-07T02:12:18+00:00

### Task 1: 别人的线程

Failures and how to do differently:
- 这条属于另一个账号。

## Thread \`thread-unknown\`

Failures and how to do differently:
- 没有账号跑过这个线程。
`;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("raw memories are cut per thread into failures, preference signals and keywords", () => {
  const parsed = parseRawMemories(RAW);
  expect(parsed.map((item) => item.threadId)).toEqual(["thread-a", "thread-b", "thread-unknown"]);
  expect(parsed[0]).toMatchObject({ keywords: "小红书, 提纲, media", failures: ["第一版写成研究报告被退回；改为冲突—解释—方案三段。"] });
  expect(parsed[0]!.preferences).toHaveLength(2);
});

test("each thread's lessons go to the account that ran it, nobody's are skipped, and the files are moved aside once", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-memory-"));
  dirs.push(root);
  const home = path.join(root, "codex-home");
  mkdirSync(path.join(home, "memories", "rollout_summaries"), { recursive: true });
  writeFileSync(path.join(home, "memories", "raw_memories.md"), RAW);
  writeFileSync(path.join(home, "memories_1.sqlite"), "db");
  const dataDir = path.join(root, "data");
  const store = new CrosslineStore(":memory:");
  const first = store.createPrincipalWithWorkspace("user-a", "A").workspace.id;
  const second = store.createPrincipalWithWorkspace("user-b", "B").workspace.id;
  const usage = { tier: "mid", model: "m", effort: "low", spendMode: "normal", ok: true, errorCode: "", repairs: 0, turns: 1, inputTokens: 0, cachedInputTokens: 0,
    outputTokens: 0, reasoningTokens: 0, totalTokens: 0, durationMs: 0, at: "2026-10-06T00:00:00.000Z", skill: "crossline:crossline-agent" };
  store.saveModelUsage({ ...usage, workspaceId: first, threadId: "thread-a" });
  store.saveModelUsage({ ...usage, workspaceId: second, threadId: "thread-b" });

  const now = new Date("2026-10-21T08:00:00.000Z");
  const result = importCodexMemories(store, { homes: [{ label: "owner", dir: home }], dataDir, now })!;
  expect(result).toMatchObject({ homes: 1, threads: 3, placed: 2, skipped: 1, left: [] });
  // The contract-noise bullet (「JSON」) is dropped; the rest become this account's lessons.
  expect(store.listLessons(first).map((lesson) => [lesson.kind, lesson.source, lesson.text])).toEqual([
    ["failure", "codex-memory", "第一版写成研究报告被退回；改为冲突—解释—方案三段。"],
    ["preference", "codex-memory", "本人说“先制造冲突，再卖方案” -> 同类内容开头先抛冲突。"]]);
  expect(store.listLessons(first)[0]!.keywords).toBe("小红书, 提纲, media");
  expect(store.listLessons(second).map((lesson) => lesson.text)).toEqual(["这条属于另一个账号。"]);
  expect(store.listLessons(first).some((lesson) => lesson.text.includes("没有账号"))).toBe(false);

  const backup = path.join(dataDir, "backups", "codex-memories-2026-10-21", "owner");
  expect(readFileSync(path.join(backup, "memories", "raw_memories.md"), "utf8")).toBe(RAW);
  expect(existsSync(path.join(backup, "memories_1.sqlite"))).toBe(true);
  expect(existsSync(path.join(home, "memories"))).toBe(false);
  expect(existsSync(path.join(home, "memories_1.sqlite"))).toBe(false);
  expect(store.getSetting(first, CODEX_MEMORY_IMPORT_MARKER)).toBeTruthy();
  expect(store.listEvents(first, { type: "lessons.imported_from_codex_memory" })).toHaveLength(1);
  // Once only.
  expect(importCodexMemories(store, { homes: [{ label: "owner", dir: home }], dataDir, now })).toBeUndefined();
  store.close();
});
