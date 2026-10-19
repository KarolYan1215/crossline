import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { approveCategory, createAgentRunner, TOOLS_AGENT_SKILL, toolLoopReason } from "./agent-task";
import { createAgentToolbox, inside } from "./agent-tools";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
let root: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  root = mkdtempSync(path.join(tmpdir(), "crossline-tools-"));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const box = (extra: Partial<Parameters<typeof createAgentToolbox>[0]> = {}) => {
  const source = path.join(root, "in");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "syllabus.txt"), "Homework 1 due Oct 28.\nMidterm Nov 18.");
  return createAgentToolbox({ store, workspaceId, directory: path.join(root, "task"), inputs: [source], ...extra });
};

test("it writes only inside its task directory, only text formats, and never into an input", async () => {
  const tools = box();
  expect(JSON.parse(await tools.call("write_file", { path: "notes/summary.md", content: "# 摘要" }))).toMatchObject({ written: "notes/summary.md" });
  expect(readFileSync(path.join(root, "task", "notes", "summary.md"), "utf8")).toBe("# 摘要");
  await expect(tools.call("write_file", { path: "../escape.md", content: "x" })).rejects.toThrow(/任务目录/);
  await expect(tools.call("write_file", { path: "/etc/x.md", content: "x" })).rejects.toThrow(/任务目录/);
  await expect(tools.call("write_file", { path: "input/0/syllabus.txt", content: "x" })).rejects.toThrow(/任务目录/);
  await expect(tools.call("write_file", { path: "run.sh", content: "rm -rf /" })).rejects.toThrow(/文字文件/);
  expect(readFileSync(path.join(root, "in", "syllabus.txt"), "utf8")).toContain("Homework 1");
  expect(inside("/a/b", "c/../../d")).toBeUndefined();
});

test("it reads inputs, organises them by copying, and deletes only what it made", async () => {
  const tools = box();
  const listed = JSON.parse(await tools.call("list_files", {}));
  expect(listed.inputs).toEqual([{ path: "input/0", name: "in", kind: "folder" }]);
  expect(JSON.parse(await tools.call("read_file", { path: "input/0/syllabus.txt" })).text).toContain("Midterm Nov 18");
  await tools.call("copy_file", { from: "input/0/syllabus.txt", to: "课程/ECE 555 大纲.txt" });
  expect(existsSync(path.join(root, "task", "课程", "ECE 555 大纲.txt"))).toBe(true);
  await tools.call("move_file", { from: "课程/ECE 555 大纲.txt", to: "课程/大纲.txt" });
  await expect(tools.call("delete_file", { path: "input/0/syllabus.txt" })).rejects.toThrow(/自己写出/);
  await tools.call("delete_file", { path: "课程/大纲.txt" });
  expect(existsSync(path.join(root, "task", "课程", "大纲.txt"))).toBe(false);
  expect(tools.calls.map((call) => `${call.tool}:${call.ok}`)).toContain("delete_file:false");
});

test("the person's files and board are read; inbox lines are capped and only queued until the run finishes", async () => {
  store.saveSourceDocument({ id: "doc-1", ownerId: "user-1", workspaceId, kind: "text", fileName: "lab-plan.txt", mediaType: "text/plain", sha256: "h", uri: "file:///nowhere",
    extractedText: "Workshop paper due Dec 5.", extractionStatus: "done", createdAt: "2026-10-19T00:00:00.000Z" });
  const tools = box();
  expect(JSON.parse(await tools.call("list_documents", { query: "workshop" })).documents[0]).toMatchObject({ id: "doc-1", name: "lab-plan.txt" });
  expect(JSON.parse(await tools.call("read_document", { id: "doc-1" })).text).toBe("Workshop paper due Dec 5.");
  for (let i = 0; i < 5; i += 1) await tools.call("add_to_inbox", { text: `待办 ${i}` });
  await expect(tools.call("add_to_inbox", { text: "第六件" })).rejects.toThrow(/最多/);
  expect(store.listCaptures(workspaceId)).toHaveLength(0);
  expect(tools.actions).toHaveLength(5);
  expect(tools.specs.some((spec) => spec.name === "mail_search")).toBe(false);
});

test("mail functions exist only with a mailbox, and read through it", async () => {
  const tools = box({ mail: { search: async () => [{ id: "m1", from: "prof@uni.edu", subject: "HW1 extended", date: "2026-10-18", snippet: "due Oct 30" }],
    read: async (id) => id === "m1" ? { id, from: "prof@uni.edu", to: "me", subject: "HW1 extended", date: "2026-10-18", text: "HW1 is now due Oct 30." } : undefined } });
  expect(JSON.parse(await tools.call("mail_search", { text: "HW1" })).messages[0].subject).toBe("HW1 extended");
  expect(JSON.parse(await tools.call("mail_read", { id: "m1" })).text).toContain("Oct 30");
});

test("a tools-mode run declares Crossline's functions (no shell), records every call, and carries out its inbox lines after it finishes", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const summary = JSON.stringify({ summary: "读了大纲，整理出日期表。", artifacts: [{ path: "dates.md", purpose: "日期表" }],
    verification: [{ check: "读回日期表", result: "pass", evidence: "读回 dates.md，两条日期与大纲一致" }], needsHuman: [], notDone: [], assumptions: [] });
  const { rpc, threadStarts } = fakeRuntime([summary], TOOLS_AGENT_SKILL, { script: async ({ ask }) => {
    await ask("item/tool/call", { callId: "c1", tool: "write_file", arguments: { path: "dates.md", content: "- 10/28 HW1\n- 11/18 Midterm" } });
    await ask("item/tool/call", { callId: "c2", tool: "add_to_inbox", arguments: { text: "10/28 前交 ECE 555 HW1" } });
  } });
  const run = createAgentRunner(store, workspaceId, "/repo", () => rpc, { outputRoot: path.join(root, "ai"), mode: "tools" });
  const outcome = await run({ taskId: "t-tools", title: "整理大纲日期", what: "读大纲，列出日期", category: "read_research_organize", humanPart: "按日期做作业" });
  expect(outcome).toMatchObject({ state: "done", captured: ["10/28 前交 ECE 555 HW1"], reviewRequired: false });
  const started = threadStarts()[0]!;
  expect(started.sandbox).not.toBe("danger-full-access");
  expect((started.dynamicTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(expect.arrayContaining(["write_file", "read_document", "add_to_inbox"]));
  expect(store.listCaptures(workspaceId).map((capture) => capture.title)).toEqual(["10/28 前交 ECE 555 HW1"]);
  const completed = store.listEvents(workspaceId, { type: "agent.task.completed", entityId: "t-tools" })[0]!.payload as Record<string, unknown>;
  expect(completed).toMatchObject({ mode: "tools", commands: 2, captured: 1 });
  const audit = JSON.parse(readFileSync(path.join(root, "ai", "t-tools", "audit.json"), "utf8"));
  expect(audit.toolCalls.map((call: { tool: string }) => call.tool)).toEqual(["write_file", "add_to_inbox"]);
});

test("a run that fails leaves its inbox lines unapplied", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const { rpc } = fakeRuntime(["not json", "still not json", "nope"], TOOLS_AGENT_SKILL, { script: async ({ ask }) => {
    await ask("item/tool/call", { callId: "c1", tool: "add_to_inbox", arguments: { text: "不该出现" } });
  } });
  const run = createAgentRunner(store, workspaceId, "/repo", () => rpc, { outputRoot: path.join(root, "ai"), mode: "tools" });
  const outcome = await run({ taskId: "t-fail", title: "x", what: "x", category: "read_research_organize", humanPart: "x" });
  expect(outcome.state).toBe("blocked");
  expect(store.listCaptures(workspaceId)).toHaveLength(0);
});

test("going round in circles is caught from the calls themselves", () => {
  const call = (ok: boolean) => ({ tool: "web_fetch", subject: "https://a.example", ok });
  expect(toolLoopReason([call(true), call(true)])).toBeUndefined();
  expect(toolLoopReason([call(false), call(false), call(false)])).toMatch(/连续失败 3 次/);
  expect(toolLoopReason(Array.from({ length: 6 }, () => call(true)))).toMatch(/重复了 6 次/);
});

test("reading one long file page by page is not a loop, and copying large files leaves room to write the index", async () => {
  const tools = box();
  const long = path.join(root, "in", "long.txt");
  writeFileSync(long, "x".repeat(130_000));
  for (let offset = 0; offset < 130_000; offset += 20_000) await tools.call("read_file", { path: "input/0/long.txt", offset });
  expect(toolLoopReason(tools.calls)).toBeUndefined();
  writeFileSync(path.join(root, "in", "big.txt"), "y".repeat(19_000_000));
  await tools.call("copy_file", { from: "input/0/big.txt", to: "归档/big.txt" });
  await tools.call("copy_file", { from: "input/0/big.txt", to: "归档/big-2.txt" });
  expect(JSON.parse(await tools.call("write_file", { path: "README.md", content: "# 索引" }))).toMatchObject({ written: "README.md" });
});
