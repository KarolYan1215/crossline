import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore, consentToGrownSkill, createReminderWorkflow, grownHomeLine, readGrownSkills, recordGrownLogin, requestWorkflow, updateGrownSkill } from "@crossline/db";
import { LINE_SETTING } from "@crossline/identity-packs";
import { validateWorkflowManifest } from "@crossline/core";
import { librarySelection, type AgentOutcome, type AgentTaskInput } from "./agent-task";
import type { OpenSite, SiteReader } from "./site-reader";
import { siteHold } from "./site-reader";
import { cleanGrownSkills, collectionDone, configureFavouritesCollector, configureRemoteLogin, finishWorkflowLogin, growCandidates, growTask, installGrown, openWorkflowLogin, SKILL_CREATOR,
  resumeByPerson, startWorkflowRun, workflowLoginTarget, workflowSchedulePass } from "./workflow-smith";
import { createRemoteBrowsers } from "./remote-browser";
import { holdAfterFailure, readCollectLedger, writeCollectLedger, type CollectDriver } from "./favourites-reader";
import { fakeRuntime, scriptedRuntime } from "./testing/fake-runtime";
import { librarySkillsFor } from "./skill-library";
import { closeInterruptedCollections, createTopicClassifier, favouritesTopicStep, installFavouritesTopicsWorkflow, readTopicPlan, writeTopicPlan } from "./favourites-topics";

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
  expect((said.payload.card as { clarify: { question: string } }).clarify.question).toContain("创作者主线：同类事已由助手做过 2 次，系统据此长出新工作流「每周把素材剪成一条 3 分钟 vlog」，已可用并默认保留（每周五 18:00）");
  expect((said.payload.card as { clarify: { question: string } }).clarify.question).toContain("不需要可在设置里关闭");
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
  const opened = openWorkflowLogin(store, ws, "flow-xhs", "小红书", profiles, { browser: "chrome.exe", launch: (exe, args, onExit) => { launched = { exe, args, onExit }; return { close: () => {} }; } });
  expect(opened).toEqual({ ok: true });
  expect(launched!.args).toEqual([`--user-data-dir=${path.join(profiles, "xiaohongshu.com")}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-mode", "--new-window", "https://www.xiaohongshu.com/explore"]);
  expect(openWorkflowLogin(store, ws, "flow-xhs", "小红书", profiles, { browser: "x", launch: () => ({ close: () => {} }) })).toMatchObject({ ok: false, code: "LOGIN_WINDOW_OPEN" });
  const record = readGrownSkills(store, ws)[0]!;
  // While the window is open the profile is in use, so a run waits.
  expect(startWorkflowRun(store, ws, record, () => ({ state: "started", taskId: "t" }), profiles)).toMatchObject({ state: "blocked", code: "LOGIN_WINDOW_OPEN" });
  launched!.onExit();
  expect(readGrownSkills(store, ws)[0]!).toMatchObject({ logins: { 小红书: expect.any(String) }, loginBrowsers: { 小红书: "chrome.exe" } });
  let after: ((outcome: AgentOutcome) => void) | undefined;
  const inputs: Array<{ what: string; inputs?: string[] }> = [];
  expect(startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, (input, then) => { inputs.push(input); after = then; return { state: "started", taskId: input.taskId }; }, profiles, new Date(), "other.exe").state).toBe("started");
  expect(inputs[0]!.inputs).toEqual([root]);
  // The run is given Crossline's reader, never the profile itself.
  expect(inputs[0]!.what).toContain("只能用工具 site_read 读取");
  expect(inputs[0]!.what).not.toContain(path.join(profiles, "xiaohongshu.com"));
  expect((inputs[0] as { reader?: { tools: { specs: Array<{ name: string }> } } }).reader?.tools.specs.map((spec) => spec.name)).toEqual(["site_read"]);
  after!({ ...done("t", root), summary: { needsHuman: [{ what: "需要登录：小红书", why: "打开收藏页跳到了登录页" }] } } as unknown as AgentOutcome);
  expect(said().at(-1)).toContain("这次没读到：需要登录：小红书");
});

test("a scheduled workflow logged in on another machine is left to that machine: the synced ledger has the login, this one has no profile", () => {
  store.setSetting(ws, "skills.grown", JSON.stringify([{ id: "flow-xhs", kind: "grown", name: "xhs", description: "d", lines: ["media"], category: "files_calendar_prep",
    manifest: favourites, origin: { kind: "asked", text: "t", requestId: "r" }, taskId: "", files: [],
    scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: [], final: "usable" }, status: "active", pinned: false,
    logins: { 小红书: "2026-10-14T22:55:00Z" }, createdAt: "", updatedAt: "", lastUsedAt: "" }]));
  const sunday = new Date("2026-10-19T01:10:00Z"), runs: unknown[] = [];
  const run = (input: unknown) => { runs.push(input); return { state: "started" as const, taskId: "t" }; };
  // The hosted copy: no profile for the site, so it neither runs, reminds nor marks the week as run.
  expect(workflowSchedulePass(store, ws, run, sunday, path.join(root, "elsewhere"))).toEqual([]);
  expect(runs).toEqual([]);
  expect(readGrownSkills(store, ws)[0]!.lastRunAt).toBeUndefined();
  // The machine the person logged in on runs it.
  mkdirSync(path.join(root, "here", "xiaohongshu.com"), { recursive: true });
  expect(workflowSchedulePass(store, ws, run, sunday, path.join(root, "here"))).toEqual(["flow-xhs"]);
  expect(runs.length).toBe(1);
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
    // A grown workflow's own run switches no other one on either (2026-10-16: 科研笔记候选包.md among the favourites run's results).
    const ownRun = librarySelection({ extraSkills: ["crossline-grown:flow-xhs-favorites-digest"] });
    expect(ownRun).toEqual({ wantIfMissing: true, grown: false });
    expect(await librarySkillsFor(run.rpc, store, ws, "media", { cwd: "C:\repo", dir, task: "为小红书整理公开来源", ...ownRun })).toEqual([]);
    expect(librarySelection({ growing: true, extraSkills: [SKILL_CREATOR] })).toEqual({ wantIfMissing: false, grown: false });
    expect(librarySelection({ extraSkills: [] })).toEqual({ wantIfMissing: true });
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
    store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `req-${taskId}`, type: "agent.task.requested", entityId: taskId,
      payload: { taskId, title: "把这类事固化成工作流：定期整理小红书收藏夹", category: "files_calendar_prep", workOrderId: "" } });
    store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `att-${taskId}`, type: "skill.grown.attempted", entityId: "media", payload: { taskId, state: "started", requestId: id } });
    if (lost) store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `lost-${taskId}`, type: "agent.task.blocked", entityId: taskId, payload: { taskId, code: "AGENT_RUN_LOST" } });
  };
  attempt("g1", true);
  // Not at once: the next run waits out its backoff (five minutes after the first interruption).
  expect(growCandidates(store, ws)).toEqual([]);
  const later = new Date(Date.now() + 6 * 60_000);
  const [again] = growCandidates(store, ws, later);
  expect(again).toMatchObject({ origin: { kind: "asked" }, retry: { text: expect.stringContaining("后台进程重启") } });
  attempt("g2", true);
  attempt("g3", true);
  expect(growCandidates(store, ws, new Date(Date.now() + 3_600_000))).toEqual([]);
  const other = requestWorkflow(store, ws, "每周剪 vlog", "media", owner());
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: "att-g4", type: "skill.grown.attempted", entityId: "media", payload: { taskId: "g4", state: "started", requestId: other } });
  expect(growCandidates(store, ws, new Date(Date.now() + 3_600_000))).toEqual([]);
});

test("「我已登录」 closes a login window the browser kept running in the background and records the login with that browser", () => {
  store.setSetting(ws, "skills.grown", JSON.stringify([{ id: "flow-xhs", kind: "grown", name: "xhs", description: "d", lines: ["media"], category: "files_calendar_prep",
    manifest: favourites, origin: { kind: "asked", text: "t", requestId: "r" }, taskId: "", files: [], scan: { risk: "low", injection: false, findings: [] },
    review: { verdict: "usable", reasons: [], final: "usable" }, status: "active", pinned: false, createdAt: "", updatedAt: "", lastUsedAt: "" }]));
  let closed = 0;
  openWorkflowLogin(store, ws, "flow-xhs", "小红书", path.join(root, "p"), { browser: "chromium.exe", launch: () => ({ close: () => { closed += 1; } }) });
  expect(finishWorkflowLogin(store, ws, "flow-xhs", "小红书")).toEqual({ ok: true });
  expect(closed).toBe(1);
  expect(readGrownSkills(store, ws)[0]).toMatchObject({ loginBrowsers: { 小红书: "chromium.exe" } });
  // The window is no longer in the way of a run.
  expect(startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, (input) => ({ state: "started", taskId: input.taskId }), path.join(root, "p")).state).toBe("started");
  expect(finishWorkflowLogin(store, ws, "flow-xhs", "微博")).toMatchObject({ ok: false });
});

test("with no screen of its own the login is the server's browser in a dialog: a run waits for it, and 「登录完成」 records it", async () => {
  vi.stubEnv("CROSSLINE_LOGIN_MODE", "remote");
  try {
    favouritesRecord({ loginBrowsers: { 小红书: "C:\\Program Files\\chrome.exe" } });
    const profiles = path.join(root, "p");
    const opened: string[] = [];
    const remote = createRemoteBrowsers({ resolve: (workspaceId, id, service) => workflowLoginTarget(store, workspaceId, id, service, profiles),
      onLoggedIn: (workspaceId, id, service) => recordGrownLogin(store, workspaceId, id, service, new Date(), ""),
      open: async ({ profileDir }) => { opened.push(profileDir); return { start: async () => {}, goto: async () => {}, mouse: async () => {}, wheel: async () => {}, text: async () => {},
        key: async () => {}, back: async () => {}, reload: async () => {}, url: () => "https://www.xiaohongshu.com/", title: async () => "", sessionCookies: async () => [], close: async () => {} }; },
      memory: () => undefined, isPublicHost: async () => true });
    configureRemoteLogin(remote);
    let launched = false;
    expect(await openWorkflowLogin(store, ws, "flow-xhs", "小红书", profiles, { browser: "x", launch: () => { launched = true; return { close: () => {} }; } }, { width: 390, height: 700 }))
      .toEqual({ ok: true, remote: true });
    expect(launched).toBe(false);
    expect(opened).toEqual([path.join(profiles, "xiaohongshu.com")]);
    const run = (input: AgentTaskInput & { taskId: string }) => ({ state: "started" as const, taskId: input.taskId });
    expect(startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, run, profiles)).toMatchObject({ state: "blocked", code: "LOGIN_WINDOW_OPEN" });
    expect(await finishWorkflowLogin(store, ws, "flow-xhs", "小红书")).toEqual({ ok: true });
    expect(readGrownSkills(store, ws)[0]!.logins?.["小红书"]).toBeTruthy();
    // On the server the run reads with the server's own browser, never a path recorded on the person's computer.
    const inputs: Array<AgentTaskInput & { taskId: string }> = [];
    let profileBrowser = "";
    expect(startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, (input) => { inputs.push(input); return run(input); }, profiles, new Date(), "",
      async (_dir, browser) => { profileBrowser = browser; return { read: async (url) => ({ url, title: "", text: "", status: 200, links: [] }), close: async () => {} }; }).state).toBe("started");
    await (inputs[0] as unknown as { reader: SiteReader }).reader.tools.call("site_read", { service: "小红书", url: "https://www.xiaohongshu.com/explore" });
    expect(profileBrowser).toBe("");
  } finally { configureRemoteLogin(undefined); vi.unstubAllEnvs(); }
});

test("a run reading an account opens each page once and stops at a security check; stopped there, the person is told not to run it again soon", () => {
  store.setSetting(ws, "skills.grown", JSON.stringify([{ id: "flow-xhs", kind: "grown", name: "xhs", description: "d", lines: ["media"], category: "files_calendar_prep",
    manifest: favourites, origin: { kind: "asked", text: "t", requestId: "r" }, taskId: "", files: [], scan: { risk: "low", injection: false, findings: [] },
    review: { verdict: "usable", reasons: [], final: "usable" }, status: "active", pinned: false, createdAt: "", updatedAt: "", lastUsedAt: "" }]));
  let what = "";
  let after: ((outcome: AgentOutcome) => void) | undefined;
  startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, (input, then) => { what = input.what; after = then; return { state: "started", taskId: input.taskId }; }, path.join(root, "p"), new Date(), "chrome.exe");
  expect(what).toContain("每个页面只读一次");
  expect(what).toContain("不换方式、不尝试绕过");
  after!({ ...done("t", root), summary: { needsHuman: [{ what: "需要本人完成小红书安全验证", why: "详情页出现滑块" }] } } as unknown as AgentOutcome);
  expect(said().at(-1)).toContain("遇到了网站的安全验证，已停下，不会重试");
});

const favouritesRecord = (extra: Record<string, unknown> = {}) => store.setSetting(ws, "skills.grown", JSON.stringify([{ id: "flow-xhs", kind: "grown", name: "xhs",
  description: "d", lines: ["media"], category: "files_calendar_prep", manifest: favourites, origin: { kind: "asked", text: "t", requestId: "r" }, taskId: "", files: [],
  scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: [], final: "usable" }, status: "active", pinned: false,
  createdAt: "", updatedAt: "", lastUsedAt: "", ...extra }]));

test("a run whose pages listed nothing is partial and points at the login; one that read items hands its folder and pages to the next, which adds only what is new", async () => {
  favouritesRecord();
  const note = (index: number) => ({ text: `笔记 ${index}`, href: `https://www.xiaohongshu.com/user/profile/me/6512abcd00000000000000${String(index).padStart(2, "0")}` });
  let listed = [note(1), note(2)];
  // A stand-in browser: the favourites tab lists `listed`, or says it is empty (10-16).
  const openSite: OpenSite = async () => ({ close: async () => {},
    read: async (url, _scrolls, click) => ({ url, title: "我的", status: 200, links: listed, ...(click ? { click: { label: click, done: true } } : {}),
      text: listed.length ? listed.map((item) => item.text).join("\n") : "你还没有收藏任何内容哦" }) });
  const runs: Array<AgentTaskInput & { taskId: string }> = [];
  let after: ((outcome: AgentOutcome) => void) | undefined;
  const run = (input: AgentTaskInput & { taskId: string }, then?: (outcome: AgentOutcome) => void) => { runs.push(input); after = then; return { state: "started" as const, taskId: input.taskId }; };
  const readFavourites = async (index: number) => JSON.parse(await (runs[index] as unknown as { reader: SiteReader }).reader.tools.call("site_read",
    { service: "小红书", url: "https://www.xiaohongshu.com/user/profile/me", click: "收藏", scrolls: 15 })) as { ok: boolean; items: number };

  startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, run, path.join(root, "p"), new Date(), "chrome.exe", openSite);
  expect(runs[0]!.what).toContain("用 site_read 的 click 传标签文字切换过去");
  expect(await readFavourites(0)).toMatchObject({ ok: true, items: 2 });
  const first = path.join(root, "flow-1");
  mkdirSync(first);
  after!({ ...done("flow-1", first), summary: { needsHuman: [] } } as unknown as AgentOutcome);
  expect(said().at(-1)).toContain("本期「每周日整理小红书收藏夹，按主题归类并列出可删的重复项」已做好");
  expect(readGrownSkills(store, ws)[0]!.lastRead).toMatchObject({ taskId: "flow-1", directory: first, items: 2,
    pages: [{ url: "https://www.xiaohongshu.com/user/profile/me", click: "收藏" }] });

  // The next run gets the last output read-only and the page that worked; this time the page shows nothing.
  listed = [];
  startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, run, path.join(root, "p"), new Date(), "chrome.exe", openSite);
  expect(runs[1]!.inputs).toEqual([first]);
  expect(runs[1]!.what).toContain("上期读到内容的页面：https://www.xiaohongshu.com/user/profile/me（点「收藏」）");
  expect(runs[1]!.what).toContain("本期只整理上期之后新增的，按条目链接去重");
  expect(await readFavourites(1)).toMatchObject({ ok: true, items: 0 });
  after!({ ...done("flow-2", root), summary: { needsHuman: [] } } as unknown as AgentOutcome);
  expect(said().at(-1)).toBe("本期「每周日整理小红书收藏夹，按主题归类并列出可删的重复项」只做了一部分：这次没读到收藏（上期读到 2 条），可能需要重新登录或页面改版。请在设置里点「登录」重新登录，点「登录完成」后再点「立即运行」。");
  const card = store.listRecentNudges(ws, "2000-01-01T00:00:00Z").at(-1)!.payload.card as { clarify: { options: Array<{ label: string; href?: string }> } };
  // 「去登录」 opens the login of this workflow at once (a dialog on the hosted beta).
  expect(card.clarify.options).toContainEqual(expect.objectContaining({ label: "去登录", href: "/settings?login=flow-xhs#skills" }));
  // The baseline stays the last run that read something.
  expect(readGrownSkills(store, ws)[0]!.lastRead).toMatchObject({ taskId: "flow-1", items: 2 });
  expect(store.listEvents(ws, { type: "skill.grown.result" }).map((event) => (event.payload as { outcome: string }).outcome)).toEqual(["done", "partial"]);
});

test("a scheduled run that finds the assistant busy is not marked as run: later ticks that day try again, past the usual three hours", () => {
  favouritesRecord();
  const sunday = new Date("2026-10-19T01:10:00Z"); // 20:10 on Sunday in Chicago
  expect(workflowSchedulePass(store, ws, () => ({ state: "blocked", code: "AGENT_BUSY", message: "助手正在做别的事。" }), sunday)).toEqual([]);
  expect(readGrownSkills(store, ws)[0]).toMatchObject({ heldSince: sunday.toISOString() });
  expect(readGrownSkills(store, ws)[0]!.lastRunAt).toBeUndefined();
  expect(said()).toEqual([]);
  const runs: unknown[] = [];
  const late = new Date("2026-10-19T04:40:00Z"); // 23:40, three and a half hours after its time
  expect(workflowSchedulePass(store, ws, (input) => { runs.push(input); return { state: "started", taskId: input.taskId }; }, late)).toEqual(["flow-xhs"]);
  expect(runs).toHaveLength(1);
  expect(readGrownSkills(store, ws)[0]).toMatchObject({ lastRunAt: late.toISOString() });
  expect(readGrownSkills(store, ws)[0]!.heldSince).toBeUndefined();
  // Without a hold, that late is too late.
  favouritesRecord();
  expect(workflowSchedulePass(store, ws, () => ({ state: "started", taskId: "t" }), late)).toEqual([]);
});

test("a run stopped part way offers what it had made for review, unchecked; its helper scripts and a run that made nothing are left out", async () => {
  const { salvageStoppedRun } = await import("./agent-task");
  const { listAgentTasks } = await import("@crossline/db");
  const out = path.join(root, "out");
  const request = (taskId: string) => store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `rq-${taskId}`, type: "agent.task.requested", entityId: taskId,
    payload: { taskId, title: "整理小红书收藏夹", category: "read_research_organize", workOrderId: "" } });
  const stop = (taskId: string, code: string) => store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: `st-${taskId}`, type: "agent.task.blocked", entityId: taskId,
    payload: { taskId, code, message: "本人中止了这次运行。" } });
  request("t1"); stop("t1", "AGENT_CANCELLED");
  mkdirSync(path.join(out, "t1", "__pycache__"), { recursive: true });
  writeFileSync(path.join(out, "t1", "media_action_plan.md"), "# 本期创作者行动报告");
  writeFileSync(path.join(out, "t1", "read_xhs.py"), "print(1)");
  writeFileSync(path.join(out, "t1", "__pycache__", "x.pyc"), "x");
  expect(salvageStoppedRun(store, ws, "t1", out)).toBe(true);
  expect(listAgentTasks(store, ws).find((task) => task.taskId === "t1")).toMatchObject({ status: "needs_review", checksPassed: false, artifacts: [{ path: "media_action_plan.md" }] });
  expect(JSON.parse(readFileSync(path.join(out, "t1", "audit.json"), "utf8")).summary).toContain("没有做完");
  expect(salvageStoppedRun(store, ws, "t1", out)).toBe(false);
  request("t2"); stop("t2", "AGENT_CANCELLED");
  expect(salvageStoppedRun(store, ws, "t2", out)).toBe(false);
  request("t3"); stop("t3", "AGENT_CATEGORY_NOT_APPROVED");
  mkdirSync(path.join(out, "t3"), { recursive: true }); writeFileSync(path.join(out, "t3", "a.md"), "x");
  expect(salvageStoppedRun(store, ws, "t3", out)).toBe(false);
});

test("a stopped growing run is not offered for review, and one offered before is not listed", async () => {
  const { salvageStoppedRun } = await import("./agent-task");
  const { listAgentTasks } = await import("@crossline/db");
  const out = path.join(root, "out-grow");
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: "rq-g", type: "agent.task.requested", entityId: "grow-1", payload: { taskId: "grow-1", title: "把这类事固化成工作流", category: "read_research_organize" } });
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: "st-g", type: "agent.task.blocked", entityId: "grow-1", payload: { taskId: "grow-1", code: "AGENT_RUN_LOST" } });
  mkdirSync(path.join(out, "grow-1"), { recursive: true }); writeFileSync(path.join(out, "grow-1", "SKILL.md"), "x");
  expect(salvageStoppedRun(store, ws, "grow-1", out)).toBe(false);
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: "old-salvage", type: "agent.task.completed", entityId: "grow-1", payload: { taskId: "grow-1", partial: true, reviewRequired: true } });
  expect(listAgentTasks(store, ws).find((task) => task.taskId === "grow-1")?.status).toBe("blocked");
});

test("a skill naming another library skill of its line switches that one on too, one level deep; another line's is not", async () => {
  const { referencedSkills } = await import("./skill-library");
  store.setSetting(ws, "skills.library", JSON.stringify([
    { id: "pub-hooks", kind: "public", name: "hooks", description: "开头", category: "writing", lines: ["media"], review: { final: "usable" } },
    { id: "pub-papers", kind: "public", name: "papers", description: "文献", category: "research", lines: ["research"], review: { final: "usable" } }]));
  const flow = { id: "flow-xhs-note", kind: "grown", name: "xhs-note", description: "d", lines: ["media"], category: "media_edit",
    manifest: { ...workflowJson, access: [], risks: [] }, origin: { kind: "asked", text: "t", requestId: "r-ref" }, taskId: "", files: [],
    scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: [], final: "usable" }, status: "active", pinned: false, createdAt: "", updatedAt: "", lastUsedAt: "" };
  store.setSetting(ws, "skills.grown", JSON.stringify([flow]));
  store.setSetting(ws, "skills.grown.files.flow-xhs-note", JSON.stringify({ files: [{ path: "SKILL.md", text: "开头按 $crossline-public:pub-hooks 写；文献用 $crossline-public:pub-papers。" }] }));
  store.appendEvent({ ownerId: owner(), workspaceId: ws, idempotencyKey: "req-ref", type: "workflow.requested", entityId: "r-ref", payload: { text: "t", lineId: "media" } });
  const available = ["crossline-grown:flow-xhs-note", "crossline-public:pub-hooks", "crossline-public:pub-papers"];
  expect(referencedSkills(store, ws, "media", ["crossline-grown:flow-xhs-note"], available)).toEqual(["crossline-public:pub-hooks"]);
  expect(referencedSkills(store, ws, "media", ["crossline-grown:flow-xhs-note"], ["crossline-grown:flow-xhs-note"])).toEqual([]);
});

test("a favourites workflow is read whole by the worker's job first; the assistant only organises the note files, and they leave the to-organise list once it is done", async () => {
  favouritesRecord();
  const id = (n: number) => `66aa${String(n).padStart(20, "0")}`;
  let queue: Array<{ url: string; status: number; json: unknown }> = [];
  let current = "";
  const driver: CollectDriver = {
    goto: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/explore") queue.push({ url: "https://edith.xiaohongshu.com/api/sns/web/v2/user/me", status: 200, json: { code: 0, data: { user_id: "me" } } });
      else if (parsed.pathname.startsWith("/user/profile/")) queue.push({ url: "https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page", status: 200,
        json: { code: 0, data: { has_more: false, notes: [1, 2].map((n) => ({ note_id: id(n), xsec_token: "t", display_title: `收藏 ${n}`, type: "normal" })) } } });
      else { current = parsed.pathname.split("/").pop()!; queue.push({ url: "https://edith.xiaohongshu.com/api/sns/web/v1/feed", status: 200,
        json: { code: 0, data: { items: [{ id: current, note_card: { note_id: current, type: "normal", title: `收藏 ${current.slice(-1)}`, desc: "正文", image_list: [] } }] } } }); }
      return 200;
    },
    pause: async () => {}, wheel: async () => {}, snapshot: async () => ({ url: "https://www.xiaohongshu.com/x", title: "", text: "", links: [] }),
    responses: async () => { const out = queue; queue = []; return out; }, noteState: async () => null, selfProfile: async () => ({}),
    fetchMedia: async () => ({ state: "failed", status: 404 }), close: async () => {}
  };
  configureFavouritesCollector({ outputRoot: root, open: async () => driver, media: () => ({}), sleep: async () => {} });
  try {
    const runs: Array<AgentTaskInput & { taskId: string; reader?: unknown }> = [];
    let after: ((outcome: AgentOutcome) => void) | undefined;
    const run = (input: AgentTaskInput & { taskId: string }, then?: (outcome: AgentOutcome) => void) => { runs.push(input); after = then; return { state: "started" as const, taskId: input.taskId }; };
    const started = startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, run, path.join(root, "p"), new Date(), "chrome.exe");
    expect(started).toMatchObject({ state: "started", taskId: expect.stringMatching(/^collect-xhs-/) });
    // A second start while it reads waits (a hold code), instead of opening the browser twice.
    expect(startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, run, path.join(root, "p"), new Date(), "chrome.exe")).toMatchObject({ state: "blocked", code: "COLLECTING" });
    await collectionDone(ws, "flow-xhs");
    const folder = path.join(root, "collect-xhs");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.reader).toBeUndefined();
    expect(runs[0]!.inputs).toEqual([folder]);
    expect(runs[0]!.what).toContain("不要再访问小红书");
    expect(runs[0]!.what).toContain(`note-${id(2)}.md`);
    expect(readFileSync(path.join(folder, `note-${id(1)}.md`), "utf8")).toContain("# 收藏 1");
    expect(readFileSync(path.join(folder, "index.md"), "utf8")).toContain("共 2 条");
    expect(readCollectLedger(store, ws, "flow-xhs").unorganised).toHaveLength(2);
    after!({ ...done("flow-1", path.join(root, "flow-1")), summary: { needsHuman: [] } } as unknown as AgentOutcome);
    expect(readCollectLedger(store, ws, "flow-xhs").unorganised).toEqual([]);
    expect(said().at(-1)).toContain("新读 2 条（共 2 条）");
    expect(readGrownSkills(store, ws)[0]!.lastRead).toMatchObject({ taskId: "flow-1", items: 2 });

    // Nothing new next time: no assistant run, one line to the person.
    startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, run, path.join(root, "p"), new Date(), "chrome.exe");
    await collectionDone(ws, "flow-xhs");
    expect(runs).toHaveLength(1);
    expect(said().at(-1)).toContain("本期没有新增收藏（已读 2 条）");
  } finally { configureFavouritesCollector(undefined); }
});

test("with no room for the browser the collection opens nothing, holds nothing, says so once and leaves the next run to try", async () => {
  favouritesRecord();
  let opened = 0;
  let released = 0;
  const memory = { admit: async () => false, release: () => { released += 1; }, over: () => false, mediaBytes: (wanted: number) => wanted, describe: () => "1100 / 1350 MB" };
  configureFavouritesCollector({ outputRoot: root, open: async () => { opened += 1; throw new Error("not opened"); }, media: () => ({}), sleep: async () => {}, memory });
  try {
    const run = (input: AgentTaskInput & { taskId: string }) => ({ state: "started" as const, taskId: input.taskId });
    expect(startWorkflowRun(store, ws, readGrownSkills(store, ws)[0]!, run, path.join(root, "p"), new Date(), "chrome.exe")).toMatchObject({ state: "started" });
    await collectionDone(ws, "flow-xhs");
    expect(opened).toBe(0);
    expect(released).toBeGreaterThan(0);
    expect(store.listEvents(ws, { type: "collect.ran" }).at(-1)!.payload).toMatchObject({ state: "memory" });
    expect(siteHold(store, ws, "xiaohongshu.com")).toBeUndefined();
    expect(said().at(-1)).toContain("服务器内存不够打开浏览器（1100 / 1350 MB）");
  } finally { configureFavouritesCollector(undefined); }
});

test("favourites by topic: what was listed before a check is sorted while the site is held, and nothing opens the site", async () => {
  const record = installFavouritesTopicsWorkflow(store, ws, "media", new Date("2026-10-22T11:00:00Z"));
  consentToGrownSkill(store, ws, record.id);
  writeCollectLedger(store, ws, record.id, { read: {}, unorganised: [], listed: { a1: { title: "爆款开头", xsecToken: "t", type: "normal" }, a2: { title: "手冲咖啡", xsecToken: "t", type: "normal" } } });
  holdAfterFailure(store, ws, "HTTP 461");
  let opened = 0, sorted = 0;
  configureFavouritesCollector({ outputRoot: root, open: async () => { opened += 1; throw new Error("no"); }, media: () => ({}), sleep: async () => {}, classify: async () => { sorted += 1; return 0; } });
  try {
    const run = (input: AgentTaskInput & { taskId: string }) => ({ state: "started" as const, taskId: input.taskId });
    const step = favouritesTopicStep(store, ws, readGrownSkills(store, ws)[0]!, run, path.join(root, "p"), new Date("2026-10-23T12:00:00Z"));
    expect(step).toMatchObject({ state: "blocked", code: "TOPICS_SORTING", message: expect.stringContaining("2 条") });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sorted).toBe(1);
    expect(opened).toBe(0);
  } finally { configureFavouritesCollector(undefined); }
});

test("favourites by topic: the list read for its titles, sorted into topics, the day's share of one topic by day and everything in order by night", async () => {
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "UTC" }));
  const record = installFavouritesTopicsWorkflow(store, ws, "media", new Date("2026-10-22T11:00:00Z"));
  expect(record).toMatchObject({ status: "needs_consent", name: "xiaohongshu-favourites-topics" });
  expect(installFavouritesTopicsWorkflow(store, ws, "media").id).toBe(record.id);
  consentToGrownSkill(store, ws, record.id);
  const id = (n: number) => `66bb${String(n).padStart(20, "0")}`;
  const titles = ["爆款开头一", "爆款开头二", "爆款开头三", "手冲咖啡", "今天"];
  let queue: Array<{ url: string; status: number; json: unknown }> = [];
  const opened: string[] = [];
  const driver: CollectDriver = {
    goto: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/explore") queue.push({ url: "https://edith.xiaohongshu.com/api/sns/web/v2/user/me", status: 200, json: { code: 0, data: { user_id: "me" } } });
      else if (parsed.pathname.startsWith("/user/profile/")) queue.push({ url: "https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page", status: 200,
        json: { code: 0, data: { has_more: false, notes: titles.map((title, i) => ({ note_id: id(i + 1), xsec_token: `t${i + 1}`, display_title: title, type: "normal" })) } } });
      else { const current = parsed.pathname.split("/").pop()!; opened.push(current); queue.push({ url: "https://edith.xiaohongshu.com/api/sns/web/v1/feed", status: 200,
        json: { code: 0, data: { items: [{ id: current, note_card: { note_id: current, type: "normal", title: "x", desc: "正文", image_list: [] } }] } } }); }
      return 200;
    },
    pause: async () => {}, wheel: async () => {}, snapshot: async () => ({ url: "https://www.xiaohongshu.com/x", title: "", text: "", links: [] }),
    responses: async () => { const out = queue; queue = []; return out; }, noteState: async () => null, selfProfile: async () => ({}),
    fetchMedia: async () => ({ state: "failed", status: 404 }), close: async () => {}
  };
  configureFavouritesCollector({ outputRoot: root, open: async () => driver, media: () => ({}), sleep: async () => {}, classify: async () => 0 });
  try {
    const runs: Array<AgentTaskInput & { taskId: string }> = [];
    const run = (input: AgentTaskInput & { taskId: string }) => { runs.push(input); return { state: "started" as const, taskId: input.taskId }; };
    const profiles = path.join(root, "p");
    const day = new Date("2026-10-22T12:00:00Z");
    // 「立即运行」 first reads the list for its titles and opens no note.
    expect(favouritesTopicStep(store, ws, readGrownSkills(store, ws)[0]!, run, profiles, day, { manual: true })).toMatchObject({ state: "started" });
    await collectionDone(ws, record.id);
    expect(opened).toEqual([]);
    expect(Object.values(readCollectLedger(store, ws, record.id).listed ?? {}).map((note) => note.title)).toEqual(titles);
    // Unsorted titles: the sorting runs, the reading waits.
    expect(favouritesTopicStep(store, ws, readGrownSkills(store, ws)[0]!, run, profiles, day)).toMatchObject({ state: "blocked", code: "TOPICS_SORTING" });
    const { rpc } = scriptedRuntime(["crossline:crossline-favourite-topics"], () => JSON.stringify({ topics: [{ name: "小红书开头", why: "开头写法", notes: [1, 2, 3] },
      { name: "咖啡", why: "", notes: [4] }] }));
    expect(await createTopicClassifier(store, ".", () => rpc)(ws, record.id)).toBe(5);
    const plan = readTopicPlan(store, ws, record.id)!;
    // The title the model left out goes under 「其他」, read last.
    expect(plan.order.map((topicId) => plan.topics.find((topic) => topic.id === topicId)!.name)).toEqual(["小红书开头", "咖啡", "其他"]);
    writeTopicPlan(store, ws, record.id, { ...plan, perDay: 2 });
    // By day: two notes of the first topic, then the day's share is used.
    expect(favouritesTopicStep(store, ws, readGrownSkills(store, ws)[0]!, run, profiles, day)).toMatchObject({ state: "started" });
    await collectionDone(ws, record.id);
    expect(opened).toEqual([id(1), id(2)]);
    expect(runs.at(-1)!.what).toContain("「小红书开头」");
    expect(runs.at(-1)!.what).toContain("话题共 3 条，已读 2 条");
    expect(readTopicPlan(store, ws, record.id)!.days["2026-10-22"]).toMatchObject({ read: [id(1), id(2)] });
    expect(favouritesTopicStep(store, ws, readGrownSkills(store, ws)[0]!, run, profiles, new Date("2026-10-22T15:00:00Z"))).toMatchObject({ state: "blocked", code: "TOPICS_DONE_FOR_NOW" });
    // By night (02–08 in the person's zone): everything left, topic after topic, with no count.
    expect(favouritesTopicStep(store, ws, readGrownSkills(store, ws)[0]!, run, profiles, new Date("2026-10-23T03:00:00Z"))).toMatchObject({ state: "started" });
    await collectionDone(ws, record.id);
    expect(opened).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    // The day's organising run has not ended: the night's run gets only the notes it does not already have.
    expect(runs.at(-1)!.what).not.toContain(`note-${id(1)}.md`);
    expect(runs.at(-1)!.what).toContain(`note-${id(3)}.md`);
    // A run that broke holds the site: the tick starts nothing, however late, until the person presses 「立即运行」.
    holdAfterFailure(store, ws, "Target crashed");
    // A month on, by night: the list is due again, so only the hold stops it (a wall-clock date made this pass only between 02 and 08 UTC).
    const soon = new Date("2026-11-22T03:00:00Z");
    expect(favouritesTopicStep(store, ws, readGrownSkills(store, ws)[0]!, run, profiles, soon)).toMatchObject({ state: "blocked", code: "SITE_PAUSED" });
    expect(resumeByPerson(store, ws, readGrownSkills(store, ws)[0]!)).toEqual(["xiaohongshu.com"]);
    expect(favouritesTopicStep(store, ws, readGrownSkills(store, ws)[0]!, run, profiles, soon, { manual: true })).not.toMatchObject({ code: "SITE_PAUSED" });
    await collectionDone(ws, record.id);
    // A collection a restart cut off is closed at the next start, without holding the next run.
    store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "started-x", type: "collect.started", entityId: record.id, payload: { taskId: "collect-x" } });
    expect(closeInterruptedCollections(store, ws)).toEqual(["collect-x"]);
    expect(closeInterruptedCollections(store, ws)).toEqual([]);
    expect(favouritesTopicStep(store, ws, readGrownSkills(store, ws)[0]!, run, profiles, soon)).not.toMatchObject({ code: "SITE_PAUSED" });
  } finally { configureFavouritesCollector(undefined); }
});
