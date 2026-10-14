import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore, consentToGrownSkill, createReminderWorkflow, grownHomeLine, readGrownSkills, requestWorkflow, updateGrownSkill } from "@crossline/db";
import { LINE_SETTING } from "@crossline/identity-packs";
import { validateWorkflowManifest } from "@crossline/core";
import type { AgentOutcome } from "./agent-task";
import { cleanGrownSkills, growCandidates, growTask, installGrown, openWorkflowLogin, SKILL_CREATOR, startWorkflowRun, workflowSchedulePass } from "./workflow-smith";
import { fakeRuntime, scriptedRuntime } from "./testing/fake-runtime";
import { librarySkillsFor } from "./skill-library";

const REVIEWER = "crossline:crossline-validation-reviewer";
const estimate = { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
let store: CrosslineStore;
let ws: string;
let root: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  root = mkdtempSync(path.join(tmpdir(), "crossline-grow-"));
  store.setSetting(ws, LINE_SETTING, JSON.stringify([{ id: "media", label: "创作者", color: "media", goal: "", goals: [], createdAt: "" }]));
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "America/Chicago" }));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const owner = () => store.getWorkspaceOwnerId(ws)!;
function acceptedTask(id: string, title: string) {
  store.saveWorkOrder({ id: `wo-${id}`, ownerId: "o", workspaceId: ws, identityId: "media", projectId: "p", milestoneId: "", intent: title, state: "accepted",
    riskTier: "routine", estimate, payload: {} });
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `req-${id}`, type: "agent.task.requested", entityId: id,
    payload: { taskId: id, title, category: "media_edit", workOrderId: `wo-${id}` } });
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `done-${id}`, type: "agent.task.completed", entityId: id,
    payload: { taskId: id, directory: path.join(root, id), artifacts: [], checksPassed: true, reviewRequired: true } });
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `rev-${id}`, type: "agent.task.reviewed", entityId: id,
    payload: { taskId: id, decision: "accepted", note: "", category: "media_edit" } });
}

const workflowJson = {
  name: "weekly-vlog-cut", summary: "每周把素材剪成一条 3 分钟 vlog", lines: ["media"], category: "media_edit", trigger: "schedule",
  schedule: { type: "weekly", days: ["FR"], time: "18:00" }, action: "run", reminder: "",
  steps: [{ title: "粗剪并加字幕", by: "assistant", external: false }, { title: "上传并发布到小红书", by: "person", external: true }],
  inputs: ["本周素材"], outputs: ["成片"]
};
function writeSkill(dir: string, manifest: object = workflowJson, script = "ffmpeg -i input.mp4 -t 180 out.mp4\n") {
  mkdirSync(path.join(dir, "skill", "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "skill", "SKILL.md"), "---\nname: weekly-vlog-cut\ndescription: 把一周素材剪成一条 vlog\n---\n# 剪辑\n1. 粗剪\n");
  writeFileSync(path.join(dir, "skill", "scripts", "cut.sh"), script);
  writeFileSync(path.join(dir, "skill", "workflow.json"), JSON.stringify(manifest));
}
const done = (taskId: string, directory: string) => ({ state: "done", taskId, directory, summary: {}, artifacts: [], audit: {}, inputsModified: [], checksPassed: true, reviewRequired: false }) as unknown as AgentOutcome;
const reviewer = (verdict = "usable") => scriptedRuntime([REVIEWER], () => JSON.stringify({ verdict, reasons: ["脚本只处理本目录的素材"] }));

test("two accepted edits of the same kind on a line, or the person's words, become a candidate; each is tried once", () => {
  acceptedTask("a1", "剪辑第一周的 vlog 素材成片");
  expect(growCandidates(store, ws)).toEqual([]);
  acceptedTask("a2", "剪辑第二周的 vlog 素材成片");
  const [candidate] = growCandidates(store, ws);
  expect(candidate).toMatchObject({ lineId: "media", category: "media_edit", origin: { kind: "repeated", taskIds: ["a2", "a1"] } });
  const input = growTask(candidate!, ["media"]);
  expect(input).toMatchObject({ category: "media_edit", prep: true, extraSkills: [SKILL_CREATOR], inputs: [path.join(root, "a2"), path.join(root, "a1")] });
  expect(input.what).toContain("$skill-creator");
  expect(input.what).toContain("by 为 \"person\"、external 为 true");
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: "tried", type: "skill.grown.attempted", entityId: "media", payload: { taskIds: ["a1", "a2"] } });
  expect(growCandidates(store, ws)).toEqual([]);
  const requestId = requestWorkflow(store, ws, "每周五下午六点提醒我发小红书", "media", owner());
  expect(growCandidates(store, ws)).toEqual([expect.objectContaining({ origin: { kind: "asked", text: "每周五下午六点提醒我发小红书", requestId } })]);
});

test("a grown workflow is read back, checked, reviewed, installed and announced; publishing handed to the assistant goes to the person", async () => {
  const dir = path.join(root, "grow-1");
  writeSkill(dir);
  const candidate = { lineId: "media", category: "media_edit" as const, origin: { kind: "repeated" as const, taskIds: ["a1", "a2"] }, text: "剪辑 vlog", examples: [] };
  const result = await installGrown(store, ws, candidate, done("grow-1", dir), { client: reviewer().rpc, cwd: "C:\\repo" });
  expect(result).toEqual({ state: "installed", id: "flow-weekly-vlog-cut" });
  const [record] = readGrownSkills(store, ws);
  expect(record).toMatchObject({ status: "active", pinned: false, category: "media_edit", review: { final: "usable" }, scan: { risk: "low" }, taskId: "grow-1" });
  expect(record!.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "scripts/cut.sh", "workflow.json"]);
  const said = store.listRecentNudges(ws, "2000-01-01T00:00:00Z").at(-1)!;
  expect((said.payload.card as { clarify: { question: string } }).clarify.question).toContain("创作者主线：同类事已由助手做过 2 次，系统据此长出新工作流「每周把素材剪成一条 3 分钟 vlog」，已可用（每周五 18:00）");
  expect((said.payload.nudge as { delivery: string }).delivery).toBe("pending");

  // Publishing handed to the assistant is handed to the person, and the person is told so.
  const posting = path.join(root, "grow-2");
  writeSkill(posting, { ...workflowJson, name: "post-it", steps: [{ title: "发布到小红书", by: "assistant", external: false }] });
  expect(await installGrown(store, ws, candidate, done("grow-2", posting), { client: reviewer().rpc, cwd: "C:\\repo" })).toMatchObject({ state: "installed" });
  expect(readGrownSkills(store, ws).at(-1)!.manifest.steps).toEqual([{ title: "发布到小红书", by: "person", external: true }]);
  expect((store.listRecentNudges(ws, "2000-01-01T00:00:00Z").at(-1)!.payload.card as { clarify: { question: string } }).clarify.question)
    .toContain("「发布到小红书」涉及对外发出，已改由本人完成");
  // A manifest that cannot be stored is still refused.
  const bad = path.join(root, "grow-2b");
  writeSkill(bad, { ...workflowJson, lines: ["nowhere"] });
  expect(await installGrown(store, ws, candidate, done("grow-2b", bad), { client: reviewer().rpc, cwd: "C:\\repo" }))
    .toMatchObject({ state: "rejected", reason: expect.stringContaining("lines 只能是") });
  // A script that reaches the network keeps the workflow, without the script.
  const risky = path.join(root, "grow-3");
  writeSkill(risky, { ...workflowJson, name: "vlog-upload-prep" }, "curl -X POST https://upload.example.com --data @out.mp4\n");
  expect(await installGrown(store, ws, candidate, done("grow-3", risky), { client: reviewer().rpc, cwd: "C:\\repo" })).toMatchObject({ state: "installed" });
  expect(readGrownSkills(store, ws).at(-1)).toMatchObject({ review: { final: "text_only" }, scan: { risk: "high" } });
});

test("at its time a reminder is said and a run is started with the workflow on; a kind not allowed is said instead; each fires once a day", async () => {
  const dir = path.join(root, "grow-r");
  writeSkill(dir, { ...workflowJson, name: "post-reminder", action: "remind", reminder: "该发本周的小红书了", schedule: { type: "weekly", days: ["FR"], time: "18:00" } });
  const candidate = { lineId: "media", category: "media_edit" as const, origin: { kind: "asked" as const, text: "每周五提醒", requestId: "r1" }, text: "每周五提醒", examples: [] };
  await installGrown(store, ws, candidate, done("grow-r", dir), { client: reviewer().rpc, cwd: "C:\\repo" });
  const run = path.join(root, "grow-run");
  writeSkill(run);
  await installGrown(store, ws, { ...candidate, origin: { kind: "repeated", taskIds: ["x"] } }, done("grow-run", run), { client: reviewer().rpc, cwd: "C:\\repo" });
  const started: Array<{ extraSkills?: string[]; category: string }> = [];
  const friday = new Date("2026-10-16T23:10:00Z");
  expect(workflowSchedulePass(store, ws, (input) => { started.push(input); return { state: "started", taskId: input.taskId }; }, friday).sort())
    .toEqual(["flow-post-reminder", "flow-weekly-vlog-cut"]);
  expect(started).toEqual([expect.objectContaining({ category: "media_edit", extraSkills: ["crossline-grown:flow-weekly-vlog-cut"] })]);
  const questions = store.listRecentNudges(ws, "2000-01-01T00:00:00Z").map((message) => (message.payload.card as { clarify: { question: string } }).clarify.question);
  expect(questions).toContain("该发本周的小红书了");
  expect(workflowSchedulePass(store, ws, () => ({ state: "started", taskId: "t" }), new Date("2026-10-16T23:40:00Z"))).toEqual([]);
  // Next week, the assistant's kind not allowed: the person is told it is due and why it did not start.
  workflowSchedulePass(store, ws, () => ({ state: "needs_category_approval", category: "media_edit", label: "剪辑音视频和图片（不发布）" }), new Date("2026-10-23T23:10:00Z"));
  expect(store.listRecentNudges(ws, "2000-01-01T00:00:00Z").map((message) => (message.payload.card as { clarify: { question: string } }).clarify.question))
    .toContain("到点了：每周把素材剪成一条 3 分钟 vlog。助手还没获准做「剪辑音视频和图片（不发布）」这类工作，可在设置里开启。");
});

test("a grown workflow idle for thirty days goes, unless the person kept it", async () => {
  const dir = path.join(root, "grow-c");
  writeSkill(dir);
  const candidate = { lineId: "media", category: "media_edit" as const, origin: { kind: "repeated" as const, taskIds: ["a"] }, text: "x", examples: [] };
  await installGrown(store, ws, candidate, done("grow-c", dir), { client: reviewer().rpc, cwd: "C:\\repo", now: () => new Date("2026-09-01T00:00:00Z") });
  const id = readGrownSkills(store, ws)[0]!.id;
  updateGrownSkill(store, ws, id, { pinned: true });
  expect(cleanGrownSkills(store, ws, new Date("2026-10-14T00:00:00Z"))).toEqual([]);
  updateGrownSkill(store, ws, id, { pinned: false });
  expect(cleanGrownSkills(store, ws, new Date("2026-10-15T00:00:00Z"))).toEqual([id]);
  expect(readGrownSkills(store, ws)).toEqual([]);
});

test("a reminder set in words is in place at once, kept, and said at its time on its days", () => {
  const record = createReminderWorkflow(store, ws, { text: "每周五下午六点提醒我发小红书", reminder: "该发本周的小红书了", time: "18:00", weekdays: [5], lineId: "media" });
  expect(record).toMatchObject({ pinned: true, status: "active", manifest: { action: "remind", schedule: { type: "weekly", days: ["FR"], time: "18:00" } } });
  expect(createReminderWorkflow(store, ws, { text: "每天提醒", reminder: "喝水", time: "09:00", weekdays: [], lineId: "" }).manifest.schedule).toEqual({ type: "daily", time: "09:00" });
  expect(createReminderWorkflow(store, ws, { text: "工作日提醒", reminder: "站会", time: "09:30", weekdays: [1, 2, 3, 4, 5], lineId: "" }).manifest.schedule)
    .toEqual({ type: "weekdays", time: "09:30" });
  const runs: unknown[] = [];
  expect(workflowSchedulePass(store, ws, (input) => { runs.push(input); return { state: "started", taskId: "t" }; }, new Date("2026-10-16T23:05:00Z")))
    .toEqual([record.id]);
  expect(runs).toEqual([]);
  expect((store.listRecentNudges(ws, "2000-01-01T00:00:00Z").at(-1)!.payload.card as { clarify: { question: string } }).clarify.question).toBe("该发本周的小红书了");
});

test("the first real grown workflow (2026-10-14) installs: a Chinese name is a label, and 「发布前核对清单」 is not publishing", async () => {
  const dir = path.join(root, "grow-real");
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "testing", "fixtures", "grown-workflow-real-2026-10-14.json"), "utf8")) as object;
  writeSkill(dir, manifest);
  store.setSetting(ws, LINE_SETTING, JSON.stringify([{ id: "research", label: "研究者", color: "research", goal: "", goals: [], createdAt: "" },
    { id: "media", label: "创作者", color: "media", goal: "", goals: [], createdAt: "" }]));
  const candidate = { lineId: "media", category: "read_research_organize" as const, origin: { kind: "repeated" as const, taskIds: ["a", "b"] }, text: "提纲与来源", examples: [] };
  expect(await installGrown(store, ws, candidate, done("grow-real", dir), { client: reviewer().rpc, cwd: "C:\repo" }))
    .toEqual({ state: "installed", id: "flow-weekly-vlog-cut" });
  expect(readGrownSkills(store, ws)[0]!.manifest.steps.at(-1)).toMatchObject({ by: "assistant", external: false });
  // The run that grows it knows the line, so the line's own skill is on for it.
  expect(growTask(candidate, ["media"]).lineId).toBe("media");
});

const said = () => store.listRecentNudges(ws, "2000-01-01T00:00:00Z").map((message) => (message.payload.card as { clarify: { question: string } }).clarify.question);
const favourites = { name: "xhs-favorites-digest", summary: "每周日整理小红书收藏夹，按主题归类并列出可删的重复项", lines: ["media"], category: "files_calendar_prep",
  trigger: "schedule", schedule: { type: "weekly", days: ["SU"], time: "20:00" }, action: "run", reminder: "",
  steps: [{ title: "读取收藏夹并归类", by: "assistant", external: false }, { title: "在小红书里把笔记移进专辑", by: "person", external: false }],
  inputs: [], outputs: ["收藏夹索引.md"],
  access: [{ service: "小红书", site: "https://www.xiaohongshu.com/explore", login: true, how: "在本人登录的浏览器里打开个人页的收藏标签逐屏读取" }],
  risks: ["自动读取页面不符合小红书用户协议，账号有被限制的可能", "页面改版后脚本会失效"] };

test("a workflow that reads the person's account installs waiting for their yes, says its risks, and reaching that site does not cap its scripts", async () => {
  const dir = path.join(root, "grow-xhs");
  writeSkill(dir, favourites, "from playwright.sync_api import sync_playwright; page.goto('https://www.xiaohongshu.com/user/profile/me?tab=fav')");
  const candidate = { lineId: "media", category: "files_calendar_prep" as const, origin: { kind: "asked" as const, text: "定期整理我的小红书收藏夹", requestId: "r1" },
    text: "定期整理我的小红书收藏夹", examples: [] };
  expect(await installGrown(store, ws, candidate, done("grow-xhs", dir), { client: reviewer().rpc, cwd: "C:\repo" })).toEqual({ state: "installed", id: "flow-xhs-favorites-digest" });
  const record = readGrownSkills(store, ws)[0]!;
  expect(record).toMatchObject({ status: "needs_consent", review: { final: "usable" }, scan: { risk: "low" } });
  expect(record.scan.findings.map((finding) => finding.rule)).toContain("net");
  expect(said().at(-1)).toContain("先请本人看风险：自动读取页面不符合小红书用户协议");
  // Not scheduled, and not switched on by the plain on/off, until the person accepts the risks.
  expect(workflowSchedulePass(store, ws, () => ({ state: "started", taskId: "t" }), new Date("2026-10-19T01:10:00Z"))).toEqual([]);
  expect(updateGrownSkill(store, ws, record.id, { status: "active" })).toBe(false);
  expect(consentToGrownSkill(store, ws, record.id)).toBe(true);
  expect(readGrownSkills(store, ws)[0]).toMatchObject({ status: "active", consentedAt: expect.any(String) });
});

test("the person logs in in a window of its own; a run is told that profile, and a run that found itself logged out asks for a login", () => {
  writeFileSync(path.join(root, "clip.mp4"), "x");
  store.setSetting(ws, "skills.grown", JSON.stringify([{ id: "flow-xhs", kind: "grown", name: "xhs", description: "d", lines: ["media"], category: "files_calendar_prep",
    manifest: { ...favourites, inputs: [root, "本周素材"] }, origin: { kind: "asked", text: "t", requestId: "r" }, taskId: "", files: [],
    scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: [], final: "usable" }, status: "active", pinned: false,
    createdAt: "", updatedAt: "", lastUsedAt: "" }]));
  const profiles = path.join(root, "profiles");
  let launched: { exe: string; args: string[]; onExit: () => void } | undefined;
  const opened = openWorkflowLogin(store, ws, "flow-xhs", "小红书", profiles, { browser: "msedge.exe", launch: (exe, args, onExit) => { launched = { exe, args, onExit }; } });
  expect(opened).toEqual({ ok: true });
  expect(launched!.args).toEqual([`--user-data-dir=${path.join(profiles, "xiaohongshu.com")}`, "--no-first-run", "--no-default-browser-check", "--new-window", "https://www.xiaohongshu.com/explore"]);
  expect(openWorkflowLogin(store, ws, "flow-xhs", "小红书", profiles, { browser: "x", launch: () => {} })).toMatchObject({ ok: false, code: "LOGIN_WINDOW_OPEN" });
  const record = readGrownSkills(store, ws)[0]!;
  // While the window is open the profile is in use, so a run waits.
  expect(startWorkflowRun(store, ws, record, () => ({ state: "started", taskId: "t" }), profiles)).toMatchObject({ state: "blocked", code: "LOGIN_WINDOW_OPEN" });
  launched!.onExit();
  expect(readGrownSkills(store, ws)[0]!.logins).toEqual({ 小红书: expect.any(String) });
  let after: ((outcome: AgentOutcome) => void) | undefined;
  const inputs: Array<{ what: string; inputs?: string[] }> = [];
  expect(startWorkflowRun(store, ws, record, (input, then) => { inputs.push(input); after = then; return { state: "started", taskId: input.taskId }; }, profiles, new Date(), "msedge.exe").state).toBe("started");
  expect(inputs[0]!.inputs).toEqual([root]);
  expect(inputs[0]!.what).toContain(`浏览器配置目录 ${path.join(profiles, "xiaohongshu.com")}，浏览器程序 msedge.exe`);
  after!({ ...done("t", root), summary: { needsHuman: [{ what: "需要登录：小红书", why: "打开收藏页跳到了登录页" }] } } as unknown as AgentOutcome);
  expect(said().at(-1)).toContain("这次没读到：需要登录：小红书");
});

test("the first grown vlog workflow (2026-10-14) installs with its script: reading a system font is not leaving its directory", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "testing", "fixtures", "grown-vlog-workflow-real-2026-10-14.json"), "utf8")) as { files: Array<{ path: string; text: string }> };
  const dir = path.join(root, "grow-vlog");
  for (const file of fixture.files) { mkdirSync(path.dirname(path.join(dir, "skill", file.path)), { recursive: true }); writeFileSync(path.join(dir, "skill", file.path), file.text); }
  const candidate = { lineId: "media", category: "media_edit" as const, origin: { kind: "asked" as const, text: "每周五剪 vlog", requestId: "r-vlog" }, text: "每周五剪 vlog", examples: [] };
  expect(await installGrown(store, ws, candidate, done("grow-vlog", dir), { client: reviewer().rpc, cwd: "C:\repo" })).toMatchObject({ state: "installed" });
  expect(readGrownSkills(store, ws)[0]).toMatchObject({ status: "active", scan: { risk: "low", findings: [] }, review: { final: "usable" },
    manifest: { trigger: "schedule", schedule: { type: "weekly", days: ["FR"], time: "20:00" } } });
});

test("a grown workflow serves only the line it grew on, and a run growing another workflow switches none on (the 2026-10-14 crossing)", async () => {
  // As on the real ledger: grown from three accepted media errands, its manifest named research as well.
  for (const id of ["m1", "m2"]) acceptedTask(id, "为小红书笔记收集公开来源并整理提纲");
  const older = { id: "flow-xhs-note", kind: "grown", name: "xhs-note", description: "整理公开来源，生成小红书提纲", lines: ["research", "media"], category: "media_edit",
    manifest: { ...workflowJson, lines: ["research", "media"], summary: "整理公开来源，生成小红书提纲", access: [], risks: [] },
    origin: { kind: "repeated", taskIds: ["m1", "m2"] }, taskId: "", files: [{ path: "SKILL.md", sha256: "x", bytes: 1 }],
    scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: [], final: "usable" }, status: "active", pinned: false,
    createdAt: "", updatedAt: "", lastUsedAt: "" };
  store.setSetting(ws, "skills.grown", JSON.stringify([older]));
  store.setSetting(ws, "skills.grown.files.flow-xhs-note", JSON.stringify({ files: [{ path: "SKILL.md", text: "---\nname: xhs-note\ndescription: 整理公开来源\n---\n" }] }));
  store.setSetting(ws, LINE_SETTING, JSON.stringify([{ id: "media", label: "创作者", color: "media", goal: "", goals: [], createdAt: "" },
    { id: "research", label: "研究者", color: "research", goal: "", goals: [], createdAt: "" }]));
  expect(grownHomeLine(store, ws, readGrownSkills(store, ws)[0]!)).toBe("media");
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-lib-"));
  try {
    const run = fakeRuntime(["{}"], "crossline:crossline-agent", { library: ["crossline-grown:flow-xhs-note"] });
    expect(await librarySkillsFor(run.rpc, store, ws, "research", { cwd: "C:\repo", dir, task: "汇集课程讲义并整理公开来源" })).toEqual([]);
    expect(await librarySkillsFor(run.rpc, store, ws, "media", { cwd: "C:\repo", dir, task: "为小红书整理公开来源" })).toEqual(["crossline-grown:flow-xhs-note"]);
    expect(await librarySkillsFor(run.rpc, store, ws, "media", { cwd: "C:\repo", dir, task: "为小红书整理公开来源", grown: false })).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // A new workflow keeps only the line it was grown for, whatever its manifest lists.
  const grown = path.join(root, "grow-two-lines");
  writeSkill(grown, { ...workflowJson, name: "two-lines", lines: ["research", "media"] });
  const candidate = { lineId: "media", category: "media_edit" as const, origin: { kind: "asked" as const, text: "每周剪 vlog", requestId: "r9" }, text: "每周剪 vlog", examples: [] };
  await installGrown(store, ws, candidate, done("grow-two-lines", grown), { client: reviewer().rpc, cwd: "C:\repo" });
  expect(readGrownSkills(store, ws).find((record) => record.id === "flow-two-lines")?.lines).toEqual(["media"]);
  expect(said().at(-1)).toMatch(/^按本人的要求（创作者主线）长出新工作流/);
  expect(growTask(candidate, ["media", "research"])).toMatchObject({ growing: true, lineId: "media" });
});

test("reading a page is not leaving the machine: the first account-reading workflow's reading steps stay the assistant's (2026-10-14)", () => {
  const real = JSON.parse(readFileSync(path.join(import.meta.dirname, "testing", "fixtures", "grown-xhs-favorites-manifest-real-2026-10-14.json"), "utf8"));
  const steps = validateWorkflowManifest(real, ["media", "research"]).steps;
  expect(steps.filter((step) => step.by === "assistant").map((step) => step.title)).toEqual([
    "Crossline 助手低频只读采集收藏页与重点账号的可见内容", "Crossline 助手去重、分类并生成重点账号观察索引", "联网调研（Codex）按需核验定位、选题与公开事实依据",
    "Crossline 助手形成最多三个原创内容实验选项并执行红线自查"]);
  expect(validateWorkflowManifest({ ...workflowJson, access: [], risks: [], steps: [{ title: "读取素材后上传到小红书", by: "assistant", external: true }] }, ["media"]).steps[0]).toMatchObject({ by: "person", external: true });
});

test("a request whose growing run was lost to a restart is grown again, up to three runs; one that ended on its own is not", () => {
  const id = requestWorkflow(store, ws, "定期整理小红书收藏夹", "media", owner());
  const attempt = (taskId: string, lost: boolean) => {
    store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `att-${taskId}`, type: "skill.grown.attempted", entityId: "media", payload: { taskId, state: "started", requestId: id } });
    if (lost) store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `lost-${taskId}`, type: "agent.task.blocked", entityId: taskId, payload: { taskId, code: "AGENT_RUN_LOST" } });
  };
  attempt("g1", true);
  expect(growCandidates(store, ws).map((item) => item.origin.kind)).toEqual(["asked"]);
  attempt("g2", true);
  attempt("g3", true);
  expect(growCandidates(store, ws)).toEqual([]);
  const other = requestWorkflow(store, ws, "每周剪 vlog", "media", owner());
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: "att-g4", type: "skill.grown.attempted", entityId: "media", payload: { taskId: "g4", state: "started", requestId: other } });
  expect(growCandidates(store, ws)).toEqual([]);
});
