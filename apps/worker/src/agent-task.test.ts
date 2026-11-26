import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import {
  AGENT_SKILL, approveCategory, changedFiles, CLEAN_RUNS_TO_TRUST, createAgentAnswerer, createAgentRunner, fingerprint, ownedInputs, readCategories, realPathOf, recordReview,
  type AuditRecord
} from "./agent-task";
import { fakeRuntime as sharedRuntime, type AgentScript } from "./testing/fake-runtime";
import { fakeNode } from "./testing/fake-node";

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
/** Files this workspace owns, as an upload or a folder's copy is stored. */
const own = (file: string, id = path.basename(file)) => store.saveSourceDocument({ id, ownerId: "user-1", workspaceId, kind: "text", fileName: path.basename(file),
  mediaType: "text/plain", sha256: id, uri: pathToFileURL(file).href, extractedText: "", extractionStatus: "done", createdAt: "2026-11-03T00:00:00.000Z" });
const fake = (answers: string[], options: { script?: AgentScript; windowsSandbox?: { status: string; configured?: string }; threadResponse?: Record<string, unknown> } = {}) =>
  sharedRuntime(answers, AGENT_SKILL, options);
const input = { title: "整理 ECE 555 的 Cadence 材料", what: "读课程文件，整理成练习清单和笔记", category: "read_research_organize" as const, humanPart: "做作业和提交" };
/** Off Windows unless a test says otherwise: only there is the owner's shell put in Codex's sandbox (docs/plans/harness-1125.md §9). */
const runner = (rpc: ReturnType<typeof fake>["rpc"], extra: { ask?: (r: { kind: string; subject: string; rule: string; reason: string }) => Promise<boolean>; platform?: string } = {}) =>
  createAgentRunner(store, workspaceId, "C:\\repo", () => rpc, { outputRoot: path.join(root, "ai"), homeDir: "C:\\Users\\karol", platform: "linux", ...extra });

test("a kind of work that has not been approved does not start, and no thread is opened for it", async () => {
  // The person already chose, and chose nothing (a workspace that never chose has three kinds on by default).
  store.setSetting(workspaceId, "agent.categories", "{}");
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
  expect(recordReview(store, workspaceId, "media_edit", true)).toBeUndefined();
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

test("a guard that throws or takes too long refuses the step (fail-closed)", async () => {
  const audit: AuditRecord = { commands: [], filesChanged: [], mcpCalls: [], searches: [], decisions: [], requests: { total: 0, allowed: 0 } };
  const context = { taskDir: "C:\\ai\\t", homeDir: "C:\\Users\\karol" };
  const broken = createAgentAnswerer(context, audit, new Map(), undefined, { command: () => { throw new Error("regex blew up"); } });
  expect(await broken("item/commandExecution/requestApproval", { command: "ls" })).toEqual({ decision: "decline" });
  const slow = createAgentAnswerer(context, audit, new Map(), undefined, { timeoutMs: 5, command: () => {
    const until = Date.now() + 30; while (Date.now() < until) { /* stuck */ } return { decision: "allow", rule: "default", reason: "" };
  } });
  expect(await slow("item/commandExecution/requestApproval", { command: "ls" })).toEqual({ decision: "decline" });
  expect(audit.decisions.map((d) => `${d.rule}:${d.outcome}`)).toEqual(["guard.error:declined", "guard.timeout:declined"]);
});

test("the owner's shell runs under a profile chosen from what it is handed, held by the guard alone and said in its audit", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const decisions: string[] = [];
  const script = (id: string) => async ({ ask }: Parameters<NonNullable<AgentScript>>[0]) => {
    writeFileSync(path.join(root, "ai", id, "notes.md"), "笔记");
    for (const command of ["curl https://example.com -o page.html", "pip install matplotlib"]) decisions.push(`${id}:${command.split(" ")[0]}:${(await ask("item/commandExecution/requestApproval", { command })).decision}`);
  };
  // A research run: cached search, package installs only.
  const research = fake([summary()], { script: script("t-research") });
  await runner(research.rpc)({ ...input, taskId: "t-research" });
  const config = research.threadStarts()[0]!.config as Record<string, unknown>;
  expect(config).toMatchObject({ web_search: "cached", "features.web_search": true });
  // A run handed a mail's text: no search, no network at all.
  const mail = fake([summary()], { script: script("t-mail") });
  await runner(mail.rpc)({ ...input, taskId: "t-mail", untrusted: ["mail"] });
  expect(mail.threadStarts()[0]!.config).toMatchObject({ web_search: "disabled", "features.web_search": false });
  expect(decisions).toEqual(["t-research:curl:decline", "t-research:pip:accept", "t-mail:curl:decline", "t-mail:pip:decline"]);
  const audit = JSON.parse(readFileSync(path.join(root, "ai", "t-mail", "audit.json"), "utf8"));
  expect(audit).toMatchObject({ profile: "untrusted-input", isolation: "guard-only", untrusted: ["mail"], egress: "none" });
  expect(store.listEvents(workspaceId, { type: "agent.task.requested", entityId: "t-mail" })[0]!.payload).toMatchObject({ profile: "untrusted-input", isolation: "guard-only" });
});

test("on Windows with MXC the owner's shell runs in Codex's sandbox: task directory writable, secrets denied, packages only from PyPI and npm", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const started = { activePermissionProfile: { id: "crossline-shell" }, sandbox: { type: "workspaceWrite", networkAccess: false } };
  const research = fake([summary()], { windowsSandbox: { status: "ready" }, threadResponse: { ...started, sandbox: { type: "workspaceWrite", networkAccess: true } },
    script: async () => { writeFileSync(path.join(root, "ai", "t-mxc", "notes.md"), "笔记"); } });
  const outcome = await runner(research.rpc, { platform: "win32" })({ ...input, taskId: "t-mxc" });
  expect(outcome).toMatchObject({ state: "done", sandbox: "mxc", isolation: { profile: "research", egress: "packages" } });
  const params = research.threadStarts()[0]!;
  expect(params).not.toHaveProperty("sandbox");
  const config = params.config as Record<string, unknown>;
  expect(config).toMatchObject({ default_permissions: "crossline-shell", "features.prefer_mxc": true, "features.network_proxy": true, web_search: "cached" });
  const profile = (config.permissions as Record<string, { filesystem: Record<string, string>; network: Record<string, unknown> }>)["crossline-shell"]!;
  expect(profile.network).toEqual({ enabled: true, domains: { "pypi.org": "allow", "files.pythonhosted.org": "allow", "registry.npmjs.org": "allow" } });
  expect(profile.filesystem).toMatchObject({ ":root": "read", [path.join(root, "ai", "t-mxc")]: "write", "C:\\Users\\karol\\.ssh": "deny" });
  expect((config.shell_environment_policy as { set: Record<string, string> }).set.TEMP).toBe(path.join(root, "ai", "t-mxc", ".tmp"));
  expect(JSON.parse(readFileSync(path.join(root, "ai", "t-mxc", "audit.json"), "utf8"))).toMatchObject({ profile: "research", isolation: "mxc", egress: "packages" });
  expect(store.listEvents(workspaceId, { type: "agent.task.requested", entityId: "t-mxc" })[0]!.payload).toMatchObject({ isolation: "mxc" });
  // Handed a mail: the same sandbox with no network and no proxy.
  const mail = fake([summary()], { windowsSandbox: { status: "ready" }, threadResponse: started, script: async () => { writeFileSync(path.join(root, "ai", "t-mxc-mail", "notes.md"), "笔记"); } });
  expect(await runner(mail.rpc, { platform: "win32" })({ ...input, taskId: "t-mxc-mail", untrusted: ["mail"] })).toMatchObject({ state: "done", sandbox: "mxc" });
  const mailConfig = mail.threadStarts()[0]!.config as Record<string, unknown>;
  expect((mailConfig.permissions as Record<string, { network: unknown }>)["crossline-shell"]!.network).toEqual({ enabled: false });
  expect(mailConfig).not.toHaveProperty("features.network_proxy");
  // A runtime that started the thread without the profile (or with the network on for a run that has none) runs nothing.
  const wrong = fake([summary()], { windowsSandbox: { status: "ready" }, threadResponse: { ...started, sandbox: { type: "workspaceWrite", networkAccess: true } } });
  expect(await runner(wrong.rpc, { platform: "win32" })({ ...input, taskId: "t-mxc-wrong", untrusted: ["mail"] })).toMatchObject({ state: "blocked", code: "SKILL_SANDBOX_UNSUPPORTED" });
});

test("on Windows without MXC: an elevated sandbox already set up is used; with none, untrusted runs are refused and research runs lose the network", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const started = { activePermissionProfile: { id: "crossline-shell" }, sandbox: { type: "workspaceWrite", networkAccess: false } };
  const elevated = fake([summary()], { windowsSandbox: { status: "ready", configured: "elevated" }, threadResponse: started,
    script: async () => { writeFileSync(path.join(root, "ai", "t-elev", "notes.md"), "笔记"); } });
  expect(await runner(elevated.rpc, { platform: "win32" })({ ...input, taskId: "t-elev", untrusted: ["mail"] })).toMatchObject({ state: "done", sandbox: "elevated" });
  const elevatedConfig = elevated.threadStarts()[0]!.config as Record<string, unknown>;
  expect(elevatedConfig).toMatchObject({ default_permissions: "crossline-shell" });
  expect(elevatedConfig).not.toHaveProperty("features.prefer_mxc");
  // Nothing set up (and an unelevated backend counts as nothing): a mail is not read at all.
  for (const windowsSandbox of [{ status: "notConfigured" }, { status: "ready", configured: "unelevated" }]) {
    const none = fake([summary()], { windowsSandbox });
    expect(await runner(none.rpc, { platform: "win32" })({ ...input, taskId: "t-none", untrusted: ["mail"] })).toMatchObject({ state: "blocked", code: "AGENT_SANDBOX_UNAVAILABLE" });
    expect(none.threadStarts()).toHaveLength(0);
  }
  expect(store.listEvents(workspaceId, { type: "agent.task.requested", entityId: "t-none" })).toHaveLength(0);
  // A research run still runs, behind the guard alone and with no network from its shell.
  const decisions: string[] = [];
  const research = fake([summary()], { windowsSandbox: { status: "updateRequired", configured: "elevated" }, script: async ({ ask }) => {
    writeFileSync(path.join(root, "ai", "t-bare", "notes.md"), "笔记");
    decisions.push(String((await ask("item/commandExecution/requestApproval", { command: "pip install matplotlib" })).decision));
  } });
  expect(await runner(research.rpc, { platform: "win32" })({ ...input, taskId: "t-bare" })).toMatchObject({ state: "done", sandbox: "guard-only", isolation: { egress: "none" } });
  expect(research.threadStarts()[0]).toMatchObject({ sandbox: "danger-full-access" });
  expect(decisions).toEqual(["decline"]);
  expect(JSON.parse(readFileSync(path.join(root, "ai", "t-bare", "audit.json"), "utf8"))).toMatchObject({ isolation: "guard-only", egress: "none" });
});

test("a host the sandbox's network proxy blocked is never let through, whatever the command", async () => {
  const audit: AuditRecord = { commands: [], filesChanged: [], mcpCalls: [], searches: [], decisions: [], requests: { total: 0, allowed: 0 } };
  const answer = createAgentAnswerer({ taskDir: "C:\\ai\\t", homeDir: "C:\\Users\\karol", egress: "packages" }, audit, new Map(), async () => true);
  expect(await answer("item/commandExecution/requestApproval", { command: "pip install requests", networkApprovalContext: { host: "evil.example", protocol: "https" } }))
    .toEqual({ decision: "decline" });
  expect(await answer("item/commandExecution/requestApproval", { command: "pip install requests", proposedNetworkPolicyAmendments: [{ host: "evil.example", action: "allow" }] }))
    .toEqual({ decision: "decline" });
  expect(audit.decisions.map((d) => d.rule)).toEqual(["permissions.extra", "permissions.extra"]);
});

test("a delivered data file counts only when the run's script makes it again; otherwise the result is held for the person", async () => {
  approveCategory(store, workspaceId, "data_code_sim");
  for (let i = 0; i < CLEAN_RUNS_TO_TRUST; i += 1) recordReview(store, workspaceId, "data_code_sim", true);
  const table = summary({ artifacts: [{ path: "table.csv", purpose: "数据表" }] });
  const write = (id: string, script: string) => async () => {
    writeFileSync(path.join(root, "ai", id, "run.mjs"), script);
    writeFileSync(path.join(root, "ai", id, "table.csv"), "a,b\n1,2\n");
  };
  const same = await runner(fake([table], { script: write("t-same", "import { writeFileSync } from 'node:fs';\nwriteFileSync('table.csv', 'a,b\\n1,2\\n');\n") }).rpc)({ ...input, category: "data_code_sim", taskId: "t-same" });
  expect(same).toMatchObject({ state: "done", reviewRequired: false, reproduced: true });
  const other = await runner(fake([table], { script: write("t-other", "import { writeFileSync } from 'node:fs';\nwriteFileSync('table.csv', 'a,b\\n3,4\\n');\n") }).rpc)({ ...input, category: "data_code_sim", taskId: "t-other" });
  expect(other).toMatchObject({ state: "done", reviewRequired: true, reproduced: false, reviewReasons: ["重新运行 run 脚本生成的 table.csv 与交付的不一致"] });
  expect(JSON.parse(readFileSync(path.join(root, "ai", "t-other", "audit.json"), "utf8"))).toMatchObject({ reproduced: false, reproduction: { problem: "mismatch" } });
  expect(store.listEvents(workspaceId, { type: "agent.task.completed", entityId: "t-other" })[0]!.payload).toMatchObject({ reproduced: false, reviewRequired: true });
}, 30_000);

test("on the account's node, the shell runs in the node's task directory, its inputs are copies and its results come back to the server", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const tasksRoot = path.join(root, "node-tasks");
  const original = path.join(root, "syllabus.txt");
  writeFileSync(original, "原文");
  own(original);
  const { rpc, threadStarts } = fake([summary()], { script: async () => {
    writeFileSync(path.join(tasksRoot, "t-node", "notes.md"), "笔记");
    writeFileSync(path.join(tasksRoot, "t-node.inputs", "0", "syllabus.txt"), "被改过");
  } });
  const link = fakeNode(tasksRoot, rpc, { home: path.join(root, "node-home") });
  const nodeRunner = createAgentRunner(store, workspaceId, "C:\\repo", () => undefined, { outputRoot: path.join(root, "ai"), homeDir: "C:\\Users\\karol", mode: "node", node: link });
  const outcome = await nodeRunner({ ...input, taskId: "t-node", inputs: [original] });
  if (outcome.state !== "done") throw new Error(JSON.stringify(outcome));
  expect(threadStarts()[0]).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "untrusted", cwd: path.join(tasksRoot, "t-node") });
  expect(readFileSync(path.join(root, "ai", "t-node", "notes.md"), "utf8")).toBe("笔记");
  expect(readFileSync(original, "utf8")).toBe("原文");
  expect(outcome.inputsModified).toEqual([original]);
  expect(store.listEvents(workspaceId, { type: "agent.task.requested" }).at(-1)!.payload).toMatchObject({ mode: "node", node: "PC-A" });
  // A node gone before the run starts: the run is lost, and retried like any lost run.
  link.disconnect();
  expect(await nodeRunner({ ...input, taskId: "t-node-2" })).toMatchObject({ state: "blocked", code: "AGENT_RUN_LOST" });
});

test("outside the owner's own shell a run takes only inputs this workspace owns, never the server's ledger or another account's run", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const data = path.join(root, "data");
  const state = path.join(root, "state");
  const ai = path.join(data, "ai-output");
  for (const dir of [path.join(data, "sources"), path.join(data, "materials", "wo-x"), state, path.join(ai, "agent-other"), path.join(ai, "agent-mine")]) mkdirSync(dir, { recursive: true });
  const db = path.join(data, "crossline.db");
  const auth = path.join(state, "auth.json");
  const mine = path.join(data, "sources", "syllabus.txt");
  for (const file of [db, auth, mine, path.join(ai, "agent-other", "notes.md"), path.join(ai, "agent-mine", "notes.md")]) writeFileSync(file, "x");
  own(mine);
  store.appendEvent({ ownerId: "user-1", workspaceId, idempotencyKey: "req-mine", type: "agent.task.requested", entityId: "agent-mine", payload: { taskId: "agent-mine", title: "前一次" } });
  // The other account's run is in the same output root but in its own workspace's ledger.
  const other = store.createPrincipalWithWorkspace("user-2", "别人").workspace.id;
  store.appendEvent({ ownerId: "user-2", workspaceId: other, idempotencyKey: "req-other", type: "agent.task.requested", entityId: "agent-other", payload: { taskId: "agent-other", title: "别人的" } });
  // A folder the person authorized that happens to hold the data folder is refused too.
  store.setSetting(workspaceId, "sources.folders", JSON.stringify([{ id: "f1", path: root, label: "全部", addedAt: "2026-11-03T00:00:00.000Z", lines: [] }]));
  const asked = [db, auth, data, path.join(ai, "agent-other"), mine, path.join(ai, "agent-mine"), path.join(data, "materials", "wo-x")];
  expect(ownedInputs(store, workspaceId, asked, { outputRoot: ai, dataDir: data, stateDir: state }).kept).toEqual([mine, path.join(ai, "agent-mine")]);

  // Every mode but the owner's shell goes through it: what the tools run is handed is what it records.
  const { rpc } = sharedRuntime([summary()], "crossline:crossline-agent-tools");
  const tools = createAgentRunner(store, workspaceId, "C:\\repo", () => rpc, { outputRoot: ai, mode: "tools", confine: { dataDir: data, stateDir: state } });
  await tools({ ...input, taskId: "t-confined", inputs: asked });
  expect(store.listEvents(workspaceId, { type: "agent.task.requested", entityId: "t-confined" })[0]!.payload).toMatchObject({ inputs: [mine, path.join(ai, "agent-mine")] });
  // And a node is sent copies of those only.
  const tasksRoot = path.join(root, "node-tasks");
  const { rpc: nodeRpc } = fake([summary()]);
  const link = fakeNode(tasksRoot, nodeRpc, { home: path.join(root, "node-home") });
  const nodeRunner = createAgentRunner(store, workspaceId, "C:\\repo", () => undefined, { outputRoot: ai, homeDir: "C:\\Users\\karol", mode: "node", node: link, confine: { dataDir: data, stateDir: state } });
  await nodeRunner({ ...input, taskId: "t-node-confined", inputs: [db, mine] });
  expect(readFileSync(path.join(tasksRoot, "t-node-confined.inputs", "0", "syllabus.txt"), "utf8")).toBe("x");
  expect(existsSync(path.join(tasksRoot, "t-node-confined.inputs", "1"))).toBe(false);
});

// Review of 2026-11-25: a file change is judged on the path the file system has, through the nearest folder that exists.
test("realPathOf resolves a new file's folder and keeps the parts that do not exist yet", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "real-"));
  try {
    mkdirSync(path.join(dir, "skill-library"));
    const real = realPathOf(path.join(dir, "skill-library", ".", "ws", "..", "ws", "new.md"));
    expect(real.toLowerCase()).toBe(path.join(realPathOf(dir), "skill-library", "ws", "new.md").toLowerCase());
    expect(real.endsWith(path.join("skill-library", "ws", "new.md"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
