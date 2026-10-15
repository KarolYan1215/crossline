import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import {
  AGENT_SKILL, approveCategory, changedFiles, CLEAN_RUNS_TO_TRUST, createAgentAnswerer, createAgentRunner, fingerprint, readCategories, recordReview,
  type AuditRecord
} from "./agent-task";
import { fakeRuntime as sharedRuntime, type AgentScript } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
let root: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  root = mkdtempSync(path.join(tmpdir(), "crossline-agent-"));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const summary = (over: object = {}) => JSON.stringify({
  summary: "整理了练习清单和笔记。", artifacts: [{ path: "notes.md", purpose: "笔记" }],
  verification: [{ check: "笔记里的链接", result: "pass", evidence: "逐个请求，全部 200" }], needsHuman: [], notDone: [], assumptions: [], ...over
});
const fake = (answers: string[], options: { script?: AgentScript } = {}) => sharedRuntime(answers, AGENT_SKILL, options);
const input = { title: "整理 ECE 555 的 Cadence 材料", what: "读课程文件，整理成练习清单和笔记", category: "read_research_organize" as const, humanPart: "做作业和提交" };
const runner = (rpc: ReturnType<typeof fake>["rpc"], extra: { ask?: (r: { kind: string; subject: string; rule: string; reason: string }) => Promise<boolean> } = {}) =>
  createAgentRunner(store, workspaceId, "C:\\repo", () => rpc, { outputRoot: path.join(root, "ai"), homeDir: "C:\\Users\\karol", ...extra });

test("a kind of work that has not been approved does not start, and no thread is opened for it", async () => {
  const { rpc, threadStarts } = fake([summary()]);
  expect(await runner(rpc)({ ...input, taskId: "t0" })).toMatchObject({ state: "needs_category_approval", category: "read_research_organize" });
  expect(threadStarts()).toHaveLength(0);
});

test("the assistant's thread has a shell and the task directory, and the runtime is asked to check with us before each command", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const { rpc, threadStarts } = fake([summary()], { script: async () => { writeFileSync(path.join(root, "ai", "t1", "notes.md"), "笔记"); } });
  const outcome = await runner(rpc)({ ...input, taskId: "t1" });
  expect(outcome.state).toBe("done");
  const started = threadStarts()[0]!;
  expect(started).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "untrusted", cwd: path.join(root, "ai", "t1") });
  expect(started).not.toHaveProperty("environments");
  expect((started.config as Record<string, unknown>)["features.shell_tool"]).toBe(true);
});

test("each request the runtime makes is answered by the guard, and the audit records what ran, what was refused, and what changed", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const dir = path.join(root, "ai", "t2");
  const asked: string[] = [];
  const { rpc } = fake([summary()], { script: async ({ emit, ask, threadId, turnId }) => {
    writeFileSync(path.join(dir, "notes.md"), "笔记");
    const run = async (command: string) => { const answer = await ask("item/commandExecution/requestApproval", { itemId: `c-${command.length}`, command, cwd: dir }); return answer.decision; };
    const decisions = [await run("python plot.py"), await run("Get-Content C:\\Users\\karol\\.ssh\\id_rsa"), await run("git push origin main"), await run("Send-MailMessage -To a@b.c")];
    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "commandExecution", id: "c-1", command: "python plot.py", cwd: dir, status: "completed", exitCode: 0, commandActions: [{ type: "read", path: "C:\\Users\\karol\\Downloads\\syllabus.pdf" }] } } });
    emit({ method: "item/started", params: { threadId, turnId, item: { type: "fileChange", id: "f-1", changes: [{ path: path.join(dir, "notes.md"), kind: { type: "add" } }] } } });
    const inside = await ask("item/fileChange/requestApproval", { itemId: "f-1" });
    emit({ method: "item/started", params: { threadId, turnId, item: { type: "fileChange", id: "f-2", changes: [{ path: "C:\\Users\\karol\\Documents\\thesis.docx", kind: { type: "update" } }] } } });
    const outside = await ask("item/fileChange/requestApproval", { itemId: "f-2" });
    const unknown = await ask("item/fileChange/requestApproval", { itemId: "f-never-seen" });
    asked.push(JSON.stringify({ decisions, inside: inside.decision, outside: outside.decision, unknown: unknown.decision }));
  } });
  const outcome = await runner(rpc)({ ...input, taskId: "t2" });
  expect(JSON.parse(asked[0]!)).toEqual({ decisions: ["accept", "decline", "decline", "decline"], inside: "accept", outside: "decline", unknown: "decline" });
  if (outcome.state !== "done") throw new Error(JSON.stringify(outcome));
  expect(outcome.audit.commands).toEqual([expect.objectContaining({ command: "python plot.py", exitCode: 0, reads: ["C:\\Users\\karol\\Downloads\\syllabus.pdf"] })]);
  expect(outcome.audit.decisions.map((d) => `${d.rule}:${d.outcome}`)).toEqual(["secret.path:declined", "git.remote:declined", "send.mail:declined", "write.outside:declined", "write.unverifiable:declined"]);
  expect(JSON.parse(readFileSync(path.join(dir, "audit.json"), "utf8")).audit.decisions).toHaveLength(5);
  // Seven requests reached the guard; two (the harmless command and the file change inside the task) went through.
  expect(outcome.audit.requests).toEqual({ total: 7, allowed: 2 });
});

test("the ledger keeps where it came from and what it made, never the content", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const { rpc } = fake([summary()], { script: async () => { writeFileSync(path.join(root, "ai", "t3", "notes.md"), "机密内容 SECRET-BODY"); } });
  const outcome = await runner(rpc)({ ...input, taskId: "t3" });
  if (outcome.state !== "done") throw new Error(JSON.stringify(outcome));
  expect(outcome.artifacts[0]).toMatchObject({ path: "notes.md", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: expect.any(Number) });
  const events = store.listEvents(workspaceId, { type: ["agent.task.requested", "agent.task.completed"] });
  expect(events.map((event) => event.type)).toEqual(["agent.task.requested", "agent.task.completed"]);
  expect(JSON.stringify(events)).not.toContain("SECRET-BODY");
  expect(events[1]!.payload).toMatchObject({ artifacts: [{ path: "notes.md" }], inputsModified: [], checksPassed: true, reviewRequired: false });
});

test("an artifact it claims but did not make is sent back, and the corrected answer is accepted", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const { rpc, turns } = fake([summary({ artifacts: [{ path: "ghost.md", purpose: "没有的文件" }] }), summary()], { script: async ({ turnId }) => {
    if (turnId === "turn-2") writeFileSync(path.join(root, "ai", "t4", "notes.md"), "笔记");
  } });
  const outcome = await runner(rpc)({ ...input, taskId: "t4" });
  expect(outcome.state).toBe("done");
  expect(turns()).toBe(2);
});

test("changing one of the person's original files is caught and makes the result need a look, whatever the assistant says", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const original = path.join(root, "syllabus.txt");
  writeFileSync(original, "原文");
  const { rpc } = fake([summary()], { script: async () => {
    writeFileSync(path.join(root, "ai", "t5", "notes.md"), "笔记");
    writeFileSync(original, "被改过");
  } });
  const outcome = await runner(rpc)({ ...input, taskId: "t5", inputs: [original] });
  if (outcome.state !== "done") throw new Error(JSON.stringify(outcome));
  expect(outcome.inputsModified).toEqual([original]);
  expect(outcome.checksPassed).toBe(false);
  expect(outcome.reviewRequired).toBe(true);
});

test("a kind earns trust only through accepted results, and loses it at the first rejected one", () => {
  approveCategory(store, workspaceId, "data_code_sim");
  expect(readCategories(store, workspaceId).data_code_sim).toMatchObject({ trust: "review_all", cleanRuns: 0 });
  for (let i = 1; i < CLEAN_RUNS_TO_TRUST; i += 1) expect(recordReview(store, workspaceId, "data_code_sim", true)?.trust).toBe("review_all");
  expect(recordReview(store, workspaceId, "data_code_sim", true)?.trust).toBe("auto_checked");
  expect(recordReview(store, workspaceId, "data_code_sim", false)).toMatchObject({ trust: "review_all", cleanRuns: 0 });
  expect(recordReview(store, workspaceId, "files_calendar_prep", true)).toBeUndefined();
});

test("a trusted kind is accepted on its checks alone, unless it left something for the person", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  for (let i = 0; i < CLEAN_RUNS_TO_TRUST; i += 1) recordReview(store, workspaceId, "read_research_organize", true);
  const make = (name: string) => async () => { mkdirSync(path.join(root, "ai", name), { recursive: true }); writeFileSync(path.join(root, "ai", name, "notes.md"), "笔记"); };
  const plain = await runner(fake([summary()], { script: make("t6") }).rpc)({ ...input, taskId: "t6" });
  expect(plain).toMatchObject({ state: "done", reviewRequired: false });
  const asks = await runner(fake([summary({ needsHuman: [{ what: "确认课程项目日期", why: "文件写的是待定" }] })], { script: make("t7") }).rpc)({ ...input, taskId: "t7" });
  expect(asks).toMatchObject({ state: "done", reviewRequired: true });
});

test("hashing the inputs before and after shows exactly what changed", () => {
  const a = path.join(root, "a.txt"), b = path.join(root, "b.txt");
  writeFileSync(a, "1"); writeFileSync(b, "2");
  const before = fingerprint([root]);
  writeFileSync(b, "3");
  expect(changedFiles(before, fingerprint([root]))).toEqual([b]);
});

test("a command the guard asks about goes to the person when there is a way to reach them, and is declined when there is not", async () => {
  const audit: AuditRecord = { commands: [], filesChanged: [], mcpCalls: [], searches: [], decisions: [], requests: { total: 0, allowed: 0 } };
  const context = { taskDir: "C:\\ai\\t", homeDir: "C:\\Users\\karol" };
  const asked: string[] = [];
  const yes = createAgentAnswerer(context, audit, new Map(), async (request) => { asked.push(request.rule); return true; });
  expect(await yes("item/commandExecution/requestApproval", { command: "winget install Foo.Bar" })).toEqual({ decision: "accept" });
  expect(asked).toEqual(["install.global"]);
  const nobody = createAgentAnswerer(context, audit, new Map());
  expect(await nobody("item/commandExecution/requestApproval", { command: "winget install Foo.Bar" })).toEqual({ decision: "decline" });
  // Extra permissions and unknown requests are never granted.
  expect(await nobody("item/commandExecution/requestApproval", { command: "ls", additionalPermissions: { network: true } })).toEqual({ decision: "decline" });
  await expect(nobody("item/permissions/requestApproval", {})).rejects.toThrow("not handled");
});
