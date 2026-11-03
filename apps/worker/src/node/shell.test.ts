import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore, nodeShellHost } from "@crossline/db";
import { decideCommand } from "@crossline/core";
import { NODE_COMPUTE_SETTING, NODE_STATUS_SETTING } from "@crossline/core/device";
import { inTaskDir, refusal } from "./protocol";
import { handleTaskOp, type TaskFileOp } from "./task-files";
import { changedInputs, pullResults, sendInputs, type NodeShellLink } from "./task-sync";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "crossline-shell-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const TASKS = path.join(path.parse(process.cwd()).root, "node", "tasks");
const shellThread = (over: Record<string, unknown> = {}) => ({ sandbox: "danger-full-access", approvalPolicy: "untrusted", cwd: path.join(TASKS, "agent-1"),
  config: { "features.shell_tool": true }, ...over });

test("a shell thread is let through only when the person switched the shell on, in a task directory, with every command checked", () => {
  expect(refusal("thread/start", shellThread())).toMatch(/NODE_SHELL_REFUSED: shell/);
  const on = { tasksRoot: TASKS };
  expect(refusal("thread/start", shellThread(), on)).toBeUndefined();
  expect(refusal("thread/start", shellThread({ approvalsReviewer: "user" }), on)).toBeUndefined();
  expect(refusal("thread/start", shellThread({ approvalPolicy: "never" }), on)).toMatch(/approval/);
  expect(refusal("thread/start", shellThread({ approvalsReviewer: "auto_review" }), on)).toMatch(/approval/);
  expect(refusal("thread/start", shellThread({ cwd: path.join(TASKS, "..") }), on)).toMatch(/cwd/);
  expect(refusal("thread/start", shellThread({ cwd: path.join(TASKS, "agent-1", "sub") }), on)).toMatch(/cwd/);
  expect(refusal("thread/start", shellThread({ cwd: path.join(TASKS, "agent-1", "..", "..", "x") }), on)).toMatch(/cwd/);
  expect(refusal("thread/start", shellThread({ config: { sandbox_mode: "danger-full-access" } }), on)).toMatch(/config/);
  expect(refusal("thread/start", shellThread({ sandbox: "workspace-write" }), on)).toMatch(/sandbox/);
  // A thread started read-only cannot be widened by its turns.
  expect(refusal("turn/start", { threadId: "t", input: [] }, on)).toBeUndefined();
  expect(refusal("turn/start", { threadId: "t", sandboxPolicy: { type: "dangerFullAccess" } }, on)).toMatch(/NODE_TURN_REFUSED/);
  expect(refusal("turn/start", { threadId: "t", cwd: "/" }, on)).toMatch(/NODE_TURN_REFUSED/);
  expect(refusal("turn/start", { threadId: "t", environments: [{ id: "x" }] }, on)).toMatch(/environments/);
  expect(refusal("turn/start", { threadId: "t", environments: [] }, on)).toBeUndefined();
  expect(refusal("command/exec", {}, on)).toMatch(/NODE_METHOD_REFUSED/);
});

test("a task directory is one plain name directly under the task root", () => {
  expect(inTaskDir(path.join(TASKS, "agent-1"), TASKS)).toBe(true);
  expect(inTaskDir(TASKS, TASKS)).toBe(false);
  expect(inTaskDir(path.join(TASKS, ".hidden"), TASKS)).toBe(false);
  expect(inTaskDir(undefined, TASKS)).toBe(false);
  expect(inTaskDir(path.join(TASKS, "a"), "")).toBe(false);
});

test("task files never leave their directory and never follow a link", () => {
  const root = path.join(dir, "tasks");
  handleTaskOp(root, { op: "write", name: "t1", rel: "a/b.txt", data: Buffer.from("hello").toString("base64") });
  handleTaskOp(root, { op: "write", name: "t1", rel: "a/b.txt", data: Buffer.from(" world").toString("base64"), append: true });
  expect(readFileSync(path.join(root, "t1", "a", "b.txt"), "utf8")).toBe("hello world");
  const listed = handleTaskOp(root, { op: "list", name: "t1" }) as { files: Array<{ rel: string; size: number }> };
  expect(listed.files).toEqual([expect.objectContaining({ rel: "a/b.txt", size: 11 })]);
  expect(Buffer.from((handleTaskOp(root, { op: "read", name: "t1", rel: "a/b.txt" }) as { data: string }).data, "base64").toString()).toBe("hello world");
  for (const bad of [{ op: "write", name: "..", rel: "x", data: "" }, { op: "write", name: "t1", rel: "../x", data: "" }, { op: "write", name: "t1", rel: "a\\..\\x", data: "" },
    { op: "read", name: "t1", rel: "/etc/passwd" }, { op: "list", name: "a/b" }] as TaskFileOp[]) {
    expect(() => handleTaskOp(root, bad)).toThrow(/NODE_TASK_/);
  }
  // A run that leaves a link to a secret in its own directory: the server never reads through it.
  writeFileSync(path.join(dir, "token.bin"), "SECRET");
  let linked = true;
  try { symlinkSync(path.join(dir, "token.bin"), path.join(root, "t1", "token.bin"), "file"); } catch { linked = false; }
  if (linked) {
    expect(() => handleTaskOp(root, { op: "read", name: "t1", rel: "token.bin" })).toThrow(/NODE_TASK_LINK_REFUSED/);
    expect((handleTaskOp(root, { op: "list", name: "t1" }) as { files: Array<{ rel: string }> }).files.map((file) => file.rel)).toEqual(["a/b.txt"]);
  }
});

/** A link to a node whose task directories are a temp folder of this machine. */
function fakeLink(root: string): NodeShellLink {
  return { key: "k", host: "PC-A", client: {} as NodeShellLink["client"], tasksRoot: root, home: dir, windows: process.platform === "win32",
    task: async (request) => handleTaskOp(root, request), connected: () => true };
}

test("inputs go to the node as copies, results come back, and a changed copy is reported against its original", async () => {
  const link = fakeLink(path.join(dir, "node-tasks"));
  const original = path.join(dir, "syllabus.txt");
  writeFileSync(original, "原文");
  mkdirSync(path.join(dir, "folder", "sub"), { recursive: true });
  writeFileSync(path.join(dir, "folder", "sub", "notes.md"), "笔记");
  const sent = await sendInputs(link, "t1", [original, path.join(dir, "folder")]);
  expect(sent.truncated).toBe(false);
  expect(sent.paths).toEqual([path.join(link.tasksRoot, "t1.inputs", "0", "syllabus.txt"), path.join(link.tasksRoot, "t1.inputs", "1", "folder")]);
  expect(readFileSync(path.join(link.tasksRoot, "t1.inputs", "1", "folder", "sub", "notes.md"), "utf8")).toBe("笔记");
  expect(await changedInputs(link, "t1", sent)).toEqual([]);

  // The run writes its results and changes one input copy.
  writeFileSync(path.join(link.tasksRoot, "t1", "out.md"), "结果");
  writeFileSync(path.join(link.tasksRoot, "t1", "audit.json"), "{\"forged\":true}");
  writeFileSync(path.join(link.tasksRoot, "t1.inputs", "0", "syllabus.txt"), "被改过");
  expect(await changedInputs(link, "t1", sent)).toEqual([original]);
  expect(readFileSync(original, "utf8")).toBe("原文");

  const server = path.join(dir, "server-task");
  mkdirSync(server);
  writeFileSync(path.join(server, "audit.json"), "{\"server\":true}");
  expect(await pullResults(link, "t1", server)).toEqual({ copied: 1, left: [] });
  expect(readFileSync(path.join(server, "out.md"), "utf8")).toBe("结果");
  expect(readFileSync(path.join(server, "audit.json"), "utf8")).toBe("{\"server\":true}");
  // Unchanged files are not sent again.
  expect(await pullResults(link, "t1", server)).toEqual({ copied: 0, left: [] });
});

test("the assistant is a shell only for an account with a ready node whose person allowed it, while compute is on", () => {
  const store = new CrosslineStore(":memory:");
  try {
    const ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
    const status = (nodes: object[]) => store.setSetting(ws, NODE_STATUS_SETTING, JSON.stringify({ nodes }));
    status([{ state: "ready", shell: true, host: "PC-A" }]);
    expect(nodeShellHost(store, ws)).toBeUndefined();
    store.setSetting(ws, NODE_COMPUTE_SETTING, "on");
    expect(nodeShellHost(store, ws)).toBe("PC-A");
    status([{ state: "ready", host: "PC-A" }, { state: "connecting", shell: true, host: "PC-B" }]);
    expect(nodeShellHost(store, ws)).toBeUndefined();
  } finally { store.close(); }
});

test("the guard refuses the node's own token, Codex home and browser profiles to a run on that node", () => {
  const context = { taskDir: "C:\\Users\\p\\AppData\\Local\\Crossline Node\\tasks\\agent-1", homeDir: "C:\\Users\\p" };
  for (const command of ["Get-Content \"C:\\Users\\p\\AppData\\Local\\Crossline Node\\token.bin\"", "type \"C:\\Users\\p\\AppData\\Local\\Crossline Node\\codex-home\\auth.json\"",
    "dir \"C:\\Users\\p\\AppData\\Local\\Crossline Node\\browser-profiles\"", "cat C:\\data\\device\\node\\browser-profiles\\x", "type C:\\data\\secrets\\mail-1.bin"]) {
    expect(decideCommand(command, context).decision, command).toBe("deny");
  }
});
