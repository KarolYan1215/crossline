import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { approveCategory, createAgentRunner, TOOLS_AGENT_SKILL, toolLoopReason } from "./agent-task";
import { createAgentToolbox, inside, TAINT_HELD } from "./agent-tools";
import { TOOL_SPEC } from "@crossline/core";
import { setWebAvailableProvider, WEB_SCOUT_SKILL } from "@crossline/codex";
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
  const completed = store.listEvents(workspaceId, { type: "agent.changed", change: "task_completed", entityId: "t-tools" })[0]!.payload as Record<string, unknown>;
  expect(completed).toMatchObject({ mode: "tools", commands: 2, captured: 1 });
  const audit = JSON.parse(readFileSync(path.join(root, "ai", "t-tools", "audit.json"), "utf8"));
  expect(audit.toolCalls.map((call: { tool: string }) => call.tool)).toEqual(["write_file", "add_to_inbox"]);
});

test("a run told to go on in an earlier run's conversation resumes that thread, and its functions answer for the new task directory", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const summary = (file: string) => JSON.stringify({ summary: `写了 ${file}`, artifacts: [{ path: file, purpose: "清单" }],
    verification: [{ check: "读回", result: "pass", evidence: `读回 ${file}` }], needsHuman: [], notDone: [], assumptions: [] });
  let turn = 0;
  const { rpc, threadStarts, resumes } = fakeRuntime([summary("week-1.md"), summary("week-2.md")], TOOLS_AGENT_SKILL, { script: async ({ ask }) => {
    turn += 1;
    await ask("item/tool/call", { callId: `c${turn}`, tool: "write_file", arguments: { path: `week-${turn}.md`, content: `第 ${turn} 周` } });
  } });
  const run = createAgentRunner(store, workspaceId, "/repo", () => rpc, { outputRoot: path.join(root, "ai"), mode: "tools" });
  const first = await run({ taskId: "t-week-1", title: "每周整理", what: "整理本周", category: "read_research_organize", humanPart: "" });
  expect(first).toMatchObject({ state: "done", threadId: "thread-1" });
  const second = await run({ taskId: "t-week-2", title: "每周整理", what: "整理本周", category: "read_research_organize", humanPart: "",
    resumeThreadId: (first as { threadId: string }).threadId });
  expect(second).toMatchObject({ state: "done", threadId: "thread-1" });
  expect(threadStarts()).toHaveLength(1);
  expect(resumes()).toEqual(["thread-1"]);
  expect(readFileSync(path.join(root, "ai", "t-week-2", "week-2.md"), "utf8")).toBe("第 2 周");
});

test("a run that calls no function is sent back: a summary of work never done is not a result", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const plan = JSON.stringify({ summary: "开始读取任务板与日历，随后生成清单文件。", artifacts: [], verification: [], needsHuman: [], notDone: [], assumptions: [] });
  const { rpc, prompts } = fakeRuntime([plan, plan, plan], TOOLS_AGENT_SKILL);
  const run = createAgentRunner(store, workspaceId, "/repo", () => rpc, { outputRoot: path.join(root, "ai"), mode: "tools" });
  const outcome = await run({ taskId: "t-idle", title: "每日到期清单", what: "整理到期任务", category: "read_research_organize", humanPart: "" });
  expect(outcome.state).toBe("blocked");
  expect(prompts().some((prompt) => prompt.includes("一个函数都没有调用"))).toBe(true);
  expect(store.listEvents(workspaceId, { type: "agent.changed", change: "task_completed", entityId: "t-idle" })).toHaveLength(0);
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

test("a sandboxed shell run is started under the task profile — writes in its folder, the server's data unreadable, no network — and refused without it", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const summary = JSON.stringify({ summary: "整理完成。", artifacts: [], verification: [], needsHuman: [], notDone: [], assumptions: [] });
  const sandbox = { readable: ["/opt/codex"], deny: ["/data", "/state"] };
  const { rpc, threadStarts } = fakeRuntime([summary], "crossline:crossline-agent:shell",
    { threadResponse: { approvalPolicy: "untrusted", activePermissionProfile: { id: "crossline-task" }, sandbox: { type: "workspaceWrite" } } });
  const run = createAgentRunner(store, workspaceId, "/repo", () => rpc, { outputRoot: path.join(root, "ai"), mode: "sandbox", sandbox });
  const outcome = await run({ taskId: "t-sb", title: "整理", what: "整理", category: "read_research_organize", humanPart: "看结果" });
  expect(outcome.state).toBe("done");
  const started = threadStarts()[0]!;
  expect(started).not.toHaveProperty("sandbox");
  const config = started.config as Record<string, unknown>;
  expect(config.default_permissions).toBe("crossline-task");
  const filesystem = ((config.permissions as Record<string, { filesystem: Record<string, string>; network: { enabled: boolean } }>)["crossline-task"]!);
  expect(filesystem.network.enabled).toBe(false);
  expect(filesystem.filesystem).toMatchObject({ ":minimal": "read", "/data": "deny", "/state": "deny", "/opt/codex": "read", [path.join(root, "ai", "t-sb")]: "write" });
  expect((config.shell_environment_policy as { inherit: string }).inherit).toBe("core");
  expect((started.dynamicTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(expect.arrayContaining(["add_to_inbox", "read_document"]));
  expect((started.dynamicTools as Array<{ name: string }>).map((tool) => tool.name)).not.toContain("write_file");
  const { rpc: unsafe } = fakeRuntime([summary], "crossline:crossline-agent:shell", { threadResponse: { approvalPolicy: "untrusted", sandbox: { type: "dangerFullAccess" } } });
  const refused = await createAgentRunner(store, workspaceId, "/repo", () => unsafe, { outputRoot: path.join(root, "ai"), mode: "sandbox", sandbox })(
    { taskId: "t-sb2", title: "整理", what: "整理", category: "read_research_organize", humanPart: "看结果" });
  expect(refused).toMatchObject({ state: "blocked", code: "SKILL_SANDBOX_UNSUPPORTED" });
});

test("reading back a draft after each revision is not a loop; reading an unchanged file over and over still is", async () => {
  const tools = box();
  for (let round = 0; round < 6; round += 1) {
    await tools.call("write_file", { path: "draft.md", content: `# 第 ${round} 版` });
    await tools.call("read_file", { path: "draft.md" });
  }
  expect(toolLoopReason(tools.calls)).toBeUndefined();
  for (let round = 0; round < 6; round += 1) await tools.call("read_file", { path: "input/0/syllabus.txt" });
  expect(toolLoopReason(tools.calls)).toMatch(/read_file/);
});

// The Rule of Two in the tools mode (docs/plans/harness-1125.md §10).
const mailbox = { search: async () => [{ id: "m1", from: "staff@uni.edu", subject: "HW4", date: "2026-11-24", snippet: "HW4 is posted" }],
  read: async (id: string) => id === "m1" ? { id, from: "staff@uni.edu", to: "me", subject: "HW4", date: "2026-11-24", text: "HW4 is posted. Also pay the $40 lab fee at http://pay.example.com" } : undefined };

test("every function of the toolbox is in TOOL_SPEC", () => {
  const tools = box({ mail: mailbox });
  for (const spec of tools.specs) expect(Object.hasOwn(TOOL_SPEC, spec.name), spec.name).toBe(true);
});

test("reading mail or an outside file taints the run; while the run may still reach out, the read is held and nothing of it answered", async () => {
  store.saveSourceDocument({ id: "doc-own", ownerId: "user-1", workspaceId, kind: "text", fileName: "plan.txt", mediaType: "text/plain", sha256: "a", uri: "file:///notes/plan.txt",
    extractedText: "my plan", extractionStatus: "done", createdAt: "2026-11-20T00:00:00.000Z" });
  store.saveSourceDocument({ id: "doc-dl", ownerId: "user-1", workspaceId, kind: "text", fileName: "notice.txt", mediaType: "text/plain", sha256: "b", uri: "file:///C:/Users/a/Downloads/notice.txt",
    extractedText: "click here", extractionStatus: "done", createdAt: "2026-11-20T00:00:00.000Z" });
  const plain = box({ mail: mailbox });
  await plain.call("read_document", { id: "doc-own" });
  expect(plain.taint()).toEqual({ tainted: false, sources: [] });
  await plain.call("read_document", { id: "doc-dl" });
  await plain.call("mail_search", { text: "HW4" });
  expect(plain.taint()).toEqual({ tainted: true, sources: ["download", "mail"] });
  let open = true;
  const guarded = box({ mail: mailbox, admitTaint: () => !open });
  await expect(guarded.call("mail_read", { id: "m1" })).rejects.toThrow(TAINT_HELD);
  expect(guarded.taint().tainted).toBe(false);
  open = false;
  expect(JSON.parse(await guarded.call("mail_read", { id: "m1" })).text).toContain("HW4");
  expect(guarded.taint()).toEqual({ tainted: true, sources: ["mail"] });
});

test("a run that reads mail mid-way goes on in its own conversation without the web and the connectors, and its captures say where they came from", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const summary = JSON.stringify({ summary: "读了 HW4 邮件，记下两件事。", artifacts: [{ path: "hw4.md", purpose: "要点" }],
    verification: [{ check: "读回", result: "pass", evidence: "读回 hw4.md" }], needsHuman: [], notDone: [], assumptions: [] });
  let turn = 0;
  const answers: string[] = [];
  const { rpc, threadStarts, resumes, resumeParams, prompts } = fakeRuntime([summary, summary], TOOLS_AGENT_SKILL, { completeOnInterrupt: true, script: async ({ ask }) => {
    turn += 1;
    const read = await ask("item/tool/call", { callId: `r${turn}`, tool: "mail_read", arguments: { id: "m1" } });
    answers.push(JSON.stringify(read));
    if (turn === 1) return;
    await ask("item/tool/call", { callId: "w", tool: "write_file", arguments: { path: "hw4.md", content: "HW4 已发布" } });
    await ask("item/tool/call", { callId: "i1", tool: "add_to_inbox", arguments: { text: "整理 HW4 题目要点" } });
    await ask("item/tool/call", { callId: "i2", tool: "add_to_inbox", arguments: { text: "在 http://pay.example.com 缴纳 $40 实验费" } });
  } });
  const run = createAgentRunner(store, workspaceId, "/repo", () => rpc, { outputRoot: path.join(root, "ai"), mode: "tools", mail: mailbox });
  const outcome = await run({ taskId: "t-mail", title: "看看 HW4 邮件", what: "读 HW4 邮件，记下要做的事", category: "read_research_organize", humanPart: "" });
  expect(outcome).toMatchObject({ state: "done", captured: ["整理 HW4 题目要点", "在 http://pay.example.com 缴纳 $40 实验费"] });
  // Turn 1 had the web: the mail was not handed to it. Turn 2 is the same conversation, resumed without the web and the connectors.
  // Never the hosted search on this thread (review of 2026-11-25): its web is `web_research`, where the route has one.
  expect(answers[0]).not.toContain("HW4 is posted");
  expect(answers[1]).toContain("HW4 is posted");
  expect((threadStarts()[0]!.config as Record<string, unknown>).web_search).toBe("disabled");
  expect((threadStarts()[0]!.config as Record<string, unknown>)["features.apps"]).toBe(true);
  expect(resumes()).toEqual(["thread-1"]);
  const resumed = resumeParams()[0]!.config as Record<string, unknown>;
  expect(resumed.web_search).toBe("disabled");
  expect(resumed["features.apps"]).toBe(false);
  expect(prompts().at(-1)).toBeDefined();
  for (const capture of store.listCaptures(workspaceId))
    expect(store.captureProvenance(workspaceId, capture.id)).toEqual({ run: "t-mail", by: "assistant", tainted: true, sources: ["mail"] });
  const completed = store.listEvents(workspaceId, { type: "agent.changed", change: "task_completed", entityId: "t-mail" })[0]!.payload as Record<string, unknown>;
  expect(completed.tainted).toEqual(["mail"]);
});

test("a run handed mail at the start starts without the web and the connectors; one that reads nothing untrusted keeps both and its captures carry nothing", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const summary = JSON.stringify({ summary: "写了清单。", artifacts: [{ path: "list.md", purpose: "清单" }],
    verification: [{ check: "读回", result: "pass", evidence: "读回 list.md" }], needsHuman: [], notDone: [], assumptions: [] });
  const { rpc, threadStarts } = fakeRuntime([summary, summary], TOOLS_AGENT_SKILL, { script: async ({ ask }) => {
    await ask("item/tool/call", { callId: "w", tool: "write_file", arguments: { path: "list.md", content: "- 一项" } });
    await ask("item/tool/call", { callId: "i", tool: "add_to_inbox", arguments: { text: "复习第三章" } });
  } });
  const run = createAgentRunner(store, workspaceId, "/repo", () => rpc, { outputRoot: path.join(root, "ai"), mode: "tools" });
  await run({ taskId: "t-handed", title: "处理一封邮件", what: "读这封邮件", category: "read_research_organize", humanPart: "", untrusted: ["mail"] });
  await run({ taskId: "t-plain", title: "整理清单", what: "整理清单", category: "read_research_organize", humanPart: "" });
  const [handed, plain] = threadStarts().map((start) => start.config as Record<string, unknown>);
  expect(handed!.web_search).toBe("disabled");
  expect(handed!["features.apps"]).toBe(false);
  expect(plain!.web_search).toBe("disabled");
  expect(plain!["features.apps"]).toBe(true);
  const [first, second] = store.listCaptures(workspaceId).map((capture) => store.captureProvenance(workspaceId, capture.id));
  expect(first).toEqual({ run: "t-handed", by: "assistant", tainted: true, sources: ["mail"] });
  expect(second).toBeUndefined();
});

// Review of 2026-11-25: the tools assistant's web is `web_research` (a separate scout run), and the pages it hands back are someone else's
// words, so what the run puts in the inbox carries where it came from and high-risk work from it waits for the person.
test("pages from web_research taint the run: its captures carry the page as their source", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  setWebAvailableProvider(() => true);
  try {
    const summary = JSON.stringify({ summary: "查了实验费。", artifacts: [{ path: "fee.md", purpose: "记录" }],
      verification: [{ check: "读回", result: "pass", evidence: "读回 fee.md" }], needsHuman: [], notDone: [], assumptions: [] });
    const scout = JSON.stringify({ results: [{ query: "lab fee", title: "Lab fee", url: "https://lab.example.edu/fee", excerpt: "Pay the fee online.", published: "" }], notes: "" });
    const { rpc, threadStarts } = fakeRuntime([summary], [TOOLS_AGENT_SKILL, WEB_SCOUT_SKILL], { routes: [{ match: "crossline-web-scout", answers: [scout] }], script: async ({ ask }) => {
      await ask("item/tool/call", { callId: "s", tool: "web_research", arguments: { queries: ["ECE lab fee policy"], purpose: "how course lab fees are paid" } });
      await ask("item/tool/call", { callId: "w", tool: "write_file", arguments: { path: "fee.md", content: "实验费" } });
      await ask("item/tool/call", { callId: "i", tool: "add_to_inbox", arguments: { text: "查看实验费缴纳方式" } });
    } });
    const run = createAgentRunner(store, workspaceId, "/repo", () => rpc, { outputRoot: path.join(root, "ai"), mode: "tools" });
    await run({ taskId: "t-web", title: "查实验费", what: "查实验费怎么交", category: "read_research_organize", humanPart: "" });
    expect((threadStarts()[0]!.config as Record<string, unknown>).web_search).toBe("disabled");
    const [capture] = store.listCaptures(workspaceId);
    expect(store.captureProvenance(workspaceId, capture!.id)).toEqual({ run: "t-web", by: "assistant", tainted: true, sources: ["page"] });
  } finally { setWebAvailableProvider(() => false); }
});

// Gap of 2026-11-25 (docs/plans/harness-1125.md §18): what a ChatGPT connector hands back never passes through Crossline, so the read
// itself taints the run, and its next web_research call is reviewed before the scout runs it.
test("a connector read taints the run, and the web_research call after it is reviewed first", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  setWebAvailableProvider(() => true);
  try {
    const summary = JSON.stringify({ summary: "看了日历邀请。", artifacts: [{ path: "invite.md", purpose: "记录" }],
      verification: [{ check: "读回", result: "pass", evidence: "读回 invite.md" }], needsHuman: [], notDone: [], assumptions: [] });
    const refused = JSON.stringify({ ok: false, why: "describes one student" });
    let research: Record<string, unknown> = {};
    const { rpc } = fakeRuntime([summary], [TOOLS_AGENT_SKILL, WEB_SCOUT_SKILL, "crossline:crossline-query-review"], {
      routes: [{ match: "crossline-query-review", answers: [refused] }], script: async ({ ask, emit, threadId, turnId }) => {
        emit({ method: "item/completed", params: { threadId, turnId, item: { type: "mcpToolCall", id: "m1", server: "codex_apps", tool: "gmail_read_email", status: "completed" } } });
        research = await ask("item/tool/call", { callId: "s", tool: "web_research", arguments: { queries: ["PhD student Madison quals December"], purpose: "x" } });
        await ask("item/tool/call", { callId: "w", tool: "write_file", arguments: { path: "invite.md", content: "邀请" } });
        await ask("item/tool/call", { callId: "i", tool: "add_to_inbox", arguments: { text: "回复研讨会邀请" } });
      } });
    const run = createAgentRunner(store, workspaceId, "/repo", () => rpc, { outputRoot: path.join(root, "ai"), mode: "tools" });
    await run({ taskId: "t-conn", title: "看邀请", what: "看看日历邀请", category: "read_research_organize", humanPart: "" });
    expect(research.success).toBe(false);
    const [capture] = store.listCaptures(workspaceId);
    expect(store.captureProvenance(workspaceId, capture!.id)).toEqual({ run: "t-conn", by: "assistant", tainted: true, sources: ["connector"] });
  } finally { setWebAvailableProvider(() => false); }
});

// Review of 2026-11-25: a sandboxed shell run offered the mailbox keeps neither the hosted search nor the connectors (Rule of Two);
// one without a mailbox keeps the web it had.
test("a sandboxed shell run offered the mailbox has no web search and no connectors", async () => {
  approveCategory(store, workspaceId, "read_research_organize");
  const summary = JSON.stringify({ summary: "整理完成。", artifacts: [], verification: [], needsHuman: [], notDone: [], assumptions: [] });
  const sandbox = { readable: ["/opt/codex"], deny: ["/data", "/state"] };
  const started = { approvalPolicy: "untrusted", activePermissionProfile: { id: "crossline-task" }, sandbox: { type: "workspaceWrite" } };
  const withMail = fakeRuntime([summary], "crossline:crossline-agent:shell", { threadResponse: started });
  await createAgentRunner(store, workspaceId, "/repo", () => withMail.rpc, { outputRoot: path.join(root, "ai"), mode: "sandbox", sandbox, mail: mailbox })(
    { taskId: "t-sb-mail", title: "整理", what: "整理", category: "read_research_organize", humanPart: "看结果" });
  const mailStart = withMail.threadStarts()[0]!;
  expect(mailStart.config).toMatchObject({ web_search: "disabled" });
  expect(mailStart.config).not.toHaveProperty("features.apps");
  expect((mailStart.dynamicTools as Array<{ name: string }>).map((tool) => tool.name)).toContain("mail_read");
  const plain = fakeRuntime([summary], "crossline:crossline-agent:shell", { threadResponse: started });
  await createAgentRunner(store, workspaceId, "/repo", () => plain.rpc, { outputRoot: path.join(root, "ai"), mode: "sandbox", sandbox })(
    { taskId: "t-sb-plain", title: "整理", what: "整理", category: "read_research_organize", humanPart: "看结果" });
  expect((plain.threadStarts()[0]!.config as Record<string, unknown>).web_search).not.toBe("disabled");
});
